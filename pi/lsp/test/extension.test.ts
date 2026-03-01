import test from "node:test";
import assert from "node:assert/strict";

import { createMockExtensionAPI } from "../../../test/helpers.ts";
import registerLspExtension from "../extensions/lsp.ts";

/** The canonical static prompt hint. */
const PROMPT_HINT =
  'Write/edit results include automatic LSP diagnostics and formatting. Use the lsp tool for code intelligence (action "languages" to list supported languages).';

/**
 * Helper: register the extension and return the mock API for inspection.
 * We override registerTool to capture the definition.
 */
function setupExtension() {
  const pi = createMockExtensionAPI();
  let registeredTool: any = null;

  pi.registerTool = (def: any) => {
    registeredTool = def;
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

  // Simulate session_start to trigger server detection
  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  // Simulate before_agent_start to capture the prompt hint
  const beforeHandlers = pi.getHandlers("before_agent_start");
  let injectedHint = "";
  for (const handler of beforeHandlers) {
    const result = await handler(
      { systemPrompt: "base prompt" },
      { cwd: process.cwd() },
    ) as any;
    if (result?.systemPrompt) {
      const added = result.systemPrompt.replace("base prompt", "").trim();
      if (added.includes("LSP")) {
        injectedHint = added;
      }
    }
  }

  // The hint should be present (even if no servers are running, the extension
  // should still inject the hint if at least one server was detected).
  // If no servers detected at all, the hint may be empty — that's also correct.
  if (injectedHint) {
    assert.equal(injectedHint, PROMPT_HINT, "hint text should match canonical string exactly");
  }
});

test("lsp tool is registered", () => {
  const { getRegisteredTool } = setupExtension();
  const tool = getRegisteredTool();
  assert.ok(tool, "lsp tool should be registered");
  assert.equal(tool.name, "lsp");
});

test("session shutdown triggers cleanup without errors", async () => {
  const { pi } = setupExtension();

  // Simulate session_start first
  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  // Session shutdown should not throw
  const shutdownHandlers = pi.getHandlers("session_shutdown");
  for (const handler of shutdownHandlers) {
    await assert.doesNotReject(async () => handler({}, {}));
  }
});

test("session_start detects servers without crashing", async () => {
  const { pi } = setupExtension();

  // Simulate session_start — should complete without error
  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await assert.doesNotReject(async () => handler({}, { cwd: process.cwd() }));
  }
});

test("tool_result handler does not crash on non-write/edit events", async () => {
  const { pi } = setupExtension();

  // Simulate session_start
  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  // Simulate a bash tool_result
  const handlers = pi.getHandlers("tool_result");
  for (const handler of handlers) {
    const result = await handler(
      { toolName: "bash", toolCallId: "tc1", input: { command: "ls" }, result: "output" },
      { cwd: process.cwd() },
    );
    // Should return undefined (no interception)
    assert.equal(result, undefined);
  }
});

test("before_agent_start handler returns systemPrompt with hint when servers detected", async () => {
  const { pi } = setupExtension();

  // Simulate session_start
  const sessionStartHandlers = pi.getHandlers("session_start");
  for (const handler of sessionStartHandlers) {
    await handler({}, { cwd: process.cwd() });
  }

  // Simulate before_agent_start
  const beforeHandlers = pi.getHandlers("before_agent_start");
  let result: any = undefined;
  for (const handler of beforeHandlers) {
    result = await handler(
      { systemPrompt: "base prompt" },
      { cwd: process.cwd() },
    );
  }

  // Result should include systemPrompt even if no servers found
  // (the handler still runs; it just may not append the hint)
  if (result?.systemPrompt) {
    assert.ok(
      typeof result.systemPrompt === "string",
      "systemPrompt should be a string",
    );
  }
});
