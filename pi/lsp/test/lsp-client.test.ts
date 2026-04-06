import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import {
  createLspClient,
  fileUri,
  toLspPosition,
} from "../lib/lsp-client.ts";
import type { LspDiagnostic } from "../lib/types.ts";

function createMockStdio() {
  const serverIn = new PassThrough();
  const serverOut = new PassThrough();
  return { serverIn, serverOut };
}

function encodeFrame(body: unknown): Buffer {
  const json = JSON.stringify(body);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  return Buffer.from(header + json);
}

type FramedMessage = Record<string, unknown>;

function createFrameReader(stream: PassThrough) {
  let buffer = Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let chunkBytes = 0;
  const queuedMessages: FramedMessage[] = [];
  const waiters: Array<{
    resolve: (message: FramedMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  function flushChunks(): void {
    if (chunkBytes === 0) return;
    buffer = buffer.length === 0
      ? Buffer.concat(chunks, chunkBytes)
      : Buffer.concat([buffer, ...chunks], buffer.length + chunkBytes);
    chunks.length = 0;
    chunkBytes = 0;
  }

  function enqueueMessage(message: FramedMessage): void {
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    queuedMessages.push(message);
  }

  function tryDrain(): void {
    flushChunks();

    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const length = Number(match[1]);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + length;
      if (buffer.length < messageEnd) return;

      const json = buffer.subarray(messageStart, messageEnd).toString("utf8");
      buffer = buffer.subarray(messageEnd);
      enqueueMessage(JSON.parse(json) as FramedMessage);
    }
  }

  stream.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    chunkBytes += chunk.length;
    tryDrain();
  });

  return {
    nextMessage(timeoutMs = 250): Promise<FramedMessage> {
      if (queuedMessages.length > 0) {
        return Promise.resolve(queuedMessages.shift()!);
      }

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.resolve === resolve);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for frame after ${timeoutMs}ms`));
        }, timeoutMs);

        waiters.push({ resolve, reject, timer });
        tryDrain();
      });
    },
  };
}

interface WorkspaceConfigurationParams {
  items: Array<{ section?: string }>;
}

test("request/response correlation by id", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const outgoing = createFrameReader(serverIn);
  const client = createLspClient(serverIn, serverOut);

  const requestPromise = client.request("textDocument/hover", {
    textDocument: { uri: "file:///test.ts" },
  });

  const request = await outgoing.nextMessage();
  assert.equal(request.method, "textDocument/hover");

  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    id: request.id,
    result: { contents: "hover info" },
  }));

  const result = await requestPromise;
  assert.deepEqual(result, { contents: "hover info" });

  client.destroy();
});

test("generic notifications are dispatched by method", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  let received: unknown = undefined;
  client.onNotification("custom/notification", (params) => {
    received = params;
  });

  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    method: "custom/notification",
    params: { ok: true },
  }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(received, { ok: true });

  client.destroy();
});

test("publishDiagnostics notifications are routed through onDiagnostics", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  const received: Array<{ uri: string; diagnostics: LspDiagnostic[] }> = [];
  client.onDiagnostics((uri, diagnostics) => {
    received.push({ uri, diagnostics });
  });

  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: "file:///test.ts",
      diagnostics: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: "error",
      }],
    },
  }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(received.length, 1);
  assert.equal(received[0]?.uri, "file:///test.ts");
  assert.deepEqual(received[0]?.diagnostics, [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    message: "error",
  }]);

  client.destroy();
});

test("server-sent requests are handled through onRequest", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const outgoing = createFrameReader(serverIn);
  const client = createLspClient(serverIn, serverOut);

  client.onRequest<WorkspaceConfigurationParams, Array<{ enable: boolean }>>(
    "workspace/configuration",
    async (params) => {
      assert.deepEqual(params, { items: [{ section: "typescript" }] });
      return [{ enable: true }];
    },
  );

  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    id: 99,
    method: "workspace/configuration",
    params: { items: [{ section: "typescript" }] },
  }));

  const response = await outgoing.nextMessage();
  assert.equal(response.id, 99);
  assert.deepEqual(response.result, [{ enable: true }]);

  client.destroy();
});

test("notify emits a JSON-RPC notification without an id", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const outgoing = createFrameReader(serverIn);
  const client = createLspClient(serverIn, serverOut);

  client.notify("textDocument/didOpen", {
    textDocument: {
      uri: "file:///test.ts",
      languageId: "typescript",
      version: 1,
      text: "const x = 1;",
    },
  });

  const message = await outgoing.nextMessage();
  assert.equal(message.method, "textDocument/didOpen");
  assert.equal(message.id, undefined);
  assert.equal((message.params as { textDocument: { version: number } }).textDocument.version, 1);

  client.destroy();
});

test("request timeout rejection is deterministic", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  await assert.rejects(
    () => client.request("textDocument/hover", {}, 30),
    (error: Error) => {
      assert.match(error.message, /timeout/i);
      return true;
    },
  );

  client.destroy();
});

test("abort signal rejects the request", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);
  const controller = new AbortController();

  const requestPromise = client.request("textDocument/hover", {}, 5000, controller.signal);
  controller.abort();

  await assert.rejects(
    () => requestPromise,
    (error: Error) => {
      assert.match(error.message, /abort/i);
      return true;
    },
  );

  client.destroy();
});

test("destroy rejects pending requests and remains safe after listeners are registered", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const client = createLspClient(serverIn, serverOut);

  client.onNotification("custom/notification", () => { });
  client.onDiagnostics(() => { });
  client.onRequest("workspace/configuration", () => ([]));

  const pendingRequest = client.request("textDocument/hover", {}, 5000);
  assert.doesNotThrow(() => client.destroy());

  await assert.rejects(
    () => pendingRequest,
    (error: Error) => {
      assert.match(error.message, /destroyed/i);
      return true;
    },
  );

  assert.doesNotThrow(() => client.destroy());
});

test("destroy stops incoming notifications and requests from firing callbacks", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const outgoing = createFrameReader(serverIn);
  const client = createLspClient(serverIn, serverOut);

  let notificationCount = 0;
  let diagnosticsCount = 0;
  let requestCount = 0;

  client.onNotification("custom/notification", () => {
    notificationCount += 1;
  });
  client.onDiagnostics(() => {
    diagnosticsCount += 1;
  });
  client.onRequest("workspace/configuration", () => {
    requestCount += 1;
    return [];
  });

  client.destroy();

  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    method: "custom/notification",
    params: { ok: true },
  }));
  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: "file:///test.ts",
      diagnostics: [{
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: "error",
      }],
    },
  }));
  serverOut.write(encodeFrame({
    jsonrpc: "2.0",
    id: 10,
    method: "workspace/configuration",
    params: { items: [{ section: "typescript" }] },
  }));

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.equal(notificationCount, 0);
  assert.equal(diagnosticsCount, 0);
  assert.equal(requestCount, 0);
  await assert.rejects(() => outgoing.nextMessage(50), /Timed out waiting for frame/);
});

test("notify is a no-op after destroy", async () => {
  const { serverIn, serverOut } = createMockStdio();
  const outgoing = createFrameReader(serverIn);
  const client = createLspClient(serverIn, serverOut);

  client.destroy();
  client.notify("textDocument/didSave", {
    textDocument: { uri: "file:///test.ts" },
  });

  await assert.rejects(() => outgoing.nextMessage(50), /Timed out waiting for frame/);
});

test("1-index to 0-index position conversion helper", () => {
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
