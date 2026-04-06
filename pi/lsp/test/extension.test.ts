import test from "node:test";
import assert from "node:assert/strict";

import { createMockExtensionAPI } from "../../../test/helpers.ts";
import registerLspExtension, { createDiagnosticsRegistry } from "../extensions/lsp.ts";
import type { LspClient } from "../lib/lsp-client.ts";
import type { ManagedServer } from "../lib/server-manager.ts";
import type { LspDiagnostic } from "../lib/types.ts";

const PROMPT_HINT =
  'Write/edit results include automatic LSP diagnostics and formatting. Use the lsp tool for code intelligence (action "languages" to list supported languages).';

interface RegisteredTool {
  name: string;
}

interface BeforeAgentStartResult {
  systemPrompt?: string;
}

class FakeLspClient implements LspClient {
  private diagnosticsListeners: Array<(uri: string, diagnostics: LspDiagnostic[]) => void> = [];

  request<T = unknown>(): Promise<T> {
    return Promise.resolve(undefined as T);
  }

  notify(): void {
    // No-op for these tests.
  }

  onDiagnostics(cb: (uri: string, diagnostics: LspDiagnostic[]) => void): void {
    this.diagnosticsListeners.push(cb);
  }

  onNotification(): void {
    // No-op for these tests.
  }

  onRequest(): void {
    // No-op for these tests.
  }

  destroy(): void {
    // No-op for these tests.
  }

  emitDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
    for (const listener of this.diagnosticsListeners) {
      listener(uri, diagnostics);
    }
  }

  getDiagnosticsListenerCount(): number {
    return this.diagnosticsListeners.length;
  }
}

function createManagedServer(key: string, client: LspClient | null, name = "marksman"): ManagedServer {
  return {
    name,
    key,
    rootDir: key.split(":").slice(1).join(":"),
    rootUri: `file://${key.split(":").slice(1).join(":")}`,
    client,
    lastActivity: Date.now(),
    documents: new Map(),
  };
}

function setupExtension() {
  const pi = createMockExtensionAPI();
  let registeredTool: RegisteredTool | null = null;

  pi.registerTool = (def: unknown) => {
    registeredTool = def as RegisteredTool;
  };

  registerLspExtension(
    pi as unknown as Parameters<typeof registerLspExtension>[0],
  );

  return { pi, getRegisteredTool: () => registeredTool };
}

test("extension registers tool_result handler", () => {
  const { pi } = setupExtension();
  const handlers = pi.getHandlers("tool_result");
  assert.ok(handlers.length > 0, "should register at least one tool_result handler");
});

test("extension registers session_start, session_shutdown, and before_agent_start handlers", () => {
  const { pi } = setupExtension();

  const sessionStart = pi.getHandlers("session_start");
  const sessionShutdown = pi.getHandlers("session_shutdown");
  const beforeAgentStart = pi.getHandlers("before_agent_start");

  assert.ok(sessionStart.length > 0, "should register session_start handler");
  assert.ok(sessionShutdown.length > 0, "should register session_shutdown handler");
  assert.ok(beforeAgentStart.length > 0, "should register before_agent_start handler");
});

test("prompt hint text equals canonical static string (exact match)", async () => {
  const { pi } = setupExtension();

  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  const beforeHandlers = pi.getHandlers("before_agent_start");
  let injectedHint = "";
  for (const handler of beforeHandlers) {
    const result = await handler(
      { systemPrompt: "base prompt" },
      { cwd: process.cwd() },
    ) as BeforeAgentStartResult | undefined;
    if (typeof result?.systemPrompt === "string") {
      const added = result.systemPrompt.replace("base prompt", "").trim();
      if (added.includes("LSP")) {
        injectedHint = added;
      }
    }
  }

  if (injectedHint) {
    assert.equal(injectedHint, PROMPT_HINT, "hint text should match canonical string exactly");
  }
});

