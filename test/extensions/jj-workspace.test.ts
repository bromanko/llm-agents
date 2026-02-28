import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutocompleteItem } from "@mariozechner/pi-tui";

import jjWorkspaceExtension from "../../packages/jj/extensions/jj-workspace.ts";
import {
  createMockExtensionAPI,
  type ExecResult,
  type MockExtensionAPI,
} from "../helpers.ts";

type NotifyLevel = "info" | "warning" | "error";

interface NotifyEntry {
  message: string;
  level: NotifyLevel;
}

interface CommandContext {
  hasUI: boolean;
  ui: {
    notify(message: string, level?: NotifyLevel): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
  sessionManager: {
    getEntries(): unknown[];
  };
}

interface CommandRegistration {
  description: string;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
}

interface CapturedRegistration {
  commands: Map<string, CommandRegistration>;
  tools: Array<{ name: string }>;
  appendedEntries: Array<{ customType: string; data: unknown }>;
}

interface CaptureResult {
  pi: MockExtensionAPI;
  captured: CapturedRegistration;
  execCalls: Array<{ command: string; args: string[]; cwd?: string }>;
}

function ok(stdout = "", stderr = ""): ExecResult {
  return { code: 0, stdout, stderr, killed: false };
}

function fail(stderr = "failed", stdout = ""): ExecResult {
  return { code: 1, stdout, stderr, killed: false };
}

function createJjRepoTempDir(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-workspace-ext-"));
  fs.mkdirSync(path.join(tempDir, ".jj"));
  return tempDir;
}

function createPlainTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "jj-workspace-non-jj-"));
}

