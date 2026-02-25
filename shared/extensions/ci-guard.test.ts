import test from "node:test";
import assert from "node:assert/strict";

import ciGuard, { CI_PASS_SIGNAL, isCiPassOutput } from "./ci-guard.ts";
import { createMockExtensionAPI, type ExecResult, type MockToolCallHandler } from "../../test/helpers.ts";

/** A single content block inside a tool-result message. */
interface ContentBlock {
  type: string;
  text?: string;
}

/**
 * The message shape that `hasCiPassedAfterMutations` reads from each session
 * entry.  Only the fields actually accessed by the production code are
 * included; this makes the interface a precise contract rather than a loose
 * bag of unknowns.
 */
interface ToolResultMessage {
  role: "toolResult";
  toolName: string;
  isError: boolean;
  content: ContentBlock[];
}

/** A session-branch entry of the "message" variant. */
interface MessageEntry {
  type: "message";
  message: ToolResultMessage;
}

/**
 * The minimal context shape passed to the extension's `tool_call` handler.
 * `getBranch` returns the branch of session entries the guard iterates over.
 */
interface MockContext {
  sessionManager: {
    getBranch(): MessageEntry[];
  };
}

function toolResultEntry(
  toolName: string,
  text: string,
  isError = false,
): MessageEntry {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName,
      isError,
      content: [{ type: "text", text }],
    },
  };
}

function createCtx(entries: MessageEntry[]): MockContext {
  return {
    sessionManager: {
      getBranch() {
        return entries;
      },
    },
  };
}

function setupToolCallHandler(
  execResult: ExecResult = { code: 0, stdout: "", stderr: "", killed: false },
): MockToolCallHandler<MockContext> {
  const pi = createMockExtensionAPI();
  pi.execMock.fn = async () => execResult;

  // `@mariozechner/pi-coding-agent` is not an installed npm package, so we
  // cannot import ExtensionAPI directly. `Parameters<...>[0]` derives the
  // exact expected type from the function under test; `as unknown as T` is
  // safer than `as any` because subsequent usage of the cast value is still
  // fully type-checked. See test/helpers.ts for a full explanation.
  ciGuard(pi as unknown as Parameters<typeof ciGuard>[0]);

  const handlers = pi.getHandlers("tool_call");
  assert.equal(handlers.length, 1, "expected one tool_call handler");

  // Cast from the loose EventHandler type to the specific handler shape.
  // The production handler is compatible at runtime; the cast is consolidated
  // to this single return site so all call sites receive a fully-checked type.
  return handlers[0]! as unknown as MockToolCallHandler<MockContext>;
}

test("blocks git push when no CI pass is present", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("write", "wrote file", false),
    toolResultEntry("bash", "running checks", false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "1", input: { command: "git push" } },
    ctx,
  );

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /CI has not passed/i);
});

test("allows push when CI passed after last mutation", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("bash", "setup", false),
    toolResultEntry("write", "updated file", false),
    toolResultEntry("bash", CI_PASS_SIGNAL, false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "2", input: { command: "git push" } },
    ctx,
  );

  assert.equal(result, undefined);
});

test("blocks push when mutations happened after CI pass", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("write", "initial change", false),
    toolResultEntry("bash", CI_PASS_SIGNAL, false),
    toolResultEntry("edit", "edited again", false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "3", input: { command: "git push origin main" } },
    ctx,
  );

  assert.equal(result?.block, true);
});

test("allows push when selfci config is missing", async () => {
  const handler = setupToolCallHandler({
    code: 1,
    stdout: "",
    stderr: "",
    killed: false,
  });

  const ctx = createCtx([
    toolResultEntry("write", "updated file", false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "4", input: { command: "git push" } },
    ctx,
  );

  assert.equal(result, undefined);
});

test("ignores non-push commands", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("write", "updated file", false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "5", input: { command: "echo hello" } },
    ctx,
  );

  assert.equal(result, undefined);
});

test("ignores git push arriving from a non-bash tool", async () => {
  // The guard exits immediately when toolName !== "bash".  git/jj are only
  // reachable through the bash tool in normal pi usage; any other tool name
  // must pass through unconditionally, regardless of CI state or the command
  // string it carries.
  const handler = setupToolCallHandler();

  // Dirty session: a mutation with no subsequent CI pass — would block if the
  // tool name were "bash", confirming the tool-name check is the deciding factor.
  const ctx = createCtx([
    toolResultEntry("write", "mutation", false),
  ]);

  const result = await handler(
    { toolName: "run", toolCallId: "9", input: { command: "git push" } },
    ctx,
  );

  assert.equal(result, undefined);
});

test("blocks jj git push when CI has not passed", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("edit", "changed file", false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "6", input: { command: "jj git push" } },
    ctx,
  );

  assert.equal(result?.block, true);
});

test("ignores failed mutations when evaluating CI freshness", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("write", "successful mutation", false),
    toolResultEntry("bash", CI_PASS_SIGNAL, false),
    toolResultEntry("edit", "failed mutation", true),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "7", input: { command: "git push" } },
    ctx,
  );

  assert.equal(result, undefined);
});

// ---------------------------------------------------------------------------
// Unit tests for isCiPassOutput — verify the matcher itself, not just the
// integration path.  These tests make the relationship between CI_PASS_SIGNAL
// and the matcher explicit and catch regressions if either is changed.
// ---------------------------------------------------------------------------

test("isCiPassOutput returns true for CI_PASS_SIGNAL", () => {
  assert.equal(isCiPassOutput(CI_PASS_SIGNAL), true);
});

test("isCiPassOutput returns true for longer selfci success output", () => {
  assert.equal(isCiPassOutput("Running checks…\n✅ all checks passed\nDone."), true);
});

test("isCiPassOutput returns false when emoji is missing (near-miss)", () => {
  // "passed" is present but without the ✅ — must not be treated as success.
  assert.equal(isCiPassOutput("checks passed"), false);
  assert.equal(isCiPassOutput("all tests passed"), false);
});

test("isCiPassOutput returns false when 'passed' is missing (near-miss)", () => {
  // ✅ is present but without "passed" — e.g. a non-CI success message.
  assert.equal(isCiPassOutput("✅ build complete"), false);
  assert.equal(isCiPassOutput("✅ done"), false);
});

test("isCiPassOutput returns false for an empty string", () => {
  assert.equal(isCiPassOutput(""), false);
});

// ---------------------------------------------------------------------------
// Integration near-miss: a session whose only bash output is "checks passed"
// (no emoji) must still be treated as CI-not-passed.
// ---------------------------------------------------------------------------

test("blocks push when bash output matches near-miss string (no emoji)", async () => {
  const handler = setupToolCallHandler();

  const ctx = createCtx([
    toolResultEntry("write", "updated file", false),
    // Near-miss: looks like a pass message but lacks the required ✅ emoji.
    toolResultEntry("bash", "all checks passed", false),
  ]);

  const result = await handler(
    { toolName: "bash", toolCallId: "8", input: { command: "git push" } },
    ctx,
  );

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /CI has not passed/i);
});