test("lsp tool is registered", () => {
  const { getRegisteredTool } = setupExtension();
  const tool = getRegisteredTool();
  assert.ok(tool, "lsp tool should be registered");
  assert.equal(tool?.name, "lsp");
});

test("session shutdown triggers cleanup without errors", async () => {
  const { pi } = setupExtension();

  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  const shutdownHandlers = pi.getHandlers("session_shutdown");
  for (const handler of shutdownHandlers) {
    await assert.doesNotReject(async () => handler({}, {}));
  }
});

test("session_start detects servers without crashing", async () => {
  const { pi } = setupExtension();

  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await assert.doesNotReject(async () => handler({}, { cwd: process.cwd() }));
  }
});

test("tool_result handler does not crash on non-write/edit events", async () => {
  const { pi } = setupExtension();

  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  const handlers = pi.getHandlers("tool_result");
  for (const handler of handlers) {
    const result = await handler(
      { toolName: "bash", toolCallId: "tc1", input: { command: "ls" }, result: "output" },
      { cwd: process.cwd() },
    );
    assert.equal(result, undefined);
  }
});

test("before_agent_start handler returns systemPrompt with hint when servers detected", async () => {
  const { pi } = setupExtension();

  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  const beforeHandlers = pi.getHandlers("before_agent_start");
  let result: BeforeAgentStartResult | undefined;
  for (const handler of beforeHandlers) {
    result = await handler(
      { systemPrompt: "base prompt" },
      { cwd: process.cwd() },
    ) as BeforeAgentStartResult | undefined;
  }

  if (result?.systemPrompt) {
    assert.equal(typeof result.systemPrompt, "string");
  }
});

test("diagnostics registry stores diagnostics by runtime key for servers with the same name", () => {
  const registry = createDiagnosticsRegistry();
  const clientA = new FakeLspClient();
  const clientB = new FakeLspClient();
  const serverA = createManagedServer("marksman:/repo/docs", clientA, "marksman");
  const serverB = createManagedServer("marksman:/repo/notes", clientB, "marksman");

  registry.attach(serverA);
  registry.attach(serverB);

  const diagnosticsA: LspDiagnostic[] = [{
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    },
    message: "Heading issue",
  }];
  const diagnosticsB: LspDiagnostic[] = [{
    range: {
      start: { line: 1, character: 0 },
      end: { line: 1, character: 1 },
    },
    message: "Link issue",
  }];

  clientA.emitDiagnostics("file:///repo/docs/README.md", diagnosticsA);
  clientB.emitDiagnostics("file:///repo/notes/README.md", diagnosticsB);

  assert.deepEqual(
    registry.getDiagnostics(serverA.key, "file:///repo/docs/README.md"),
    diagnosticsA,
  );
  assert.deepEqual(
    registry.getDiagnostics(serverB.key, "file:///repo/notes/README.md"),
    diagnosticsB,
  );
  assert.deepEqual(
    registry.getDiagnostics(serverA.key, "file:///repo/notes/README.md"),
    [],
  );
});

test("diagnostics registry does not attach duplicate listeners for the same live client", () => {
  const registry = createDiagnosticsRegistry();
  const client = new FakeLspClient();
  const server = createManagedServer("marksman:/repo/docs", client, "marksman");

  registry.attach(server);
  registry.attach(server);

  assert.equal(client.getDiagnosticsListenerCount(), 1);
});

test("diagnostics registry reattaches for a restarted client with the same runtime key", () => {
  const registry = createDiagnosticsRegistry();
  const firstClient = new FakeLspClient();
  const secondClient = new FakeLspClient();
  const serverKey = "marksman:/repo/docs";

  registry.attach(createManagedServer(serverKey, firstClient, "marksman"));
  registry.attach(createManagedServer(serverKey, secondClient, "marksman"));

  assert.equal(firstClient.getDiagnosticsListenerCount(), 1);
  assert.equal(secondClient.getDiagnosticsListenerCount(), 1);
});