async function withCwd<T>(cwd: string, fn: () => Promise<T> | T): Promise<T> {
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

async function setupExtension(
  execFn: (command: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult> | ExecResult,
): Promise<CaptureResult> {
  const pi = createMockExtensionAPI();

  const captured: CapturedRegistration = {
    commands: new Map(),
    tools: [],
    appendedEntries: [],
  };

  pi.registerCommand = (name: string, options: CommandRegistration) => {
    captured.commands.set(name, options);
  };

  pi.registerTool = (tool: { name: string }) => {
    captured.tools.push({ name: tool.name });
  };

  pi.appendEntry = (customType: string, data?: unknown) => {
    captured.appendedEntries.push({ customType, data });
  };

  const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  pi.execMock.fn = async (command, args = [], options) => {
    execCalls.push({ command, args: [...args], cwd: options?.cwd });
    return execFn(command, args, options);
  };

  await jjWorkspaceExtension(pi as unknown as Parameters<typeof jjWorkspaceExtension>[0]);

  return { pi, captured, execCalls };
}

function createCommandCtx(options?: {
  confirm?: boolean;
  entries?: unknown[];
}): {
  notifications: NotifyEntry[];
  ctx: CommandContext;
} {
  const notifications: NotifyEntry[] = [];
  const ctx: CommandContext = {
    hasUI: true,
    ui: {
      notify(message: string, level: NotifyLevel = "info") {
        notifications.push({ message, level });
      },
      async confirm() {
        return options?.confirm ?? true;
      },
    },
    sessionManager: {
      getEntries() {
        return options?.entries ?? [];
      },
    },
  };

  return { notifications, ctx };
}

function findEventHandler<T extends (...args: any[]) => any>(
  pi: MockExtensionAPI,
  eventName: string,
): T | undefined {
  const handlers = pi.getHandlers(eventName);
  return handlers[0] as T | undefined;
}

test("registration: no-op outside jj repo", async () => {
  const tempDir = createPlainTempDir();

  try {
    await withCwd(tempDir, async () => {
      const { captured, pi } = await setupExtension(async () => ok());

      assert.equal(captured.commands.size, 0);
      assert.equal(captured.tools.length, 0);
      assert.equal(pi.getHandlers("user_bash").length, 0);
      assert.equal(pi.getHandlers("before_agent_start").length, 0);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("registration: commands/tools are registered in jj repo", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured, pi } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root-change\n");
        }
        return ok();
      });

      assert.deepEqual(
        [...captured.commands.keys()].sort(),
        ["ws-create", "ws-default", "ws-finish", "ws-list", "ws-switch"],
      );

      assert.deepEqual(
        captured.tools.map((tool) => tool.name).sort(),
        ["bash", "edit", "read", "write"],
      );

      assert.equal(pi.getHandlers("user_bash").length, 1);
      assert.equal(pi.getHandlers("before_agent_start").length, 1);
      assert.equal(pi.getHandlers("session_start").length, 1);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("runJj always prefixes jj argv with --color=never", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root-change\n");
        }
        return ok();
      });

      const wsList = captured.commands.get("ws-list")!;
      await wsList.handler("", createCommandCtx().ctx);

      const listCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "list"
      );

      assert.ok(listCall, "expected jj workspace list call");
      assert.equal(listCall.args[0], "--color=never");
      assert.deepEqual(
        listCall.args.slice(1),
        ["workspace", "list", "-T", 'name ++ "|" ++ self.target().change_id() ++ "\\n"'],
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create: missing name shows usage error", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async () => ok());
      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();

      await wsCreate.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /Usage: \/ws-create <name>/);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create: rejects existing workspace name", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nfeature|abc\n");
        }
        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }
        if (args[1] === "workspace" && args[2] === "add") {
          return fail("Error: Workspace feature already exists");
        }
        return ok();
      });

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();

      await wsCreate.handler("feature", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /already exists/);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create: shows error when jj root fails", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }
        if (args[1] === "root") {
          return fail("unable to determine repo root");
        }
        return ok();
      });

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();

      await wsCreate.handler("newwork", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "error");
      assert.match(notifications[0]!.message, /unable to determine repo root/);

      assert.equal(
        captured.appendedEntries.filter((e) => e.customType === "jj-workspace-state").length,
        0,
        "workspace state should not be persisted when jj root fails",
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create: rejects path collision", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-collision`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        return ok();
      });

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("collision", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /already exists on disk/);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-create: shows error when jj workspace add fails", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }
        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }
        if (args[1] === "workspace" && args[2] === "add") {
          return fail("unexpected workspace add error");
        }
        return ok();
      });

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();

      await wsCreate.handler("broken", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "error");
      assert.match(notifications[0]!.message, /unexpected workspace add error/);

      assert.equal(
        captured.appendedEntries.filter((e) => e.customType === "jj-workspace-state").length,
        0,
        "workspace state should not be persisted when workspace add fails",
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create success persists state and enables prompt cwd rewrite", async () => {
  const repoDir = createJjRepoTempDir();
  const expectedWsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-new-work`);

  try {
    await withCwd(repoDir, async () => {
      const { captured, pi } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        if (args[1] === "workspace" && args[2] === "add") {
          return ok();
        }

        return ok();
      });

      const wsCreate = captured.commands.get("ws-create")!;
      const beforeAgentStart = findEventHandler<(event: any, ctx: any) => any>(pi, "before_agent_start")!;

      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("new-work", ctx);

      assert.equal(captured.appendedEntries.length, 1);
      assert.deepEqual(captured.appendedEntries[0], {
        customType: "jj-workspace-state",
        data: { name: "new-work", path: expectedWsPath },
      });

      assert.match(notifications[0]!.message, /Switched to workspace new-work/);

      const promptResult = await beforeAgentStart(
        {
          systemPrompt: `Current working directory: ${repoDir}\nOther context line`,
        },
        {},
      );

      assert.ok(promptResult);
      assert.match(promptResult.systemPrompt, new RegExp(`Current working directory: ${expectedWsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
      assert.match(promptResult.systemPrompt, /You are working in jj workspace "new-work"/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(expectedWsPath, { recursive: true, force: true });
  }
});

