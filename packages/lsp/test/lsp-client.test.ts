import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  createFrameParser,
  createLspClient,
  fileUri,
  toLspPosition,
  type LspClient,
} from "../lib/lsp-client.ts";

/**
 * Helper: create a mock stdio pair (stdin writeable, stdout readable)
 * that simulates a language server's stdio transport.
 */
function createMockStdio() {
  const serverIn = new PassThrough();   // we write to this (client → server)
  const serverOut = new PassThrough();  // we read from this (server → client)
  return { serverIn, serverOut };
}

/** Encode a JSON-RPC message into Content-Length framed bytes. */
function encodeFrame(body: unknown): Buffer {
  const json = JSON.stringify(body);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  return Buffer.from(header + json);
}

// --- Frame parser tests ---

test("Content-Length framed parsing extracts a single message", () => {
  const parser = createFrameParser();
  const body = { jsonrpc: "2.0", id: 1, result: { capabilities: {} } };
  const frame = encodeFrame(body);

  const messages: unknown[] = [];
  parser.onMessage((msg) => messages.push(msg));
  parser.feed(frame);

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], body);
});

test("parser handles chunked frames (split across multiple feeds)", () => {
  const parser = createFrameParser();
  const body = { jsonrpc: "2.0", id: 2, result: "hello" };
  const frame = encodeFrame(body);

  const messages: unknown[] = [];
  parser.onMessage((msg) => messages.push(msg));

  // Feed the frame in small chunks
  const mid = Math.floor(frame.length / 2);
  parser.feed(frame.subarray(0, mid));
  assert.equal(messages.length, 0, "should not emit before full message");
  parser.feed(frame.subarray(mid));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], body);
});

test("parser handles sticky frames (multiple messages in one buffer)", () => {
  const parser = createFrameParser();
  const body1 = { jsonrpc: "2.0", id: 1, result: "a" };
  const body2 = { jsonrpc: "2.0", id: 2, result: "b" };
  const combined = Buffer.concat([encodeFrame(body1), encodeFrame(body2)]);

  const messages: unknown[] = [];
  parser.onMessage((msg) => messages.push(msg));
  parser.feed(combined);

  assert.equal(messages.length, 2);
  assert.deepEqual(messages[0], body1);
  assert.deepEqual(messages[1], body2);
});

test("parser rejects malformed frame without crashing", () => {
  const parser = createFrameParser();
  const messages: unknown[] = [];
  parser.onMessage((msg) => messages.push(msg));

  // Feed invalid data that starts with Content-Length but has bad JSON
  const badFrame = Buffer.from('Content-Length: 5\r\n\r\n{bad}');
  // Should not crash; message may or may not be emitted depending on parser robustness
  assert.doesNotThrow(() => parser.feed(badFrame));
});

// --- Request/response correlation ---

test("request/response correlation by id", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  // Start a request
  const requestPromise = client.request("textDocument/hover", { textDocument: { uri: "file:///test.ts" } });

  // Read the request from serverIn
  const requestData = await new Promise<string>((resolve) => {
    let buf = "";
    serverIn.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      // Check if we have a complete message
      const match = buf.match(/Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const headerEnd = buf.indexOf("\r\n\r\n") + 4;
        if (buf.length >= headerEnd + len) {
          resolve(buf.substring(headerEnd, headerEnd + len));
        }
      }
    });
  });

  const requestMsg = JSON.parse(requestData);
  assert.equal(requestMsg.method, "textDocument/hover");

  // Send response with matching id
  const response = { jsonrpc: "2.0", id: requestMsg.id, result: { contents: "hover info" } };
  serverOut.write(encodeFrame(response));

  const result = await requestPromise;
  assert.deepEqual(result, { contents: "hover info" });

  client.destroy();
});

