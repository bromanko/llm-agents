import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import contextApprovalExtension from "../extensions/index.ts";
import { loadApprovals, saveApprovals, sha256 } from "../lib/helpers.ts";

// ── Mock helpers ───────────────────────────────────────────────────────

interface MockPI {
  handlers: Record<string, Function>;
  commands: Record<string, any>;
  on(event: string, handler: Function): void;
  registerCommand(name: string, opts: any): void;
}

function createMockPI(): MockPI {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, any> = {};
  return {
    handlers,
    commands,
    on(event: string, handler: Function) {
      handlers[event] = handler;
    },
    registerCommand(name: string, opts: any) {
      commands[name] = opts;
    },
  };
}

function createMockCtx(
  cwd: string,
  hasUI = true,
): {
  cwd: string;
  hasUI: boolean;
  notifications: Array<{ message: string; level: string }>;
  selectResponses: Array<string | undefined>;
  ui: {
    notify: (message: string, level: string) => void;
    select: (prompt: string, items: string[]) => Promise<string | undefined>;
    editor: (title: string, content: string) => Promise<void>;
  };
} {
  const notifications: Array<{ message: string; level: string }> = [];
  const selectResponses: Array<string | undefined> = [];
  let selectCallIndex = 0;

  return {
    cwd,
    hasUI,
    notifications,
    selectResponses,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      async select(
        _prompt: string,
        _items: string[],
      ): Promise<string | undefined> {
        return selectResponses[selectCallIndex++];
      },
      async editor(_title: string, _content: string): Promise<void> { },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("contextApprovalExtension", () => {
  let tempDir: string;
  let agentDir: string;
  let projectDir: string;
  let previousDir: string | undefined;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "ext-test-")));
    agentDir = join(tempDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    projectDir = join(tempDir, "project");
    mkdirSync(projectDir, { recursive: true });
    previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("registers handlers and command", () => {
    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    assert.ok(pi.handlers["session_start"]);
    assert.ok(pi.handlers["before_agent_start"]);
    assert.ok(pi.commands["context-approvals"]);
  });

  it("session_start with no context files does nothing", async () => {
    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    await pi.handlers["session_start"]({}, ctx);
    assert.equal(ctx.notifications.length, 0);
  });

  it("session_start prompts for new files and approves", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Test content");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("Approve — include in context");

    await pi.handlers["session_start"]({}, ctx);

    const store = await loadApprovals();
    assert.ok(store[filePath], "File should be in approval store");
    assert.equal(store[filePath].denied, undefined);
  });

  it("session_start prompts for changed files", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Updated content");

    // Pre-approve with old hash
    await saveApprovals({
      [filePath]: { hash: "oldhash", approvedAt: "2026-01-01" },
    });

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("Approve — include in context");

    await pi.handlers["session_start"]({}, ctx);

    // Should have notification about review
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("review")),
      "Should notify about file needing review",
    );
  });

  it("session_start skips previously approved unchanged files", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Test content");

    const hash = sha256("Test content");
    await saveApprovals({
      [filePath]: { hash, approvedAt: "2026-01-01" },
    });

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);

    await pi.handlers["session_start"]({}, ctx);

    // No "needs review" prompt
    const reviewNotifications = ctx.notifications.filter((n) =>
      n.message.includes("need"),
    );
    assert.equal(reviewNotifications.length, 0);
  });

  it("session_start skips permanently denied files without prompting", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Denied content");

    await saveApprovals({
      [filePath]: {
        hash: sha256("Denied content"),
        approvedAt: "2026-01-01",
        denied: true,
      },
    });

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);

    await pi.handlers["session_start"]({}, ctx);

    // File should be denied — verify via before_agent_start stripping
    const prompt = `## ${filePath}\n\nDenied content\n\nCurrent date: 2026-04-06`;
    const result = await pi.handlers["before_agent_start"]({
      systemPrompt: prompt,
    });
    assert.ok(result, "Should return stripped prompt");
    assert.ok(
      !result.systemPrompt.includes("Denied content"),
      "Should strip denied content",
    );
  });

  it("session_start denies all pending in non-interactive mode", async () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "Test content");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir, false);

    await pi.handlers["session_start"]({}, ctx);

    // File should be denied, nothing saved
    const store = await loadApprovals();
    assert.equal(Object.keys(store).length, 0);
  });

  it("session_start handles mix of new, changed, and denied files", async () => {
    // discoverContextFiles walks UP from cwd, so place files at ancestor levels
    const deep = join(projectDir, "a", "b");
    mkdirSync(deep, { recursive: true });

    const newFile = join(deep, "AGENTS.md");
    const changedFile = join(projectDir, "a", "AGENTS.md");
    const deniedFile = join(projectDir, "AGENTS.md");

    writeFileSync(newFile, "new content");
    writeFileSync(changedFile, "changed content");
    writeFileSync(deniedFile, "denied content");

    await saveApprovals({
      [changedFile]: { hash: "oldhash", approvedAt: "2026-01-01" },
      [deniedFile]: {
        hash: sha256("denied content"),
        approvedAt: "2026-01-01",
        denied: true,
      },
    });

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    // cwd is the deepest dir so all three ancestors are walked
    const ctx = createMockCtx(deep);
    // Approve both pending files (new + changed)
    ctx.selectResponses.push("Approve — include in context");
    ctx.selectResponses.push("Approve — include in context");

    await pi.handlers["session_start"]({}, ctx);

    const store = await loadApprovals();
    assert.ok(store[newFile], "New file should be approved");
    assert.ok(store[changedFile], "Changed file should be re-approved");
    assert.equal(store[deniedFile].denied, true, "Denied file stays denied");
  });

  // ── before_agent_start ──────────────────────────────────────────────

  it("before_agent_start strips denied files from prompt", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Deny me");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("Deny — exclude this session");

    await pi.handlers["session_start"]({}, ctx);

    const prompt = `Preamble\n\n## ${filePath}\n\nDeny me\n\nCurrent date: 2026-04-06`;
    const result = await pi.handlers["before_agent_start"]({
      systemPrompt: prompt,
    });

    assert.ok(result);
    assert.ok(!result.systemPrompt.includes("Deny me"));
  });

  it("before_agent_start is no-op when no denied files", async () => {
    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    await pi.handlers["session_start"]({}, ctx);

    const result = await pi.handlers["before_agent_start"]({
      systemPrompt: "test",
    });
    assert.equal(result, undefined);
  });

  it("before_agent_start warns on verification failure", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Deny me");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("Deny — exclude this session");

    await pi.handlers["session_start"]({}, ctx);

    // Pass a prompt that doesn't match the expected format —
    // the ## marker is present but in an unexpected layout
    const badPrompt = `Some text ## ${filePath} more text`;
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: any[]) => warnings.push(args.join(" "));
    try {
      await pi.handlers["before_agent_start"]({ systemPrompt: badPrompt });
    } finally {
      console.warn = origWarn;
    }

    assert.ok(
      warnings.some((w) => w.includes("Failed to strip")),
      "Should warn about failed stripping",
    );
  });

  // ── promptForApproval flow ──────────────────────────────────────────

  it("permanently deny saves to store with correct hash", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Perm deny me");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push(
      "Permanently deny — always exclude until revoked",
    );

    await pi.handlers["session_start"]({}, ctx);

    const store = await loadApprovals();
    assert.ok(store[filePath]);
    assert.equal(store[filePath].denied, true);
    assert.equal(store[filePath].hash, sha256("Perm deny me"));
  });

  it("view content then approve", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "View me");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("View content");
    ctx.selectResponses.push("Approve — include in context");

    await pi.handlers["session_start"]({}, ctx);

    const store = await loadApprovals();
    assert.ok(store[filePath]);
    assert.equal(store[filePath].denied, undefined);
  });

  it("UI failure in select denies by default", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "UI fail");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.ui.select = async () => {
      throw new Error("UI failed");
    };

    await pi.handlers["session_start"]({}, ctx);

    // File should be denied (not in store, but denied for session)
    assert.ok(
      ctx.notifications.some((n) => n.message.includes("failed")),
      "Should notify about prompt failure",
    );
  });

  it("undefined select choice denies file", async () => {
    const filePath = join(projectDir, "AGENTS.md");
    writeFileSync(filePath, "Cancel me");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push(undefined); // user cancelled

    await pi.handlers["session_start"]({}, ctx);

    // File should be denied
    const store = await loadApprovals();
    assert.equal(store[filePath], undefined, "Cancelled file not in store");
  });

  // ── /context-approvals command ──────────────────────────────────────

  describe("/context-approvals command", () => {
    it("lists tracked files", async () => {
      const filePath = join(projectDir, "AGENTS.md");
      writeFileSync(filePath, "Listed");

      await saveApprovals({
        [filePath]: { hash: sha256("Listed"), approvedAt: "2026-01-01" },
      });

      const pi = createMockPI();
      contextApprovalExtension(pi as any);
      const ctx = createMockCtx(projectDir);

      // Run session_start to populate discoveredFiles
      await pi.handlers["session_start"]({}, ctx);
      ctx.notifications.length = 0;

      await pi.commands["context-approvals"].handler("", ctx);

      assert.ok(
        ctx.notifications.some((n) => n.message.includes("approved")),
        "Should list approved file",
      );
    });

    it("revoke subcommand removes approval", async () => {
      const filePath = join(projectDir, "AGENTS.md");
      await saveApprovals({
        [filePath]: { hash: sha256("content"), approvedAt: "2026-01-01" },
      });

      const pi = createMockPI();
      contextApprovalExtension(pi as any);
      const ctx = createMockCtx(projectDir);

      // Select the first item in the revoke list
      ctx.ui.select = async (
        _prompt: string,
        items?: string[],
      ): Promise<string | undefined> => {
        return items?.[0];
      };

      await pi.commands["context-approvals"].handler("revoke", ctx);

      const store = await loadApprovals();
      assert.equal(store[filePath], undefined, "Approval should be revoked");
    });

    it("revoke subcommand with no approvals notifies", async () => {
      const pi = createMockPI();
      contextApprovalExtension(pi as any);
      const ctx = createMockCtx(projectDir);

      await pi.commands["context-approvals"].handler("revoke", ctx);

      assert.ok(
        ctx.notifications.some((n) => n.message.includes("No approvals")),
      );
    });

    it("reset subcommand clears all approvals", async () => {
      await saveApprovals({
        "/a": { hash: sha256("a"), approvedAt: "2026-01-01" },
        "/b": { hash: sha256("b"), approvedAt: "2026-01-01" },
      });

      const pi = createMockPI();
      contextApprovalExtension(pi as any);
      const ctx = createMockCtx(projectDir);

      await pi.commands["context-approvals"].handler("reset", ctx);

      const store = await loadApprovals();
      assert.deepEqual(store, {});
      assert.ok(
        ctx.notifications.some((n) => n.message.includes("cleared")),
      );
    });
  });

  // ── Error paths ──────────────────────────────────────────────────────

  it("loadApprovals failure during session_start uses empty store", async () => {
    // Write invalid JSON to the approvals file
    writeFileSync(
      join(agentDir, "context-approvals.json"),
      "NOT JSON{{{",
    );
    writeFileSync(join(projectDir, "AGENTS.md"), "Content");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("Approve — include in context");

    // Should not throw — loadApprovals returns {} on corrupt JSON
    await pi.handlers["session_start"]({}, ctx);

    // Should have prompted for approval (treated as new)
    const store = await loadApprovals();
    assert.ok(store[join(projectDir, "AGENTS.md")]);
  });

  it("saveApprovals failure during session_start warns but continues", async () => {
    writeFileSync(join(projectDir, "AGENTS.md"), "Content");

    const pi = createMockPI();
    contextApprovalExtension(pi as any);
    const ctx = createMockCtx(projectDir);
    ctx.selectResponses.push("Approve — include in context");

    // Make the agent dir read-only to force save failure
    const { chmodSync } = await import("node:fs");
    chmodSync(agentDir, 0o444);

    try {
      await pi.handlers["session_start"]({}, ctx);
      assert.ok(
        ctx.notifications.some((n) =>
          n.message.includes("Failed to save"),
        ),
        "Should warn about save failure",
      );
    } finally {
      chmodSync(agentDir, 0o755);
    }
  });
});