test("/ws-switch and /ws-default: validates target, persists state, then clears to default", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-switch-target`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nswitch-target|abc\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[3] === "--name" && args[4] === "switch-target") {
          return ok(`${wsPath}\n`);
        }

        return ok();
      });

      const wsSwitch = captured.commands.get("ws-switch")!;
      const wsDefault = captured.commands.get("ws-default")!;

      const missingName = createCommandCtx();
      await wsSwitch.handler("", missingName.ctx);
      assert.match(missingName.notifications[0]!.message, /Usage: \/ws-switch <name>/);

      const unknownWs = createCommandCtx();
      await wsSwitch.handler("does-not-exist", unknownWs.ctx);
      assert.match(unknownWs.notifications[0]!.message, /does not exist/);

      const switched = createCommandCtx();
      await wsSwitch.handler("switch-target", switched.ctx);
      assert.match(switched.notifications[0]!.message, /Switched to workspace switch-target/);

      assert.deepEqual(captured.appendedEntries[0], {
        customType: "jj-workspace-state",
        data: { name: "switch-target", path: wsPath },
      });

      const backToDefault = createCommandCtx();
      await wsDefault.handler("", backToDefault.ctx);
      assert.match(backToDefault.notifications[0]!.message, /Switched back to default workspace/);

      assert.deepEqual(captured.appendedEntries[1], {
        customType: "jj-workspace-state",
        data: null,
      });
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-default: shows message when already in default workspace", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }
        return ok();
      });

      const wsDefault = captured.commands.get("ws-default")!;
      const { notifications, ctx } = createCommandCtx();

      await wsDefault.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "info");
      assert.match(notifications[0]!.message, /Already in default workspace/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-switch: rejects workspace whose path does not exist on disk", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-gone`);
  // Deliberately do NOT create wsPath on disk

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\ngone|cid-gone\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "gone") {
          return ok(`${wsPath}\n`);
        }

        return ok();
      });

      const wsSwitch = captured.commands.get("ws-switch")!;
      const { notifications, ctx } = createCommandCtx();

      await wsSwitch.handler("gone", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "error");
      assert.match(notifications[0]!.message, /does not exist on disk/);

      assert.equal(
        captured.appendedEntries.filter((e) => e.customType === "jj-workspace-state").length,
        0,
        "workspace state should not be persisted when path is missing",
      );
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-list shows non-default workspaces and active marker", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPathA = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-a`);
  const wsPathB = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-b`);
  fs.mkdirSync(wsPathA, { recursive: true });
  fs.mkdirSync(wsPathB, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\na|id-a\nb|id-b\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "a") {
          return ok(`${wsPathA}\n`);
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "b") {
          return ok(`${wsPathB}\n`);
        }

        return ok();
      });

      const wsSwitch = captured.commands.get("ws-switch")!;
      const wsList = captured.commands.get("ws-list")!;

      await wsSwitch.handler("a", createCommandCtx().ctx);

      const { notifications, ctx } = createCommandCtx();
      await wsList.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /- a \(active\)/);
      assert.match(notifications[0]!.message, /change: id-a/);
      assert.match(notifications[0]!.message, /change: id-b/);
      assert.match(notifications[0]!.message, new RegExp(wsPathA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(notifications[0]!.message, new RegExp(wsPathB.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPathA, { recursive: true, force: true });
    fs.rmSync(wsPathB, { recursive: true, force: true });
  }
});

test("/ws-list: shows message when no non-default workspaces exist", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }
        return ok();
      });

      const wsList = captured.commands.get("ws-list")!;
      const { notifications, ctx } = createCommandCtx();

      await wsList.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "info");
      assert.match(notifications[0]!.message, /No non-default workspaces found/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("getArgumentCompletions: filters by prefix and excludes default", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nfeature-auth|cid-a\nfeature-ui|cid-b\nbugfix|cid-c\n");
        }
        return ok();
      });

      const wsSwitch = captured.commands.get("ws-switch")!;
      const wsFinish = captured.commands.get("ws-finish")!;

      // Trigger a cache refresh so completions have data
      const wsList = captured.commands.get("ws-list")!;
      await wsList.handler("", createCommandCtx().ctx);

      for (const cmd of [wsSwitch, wsFinish]) {
        // Empty prefix returns all non-default workspaces, sorted
        const all = cmd.getArgumentCompletions!("");
        assert.ok(all, "expected completions for empty prefix");
        assert.deepEqual(
          all.map((item) => item.value),
          ["bugfix", "feature-auth", "feature-ui"],
        );

        // Prefix filters to matching names
        const featureOnly = cmd.getArgumentCompletions!("feature");
        assert.ok(featureOnly, "expected completions for 'feature' prefix");
        assert.deepEqual(
          featureOnly.map((item) => item.value),
          ["feature-auth", "feature-ui"],
        );

        // Prefix matching single workspace
        const bugOnly = cmd.getArgumentCompletions!("bug");
        assert.ok(bugOnly, "expected completions for 'bug' prefix");
        assert.deepEqual(
          bugOnly.map((item) => item.value),
          ["bugfix"],
        );

        // Prefix matching nothing returns null
        const noMatch = cmd.getArgumentCompletions!("zzz");
        assert.equal(noMatch, null, "expected null when no completions match");

        // "default" is excluded even with matching prefix
        const defaultPrefix = cmd.getArgumentCompletions!("def");
        assert.equal(defaultPrefix, null, "default workspace should be excluded from completions");

        // Each item has both value and label
        const items = cmd.getArgumentCompletions!("")!;
        for (const item of items) {
          assert.equal(item.value, item.label, "value and label should match");
        }
      }
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-finish: rejects missing target, default target, and missing workspace", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }
        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;

      const missingTarget = createCommandCtx();
      await wsFinish.handler("", missingTarget.ctx);
      assert.match(missingTarget.notifications[0]!.message, /Usage: \/ws-finish/);

      const defaultTarget = createCommandCtx();
      await wsFinish.handler("default", defaultTarget.ctx);
      assert.match(defaultTarget.notifications[0]!.message, /Refusing to finish the default workspace/);

      const missingWorkspace = createCommandCtx();
      await wsFinish.handler("ghost", missingWorkspace.ctx);
      assert.match(missingWorkspace.notifications[0]!.message, /does not exist/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-finish: cancellation via confirm dialog prevents any mutation", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-cancel`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\ncancel|cid-cancel\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "cancel") {
          return ok(`${wsPath}\n`);
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: false });
      await wsFinish.handler("cancel", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /Cancelled/);
      assert.equal(notifications[0]!.level, "info");

      const mergeCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "new"
      );
      assert.equal(mergeCall, undefined, "no merge should be attempted after cancellation");

      const forgetCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "forget"
      );
      assert.equal(forgetCall, undefined, "no forget should be attempted after cancellation");

      assert.equal(fs.existsSync(wsPath), true, "workspace directory must be preserved after cancellation");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: no unique commits forgets and deletes workspace without merge", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-empty`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nempty|cid-empty\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "empty") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(empty@)")) {
          return ok("");
        }

        if (args[1] === "workspace" && args[2] === "forget" && args[3] === "empty") {
          return ok();
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "ancestors(@, 4)") {
          return ok("abc123 finished workspace empty\n");
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });

      await wsFinish.handler("empty", ctx);

      const calledMerge = execCalls.some((call) =>
        call.command === "jj"
        && call.args[1] === "new"
        && call.args[2] === "default@"
        && call.args[3] === "empty@"
      );
      assert.equal(calledMerge, false, "expected no merge command when there are no unique commits");

      const calledForget = execCalls.some((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "forget"
        && call.args[3] === "empty"
      );
      assert.equal(calledForget, true);

      assert.equal(fs.existsSync(wsPath), false, "workspace directory should be deleted");
      assert.deepEqual(captured.appendedEntries.at(-1), {
        customType: "jj-workspace-state",
        data: null,
      });

      assert.match(notifications[0]!.message, /Finished workspace empty/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: abandons all-empty commits before proceeding", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-all-empty`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      let logQueryCount = 0;
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nall-empty|cid-all-empty\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "all-empty") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(all-empty@)")) {
          logQueryCount++;
          if (logQueryCount === 1) {
            return ok("change-1|empty work|true|false\nchange-2|also empty|true|false\n");
          }
          return ok("");
        }

        if (args[1] === "abandon") {
          return ok();
        }

        if (args[1] === "workspace" && args[2] === "forget" && args[3] === "all-empty") {
          return ok();
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "ancestors(@, 4)") {
          return ok("abc123 finished workspace all-empty\n");
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("all-empty", ctx);

      const abandonCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "abandon"
      );
      assert.ok(abandonCall, "expected jj abandon to be called for empty commits");
      assert.deepEqual(
        abandonCall.args.slice(2),
        ["change-1", "change-2"],
        "abandon should be called with all empty change IDs",
      );

      assert.equal(logQueryCount, 2, "workspace changes should be queried twice (before and after abandon)");

      const mergeCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "new"
        && call.args[2] === "default@"
        && call.args[3] === "all-empty@"
      );
      assert.equal(mergeCall, undefined, "merge should not run when all commits were empty and abandoned");

      const forgetCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "forget"
        && call.args[3] === "all-empty"
      );
      assert.ok(forgetCall, "workspace forget should still run after abandoning empty commits");

      assert.equal(fs.existsSync(wsPath), false, "workspace directory should be deleted");
      assert.deepEqual(captured.appendedEntries.at(-1), {
        customType: "jj-workspace-state",
        data: null,
      });

      assert.match(notifications[0]!.message, /Finished workspace all-empty/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: warns when new commits appear during empty-commit cleanup", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-race`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      let logQueryCount = 0;
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nrace|cid-race\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "race") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(race@)")) {
          logQueryCount++;
          if (String(args[3]).includes("heads(") && String(args[3]).includes("~empty()")) {
            // heads() query for merge parents (non-empty heads)
            return ok("change-new\n");
          }
          if (logQueryCount === 1) {
            // First query: all empty
            return ok("change-1|empty work|true|false\n");
          }
          // Second query (after abandon): a new non-empty commit appeared
          return ok("change-new|surprise work|false|false\n");
        }

        if (args[1] === "abandon") {
          return ok();
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "default@") {
          return ok("true");
        }

        if (args[1] === "op" && args[2] === "log") {
          return ok("op-race\n");
        }

        if (args[1] === "new" && args[2] === "default@" && args[3] === "change-new") {
          return ok();
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "@") {
          return ok("false|merged-change\n");
        }

        if (args[1] === "workspace" && args[2] === "forget" && args[3] === "race") {
          return ok();
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "ancestors(@, 4)") {
          return ok("xyz finish workspace race\n");
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("race", ctx);

      // Should have abandoned the original empty commit
      const abandonCall = execCalls.find((call) =>
        call.command === "jj" && call.args[1] === "abandon"
      );
      assert.ok(abandonCall, "expected jj abandon to be called");
      assert.deepEqual(abandonCall.args.slice(2), ["change-1"]);

      // Should have warned about the new commit
      const warning = notifications.find((n) => n.level === "warning" && n.message.includes("new commit"));
      assert.ok(warning, "expected warning about new commits appearing during cleanup");
      assert.match(warning!.message, /1 new commit\(s\) appeared/);

      // Should still proceed to merge the new commit using its change ID
      const mergeCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "new"
        && call.args[2] === "default@"
        && call.args[3] === "change-new"
      );
      assert.ok(mergeCall, "new commits should proceed to merge");

      // Should complete successfully
      const successNotification = notifications.find((n) => n.level === "info" && n.message.includes("Finished"));
      assert.ok(successNotification, "finish should complete successfully");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: merge success path performs merge, forget, delete, and clears state", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-merge-ok`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nmerge-ok|cid-merge\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "merge-ok") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(merge-ok@)")) {
          if (String(args[3]).includes("heads(") && String(args[3]).includes("~empty()")) {
            return ok("change-1\n");
          }
          return ok("change-1|implement feature|false|false\n");
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "default@") {
          return ok("true");
        }

        if (args[1] === "op" && args[2] === "log") {
          return ok("op-123\n");
        }

        if (args[1] === "new" && args[2] === "default@" && args[3] === "change-1") {
          return ok();
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "@") {
          return ok("false|new-change\n");
        }

        if (args[1] === "workspace" && args[2] === "forget" && args[3] === "merge-ok") {
          return ok();
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "ancestors(@, 4)") {
          return ok("xyz890 finish workspace merge-ok\n");
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("merge-ok", ctx);

      const mergeCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "new"
        && call.args[2] === "default@"
        && call.args[3] === "change-1"
      );
      assert.ok(mergeCall, "expected deterministic merge command to run");

      const forgetCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "forget"
        && call.args[3] === "merge-ok"
      );
      assert.ok(forgetCall, "expected workspace forget command");

      assert.equal(fs.existsSync(wsPath), false);
      assert.deepEqual(captured.appendedEntries.at(-1), {
        customType: "jj-workspace-state",
        data: null,
      });

      assert.match(notifications[0]!.message, /Finished workspace merge-ok/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: merge conflict restores operation and preserves workspace", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-conflict`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, pi, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nconflict|cid-conflict\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "conflict") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(conflict@)")) {
          if (String(args[3]).includes("heads(") && String(args[3]).includes("~empty()")) {
            return ok("change-1\n");
          }
          return ok("change-1|conflicting commit|false|false\n");
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "default@") {
          return ok("true");
        }

        if (args[1] === "op" && args[2] === "log") {
          return ok("op-pre-merge\n");
        }

        if (args[1] === "new" && args[2] === "default@" && args[3] === "change-1") {
          return ok();
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "@") {
          return ok("true|conflicted\n");
        }

        if (args[1] === "op" && args[2] === "restore" && args[3] === "op-pre-merge") {
          return ok();
        }

        return ok();
      });

      const wsSwitch = captured.commands.get("ws-switch")!;
      const wsFinish = captured.commands.get("ws-finish")!;
      const beforeAgentStart = findEventHandler<(event: any, ctx: any) => any>(pi, "before_agent_start")!;
      const userBash = findEventHandler<(event: any, ctx: any) => any>(pi, "user_bash")!;

      await wsSwitch.handler("conflict", createCommandCtx().ctx);

      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("conflict", ctx);

      const restoreCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "op"
        && call.args[2] === "restore"
        && call.args[3] === "op-pre-merge"
      );
      assert.ok(restoreCall, "expected rollback operation restore to run");

      const forgetCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "forget"
      );
      assert.equal(forgetCall, undefined, "workspace forget should not run on conflict");

      assert.equal(fs.existsSync(wsPath), true, "workspace directory must be preserved on conflict");
      assert.match(notifications[0]!.message, /Repository restored to pre-finish state/);

      const promptResult = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.ok(promptResult, "workspace should remain active after conflict rollback");
      assert.match(promptResult.systemPrompt, new RegExp(wsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const bashOps = await userBash({ type: "user_bash", command: "pwd" }, {});
      assert.ok(bashOps?.operations, "user bash interception should remain active in workspace");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: reports error when workspace forget fails after merge", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-forget-fail`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nforget-fail|cid-forget-fail\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "forget-fail") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(forget-fail@)")) {
          if (String(args[3]).includes("heads(") && String(args[3]).includes("~empty()")) {
            return ok("change-1\n");
          }
          return ok("change-1|some work|false|false\n");
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "default@") {
          return ok("true");
        }

        if (args[1] === "op" && args[2] === "log") {
          return ok("op-abc\n");
        }

        if (args[1] === "new" && args[2] === "default@" && args[3] === "change-1") {
          return ok();
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "@") {
          return ok("false|merged-change\n");
        }

        if (args[1] === "workspace" && args[2] === "forget" && args[3] === "forget-fail") {
          return fail("workspace forget internal error");
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("forget-fail", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "error");
      assert.match(notifications[0]!.message, /workspace forget internal error/);

      // Merge should have been called (it succeeded)
      const mergeCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "new"
        && call.args[2] === "default@"
        && call.args[3] === "change-1"
      );
      assert.ok(mergeCall, "merge should have been attempted before forget");

      // Workspace directory should NOT be deleted (forget failed, so cleanup was skipped)
      assert.equal(fs.existsSync(wsPath), true, "workspace directory must be preserved when forget fails");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: blocks merge when default workspace has uncommitted changes", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-dirty-default`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\ndirty-def|cid-dirty-def\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "dirty-def") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(dirty-def@)")) {
          return ok("change-1|real work|false|false\n");
        }

        // default@ is NOT empty — has uncommitted changes
        if (args[1] === "log" && args[2] === "-r" && args[3] === "default@") {
          return ok("false");
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("dirty-def", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "error");
      assert.match(notifications[0]!.message, /uncommitted changes/);

      // Should NOT have attempted merge
      const mergeCall = execCalls.find((call) =>
        call.command === "jj" && call.args[1] === "new"
      );
      assert.equal(mergeCall, undefined, "merge should not be attempted when default has uncommitted changes");

      // Workspace directory should be preserved
      assert.equal(fs.existsSync(wsPath), true);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: rejects workspace with pre-existing conflicted commits", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-pre-conflict`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\npre-conflict|cid-pre-conflict\n");
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === "pre-conflict") {
          return ok(`${wsPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes("ancestors(pre-conflict@)")) {
          return ok("change-1|conflicting change|false|true\nchange-2|clean change|false|false\n");
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("pre-conflict", ctx);

      assert.equal(notifications.length, 1);
      assert.equal(notifications[0]!.level, "error");
      assert.match(notifications[0]!.message, /has conflicted commits/);
      assert.match(notifications[0]!.message, /Resolve conflicts/);

      const mergeCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "new"
        && call.args[2] === "default@"
        && call.args[3] === "pre-conflict@"
      );
      assert.equal(mergeCall, undefined, "merge should not be attempted when workspace has conflicts");

      const forgetCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "forget"
      );
      assert.equal(forgetCall, undefined, "workspace forget should not run when workspace has conflicts");

      assert.equal(fs.existsSync(wsPath), true, "workspace directory must be preserved on pre-existing conflict");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: safeDeleteWorkspaceDir guards prevent deletion of dangerous paths", async () => {
  const repoDir = createJjRepoTempDir();

  // Create directories that should survive deletion attempts
  const noWsMarker = path.resolve(repoDir, "..", "plaindir");
  fs.mkdirSync(noWsMarker, { recursive: true });

  const repoRootPath = repoDir;

  const ancestorDir = path.resolve(repoDir, "..");
  // ancestorDir already exists (it's the parent of repoDir)

  async function runFinishWithPath(
    dangerousPath: string,
    wsName: string,
  ): Promise<{ notifications: NotifyEntry[]; dirSurvived: boolean }> {
    const result = await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok(`default|root\n${wsName}|cid-${wsName}\n`);
        }

        if (args[1] === "workspace" && args[2] === "root" && args[4] === wsName) {
          return ok(`${dangerousPath}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && String(args[3]).includes(`ancestors(${wsName}@)`)) {
          return ok("");
        }

        if (args[1] === "workspace" && args[2] === "forget") {
          return ok();
        }

        if (args[1] === "root") {
          return ok(`${repoDir}\n`);
        }

        if (args[1] === "log" && args[2] === "-r" && args[3] === "ancestors(@, 4)") {
          return ok("");
        }

        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler(wsName, ctx);
      return { notifications };
    });

    return {
      notifications: result.notifications,
      dirSurvived: fs.existsSync(dangerousPath),
    };
  }

  try {
    // Guard 1: basename does not include -ws-
    const noMarker = await runFinishWithPath(noWsMarker, "nomarker");
    assert.equal(noMarker.dirSurvived, true, "directory without -ws- in basename must survive");
    assert.match(noMarker.notifications[0]!.message, /did not delete/);

    // Guard 2: path equals repo root
    const repoRoot = await runFinishWithPath(repoRootPath, "reporoot");
    assert.equal(repoRoot.dirSurvived, true, "repo root directory must survive");
    assert.match(repoRoot.notifications[0]!.message, /did not delete/);

    // Guard 3: path is ancestor of repo root
    const ancestor = await runFinishWithPath(ancestorDir, "ancestor");
    assert.equal(ancestor.dirSurvived, true, "ancestor of repo root must survive");
    assert.match(ancestor.notifications[0]!.message, /did not delete/);

    // Guard 4: directory already missing
    const missingPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-vanished`);
    const missing = await runFinishWithPath(missingPath, "vanished");
    assert.match(missing.notifications[0]!.message, /did not delete/);

    // Also verify warning notifications are emitted for failed deletions
    for (const result of [noMarker, repoRoot, ancestor, missing]) {
      const warning = result.notifications.find((n) => n.level === "warning");
      assert.ok(warning, "expected a warning notification for failed deletion");
      assert.match(warning!.message, /could not delete workspace directory/);
    }
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(noWsMarker, { recursive: true, force: true });
  }
});

test("session_start: restores valid saved workspace and warns on stale state", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-persist`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { pi } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\npersist|cid-persist\n");
        }
        return ok();
      });

      const sessionStart = findEventHandler<(event: any, ctx: any) => any>(pi, "session_start")!;
      const beforeAgentStart = findEventHandler<(event: any, ctx: any) => any>(pi, "before_agent_start")!;

      const restoreCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: { name: "persist", path: wsPath },
          },
        ],
      });

      await sessionStart({ type: "session_start" }, restoreCtx.ctx);

      const restoredPrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );

      assert.ok(restoredPrompt, "expected active workspace to be restored from session state");
      assert.match(restoredPrompt.systemPrompt, new RegExp(wsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      const stale = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: { name: "missing", path: path.join(repoDir, "missing-workspace") },
          },
        ],
      });

      await sessionStart({ type: "session_start" }, stale.ctx);

      assert.equal(stale.notifications.length, 1);
      assert.match(stale.notifications[0]!.message, /no longer exists/);

      const stalePrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );

      assert.equal(stalePrompt, undefined, "stale state should not keep workspace active");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("session_start: parseSavedWorkspace edge cases", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-edge`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { pi } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\nedge|cid-edge\n");
        }
        return ok();
      });

      const sessionStart = findEventHandler<(event: any, ctx: any) => any>(pi, "session_start")!;
      const beforeAgentStart = findEventHandler<(event: any, ctx: any) => any>(pi, "before_agent_start")!;

      // Case 1: data: null clears workspace
      // First activate a workspace via a valid entry
      const activateCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: { name: "edge", path: wsPath },
          },
        ],
      });
      await sessionStart({ type: "session_start" }, activateCtx.ctx);

      const activePrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.ok(activePrompt, "workspace should be active before null-data test");

      // Now restore with data: null — should clear
      const nullDataCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: null,
          },
        ],
      });
      await sessionStart({ type: "session_start" }, nullDataCtx.ctx);

      const afterNullPrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.equal(afterNullPrompt, undefined, "data: null should clear workspace");

      // Case 2: missing name field — should clear
      const missingNameCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: { path: wsPath },
          },
        ],
      });
      await sessionStart({ type: "session_start" }, missingNameCtx.ctx);

      const afterMissingNamePrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.equal(afterMissingNamePrompt, undefined, "missing name should clear workspace");

      // Case 3: missing path field — should clear
      const missingPathCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: { name: "edge" },
          },
        ],
      });
      await sessionStart({ type: "session_start" }, missingPathCtx.ctx);

      const afterMissingPathPrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.equal(afterMissingPathPrompt, undefined, "missing path should clear workspace");

      // Case 4: entry uses `type` field instead of `customType` — should still match
      const typeFieldCtx = createCommandCtx({
        entries: [
          {
            type: "jj-workspace-state",
            data: { name: "edge", path: wsPath },
          },
        ],
      });
      await sessionStart({ type: "session_start" }, typeFieldCtx.ctx);

      const afterTypeFieldPrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.ok(afterTypeFieldPrompt, "entry with type field should restore workspace");
      assert.match(afterTypeFieldPrompt.systemPrompt, new RegExp(wsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

      // Case 5: multiple entries — last one wins
      const multiCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: { name: "edge", path: wsPath },
          },
          {
            customType: "jj-workspace-state",
            data: null,
          },
        ],
      });
      await sessionStart({ type: "session_start" }, multiCtx.ctx);

      const afterMultiPrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.equal(afterMultiPrompt, undefined, "last entry (data: null) should win and clear workspace");

      // Case 5b: multiple entries — last valid one activates
      const multiValidCtx = createCommandCtx({
        entries: [
          {
            customType: "jj-workspace-state",
            data: null,
          },
          {
            customType: "jj-workspace-state",
            data: { name: "edge", path: wsPath },
          },
        ],
      });
      await sessionStart({ type: "session_start" }, multiValidCtx.ctx);

      const afterMultiValidPrompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.ok(afterMultiValidPrompt, "last entry with valid data should activate workspace");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("before_agent_start and user_bash are no-ops when no workspace is active", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { pi } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default|root\n");
        }
        return ok();
      });

      const beforeAgentStart = findEventHandler<(event: any, ctx: any) => any>(pi, "before_agent_start")!;
      const userBash = findEventHandler<(event: any, ctx: any) => any>(pi, "user_bash")!;

      const prompt = await beforeAgentStart(
        { systemPrompt: `Current working directory: ${repoDir}` },
        {},
      );
      assert.equal(prompt, undefined);

      const bashResult = await userBash({ type: "user_bash", command: "pwd" }, {});
      assert.equal(bashResult, undefined);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