test("notification dispatch (publishDiagnostics)", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  const diagnosticsReceived: Array<{ uri: string; diagnostics: unknown[] }> = [];
  client.onDiagnostics((uri, diagnostics) => {
    diagnosticsReceived.push({ uri, diagnostics });
  });

  // Server sends a notification
  const notification = {
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: "file:///test.ts",
      diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, message: "error" }],
    },
  };
  serverOut.write(encodeFrame(notification));

  // Wait a tick for the notification to be processed
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(diagnosticsReceived.length, 1);
  assert.equal(diagnosticsReceived[0]!.uri, "file:///test.ts");
  assert.equal(diagnosticsReceived[0]!.diagnostics.length, 1);

  client.destroy();
});

test("request timeout rejection with deterministic error", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  // Read and discard the request from serverIn so it doesn't back up
  serverIn.on("data", () => {});

  // Request with very short timeout — no response will come
  await assert.rejects(
    () => client.request("textDocument/hover", {}, 50),
    (err: Error) => {
      assert.ok(err.message.includes("timeout") || err.message.includes("Timeout"),
        `Expected timeout error, got: ${err.message}`);
      return true;
    },
  );

  client.destroy();
});

test("textDocument/didOpen emits correct JSON-RPC notification", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  const received = new Promise<string>((resolve) => {
    let buf = "";
    serverIn.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const headerEnd = buf.indexOf("\r\n\r\n") + 4;
        if (buf.length >= headerEnd + len) {
          resolve(buf.substring(headerEnd, headerEnd + len));
        }
      }
    });
  });

  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: "file:///test.ts",
      languageId: "typescript",
      version: 1,
      text: "const x = 1;",
    },
  });

  const msg = JSON.parse(await received);
  assert.equal(msg.method, "textDocument/didOpen");
  assert.equal(msg.params.textDocument.uri, "file:///test.ts");
  assert.equal(msg.id, undefined, "notifications should not have an id");

  client.destroy();
});

test("textDocument/didChange emits correct JSON-RPC notification", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  const received = new Promise<string>((resolve) => {
    let buf = "";
    serverIn.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/Content-Length: (\d+)\r\n\r\n/);
      if (match) {
        const len = parseInt(match[1]!, 10);
        const headerEnd = buf.indexOf("\r\n\r\n") + 4;
        if (buf.length >= headerEnd + len) {
          resolve(buf.substring(headerEnd, headerEnd + len));
        }
      }
    });
  });

  client.notify("textDocument/didChange", {
    textDocument: { uri: "file:///test.ts", version: 2 },
    contentChanges: [{ text: "const x = 2;" }],
  });

  const msg = JSON.parse(await received);
  assert.equal(msg.method, "textDocument/didChange");
  assert.equal(msg.params.textDocument.version, 2);

  client.destroy();
});

// --- Utility function tests ---

test("1-index to 0-index position conversion helper", () => {
  // User-facing positions are 1-based, LSP is 0-based
  const pos = toLspPosition(10, 5);
  assert.equal(pos.line, 9);
  assert.equal(pos.character, 4);
});

test("1-index to 0-index clamps to zero for invalid inputs", () => {
  const pos = toLspPosition(0, 0);
  assert.equal(pos.line, 0);
  assert.equal(pos.character, 0);
});

test("URI conversion helper (file://)", () => {
  const uri = fileUri("/home/user/project/test.ts");
  assert.equal(uri, "file:///home/user/project/test.ts");
});

test("cancellation safety when abort signal is triggered", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  // Drain serverIn so it doesn't back-pressure
  serverIn.on("data", () => {});

  const controller = new AbortController();

  const requestPromise = client.request("textDocument/hover", {}, 5000, controller.signal);

  // Abort immediately
  controller.abort();

  await assert.rejects(
    () => requestPromise,
    (err: Error) => {
      assert.ok(
        err.message.includes("abort") || err.message.includes("cancel") || err.name === "AbortError",
        `Expected abort/cancel error, got: ${err.message}`,
      );
      return true;
    },
  );

  client.destroy();
});
