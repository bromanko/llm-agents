import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import blockGitMutating from "./block-git-mutating.ts";
import { createMockExtensionAPI, type MockToolCallHandler } from "../../../test/helpers.ts";

/** Context shape expected by the block-git-mutating handler. */
interface HandlerContext {
  cwd: string | undefined;
}

function setupToolCallHandler(): MockToolCallHandler<HandlerContext> {
  const pi = createMockExtensionAPI();
  // `@mariozechner/pi-coding-agent` is not an installed npm package, so we
  // cannot import ExtensionAPI directly. `Parameters<...>[0]` derives the
  // exact expected type from the function under test; `as unknown as T` is
  // safer than `as any` because subsequent usage of the cast value is still
  // fully type-checked. See test/helpers.ts for a full explanation.
  blockGitMutating(pi as unknown as Parameters<typeof blockGitMutating>[0]);

  const handlers = pi.getHandlers("tool_call");
  assert.equal(handlers.length, 1, "expected one tool_call handler");

  // Cast from the loose EventHandler type to the specific handler shape.
  // The production handler is compatible at runtime; the cast is consolidated
  // to this single return site so all call sites receive a fully-checked type.
  return handlers[0]! as unknown as MockToolCallHandler<HandlerContext>;
}

function createJjRepoTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-git-jj-"));
  fs.mkdirSync(path.join(tempDir, ".jj"));
  return tempDir;
}

// ---------------------------------------------------------------------------
// Shared fixtures
//
// The handler is a stateless pure function — it reads ctx.cwd and the command
// string but holds no mutable state between calls, so one instance is safe to
// share across the entire suite.
//
// The jj repo directory is read-only from the handler's perspective (isJjRepo
// only calls existsSync, never writes), so a single temp directory created
// once and removed once is sufficient for all tests that supply it as cwd.
//
// Tests that need a *different* cwd value (non-jj directory, undefined, or a
// regular file path) still manage their own fixtures inline.
// ---------------------------------------------------------------------------

let handler: MockToolCallHandler<HandlerContext>;
let repoDir: string;

before(() => {
  handler = setupToolCallHandler();
  repoDir = createJjRepoTempDir();
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

test("blocks git commit in a jj repository", async () => {
  const result = await handler(
    {
      toolName: "bash",
      toolCallId: "1",
      input: { command: "git commit -m 'test'" },
    },
    { cwd: repoDir },
  );

  assert.equal(result?.block, true);
  assert.match(result?.reason ?? "", /jujutsu/i);
});

test("blocks git push in a jj repository", async () => {
  const result = await handler(
    { toolName: "bash", toolCallId: "2", input: { command: "git push origin main" } },
    { cwd: repoDir },
  );

  assert.equal(result?.block, true);
});

test("blocks git checkout in a jj repository", async () => {
  const result = await handler(
    { toolName: "bash", toolCallId: "3", input: { command: "git checkout -b feature" } },
    { cwd: repoDir },
  );

  assert.equal(result?.block, true);
});

test("allows jj git push", async () => {
  const result = await handler(
    { toolName: "bash", toolCallId: "4", input: { command: "jj git push" } },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("allows jj git fetch", async () => {
  const result = await handler(
    { toolName: "bash", toolCallId: "5", input: { command: "jj git fetch" } },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("allows non-git commands", async () => {
  const result = await handler(
    { toolName: "bash", toolCallId: "6", input: { command: "ls -la" } },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("does not block mutating git commands outside jj repositories", async () => {
  // Needs its own non-jj cwd — managed inline.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-git-non-jj-"));

  try {
    const result = await handler(
      { toolName: "bash", toolCallId: "7", input: { command: "git commit -m 'test'" } },
      { cwd: tempDir },
    );

    assert.equal(result, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("does not block non-bash tools", async () => {
  const result = await handler(
    { toolName: "read", toolCallId: "8", input: { path: "README.md" } },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("blocks compound commands containing mutating git operations", async () => {
  const result = await handler(
    { toolName: "bash", toolCallId: "9", input: { command: "echo hello && git push" } },
    { cwd: repoDir },
  );

  assert.equal(result?.block, true);
});

test("passes through without throwing when command is an empty string", async () => {
  // The production code guards with `if (!command) return` immediately after
  // `const command = event.input.command ?? ""`.  An empty string is falsy, so
  // the handler must return undefined without reaching the repo or regex checks.
  const result = await handler(
    { toolName: "bash", toolCallId: "10", input: { command: "" } },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("passes through without throwing when command is whitespace only", async () => {
  // A whitespace-only string is truthy so it bypasses the `!command` early
  // exit.  Neither MUTATING_GIT_PATTERN nor JJ_GIT_SUBCOMMAND matches it, so
  // the handler must still return undefined rather than throwing or blocking.
  const result = await handler(
    { toolName: "bash", toolCallId: "11", input: { command: "   " } },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("passes through without throwing when command field is absent", async () => {
  // `event.input.command ?? ""` produces "" when the field is missing entirely,
  // which is then treated identically to the empty-string case above.
  const result = await handler(
    { toolName: "bash", toolCallId: "12", input: {} },
    { cwd: repoDir },
  );

  assert.equal(result, undefined);
});

test("passes through without throwing when cwd is undefined", async () => {
  // ExtensionContext types cwd as `string`, but a defensive guard (`if (!ctx.cwd)
  // return`) in the extension must ensure that a missing cwd never reaches
  // isJjRepo — where path.join would throw a TypeError on a non-string argument.
  // We use a mutating git command so the test would catch any accidental block.
  const result = await handler(
    { toolName: "bash", toolCallId: "13", input: { command: "git commit -m 'test'" } },
    { cwd: undefined },
  );

  assert.equal(result, undefined);
});

test("passes through without throwing when cwd points to a regular file", async () => {
  // isJjRepo walks ancestor directories looking for .jj.  Starting from a
  // plain file path is safe: existsSync("<file>/.jj") returns false and dirname
  // walks upward normally.  The handler must return undefined (no .jj found)
  // rather than throwing or blocking incorrectly.
  // Needs its own temp dir containing a regular file — managed inline.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "block-git-file-cwd-"));
  const regularFile = path.join(tempDir, "not-a-directory.txt");
  fs.writeFileSync(regularFile, "hello\n");

  try {
    const result = await handler(
      { toolName: "bash", toolCallId: "14", input: { command: "git commit -m 'test'" } },
      { cwd: regularFile },
    );

    assert.equal(result, undefined);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
