import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { AutocompleteItem } from "@mariozechner/pi-tui";

import jjWorkspaceExtension from "../../pi/jj/extensions/jj-workspace.ts";
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

interface ConfirmEntry {
  title: string;
  message: string;
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

function createJjRepoTempDir(prefix = "jj-workspace-ext-"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

async function withEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const previous = new Map<string, string | undefined>();

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
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
  confirmations: ConfirmEntry[];
  ctx: CommandContext;
} {
  const notifications: NotifyEntry[] = [];
  const confirmations: ConfirmEntry[] = [];
  const ctx: CommandContext = {
    hasUI: true,
    ui: {
      notify(message: string, level: NotifyLevel = "info") {
        notifications.push({ message, level });
      },
      async confirm(title: string, message: string) {
        confirmations.push({ title, message });
        return options?.confirm ?? true;
      },
    },
    sessionManager: {
      getEntries() {
        return options?.entries ?? [];
      },
    },
  };

  return { notifications, confirmations, ctx };
}

test("registration: no-op outside jj repo", async () => {
  const tempDir = createPlainTempDir();

  try {
    await withCwd(tempDir, async () => {
      const { captured, pi } = await setupExtension(async () => ok());

      assert.equal(captured.commands.size, 0);
      assert.equal(captured.tools.length, 0);
      assert.equal(captured.appendedEntries.length, 0);
      assert.equal(pi.getHandlers("user_bash").length, 0);
      assert.equal(pi.getHandlers("before_agent_start").length, 0);
      assert.equal(pi.getHandlers("session_start").length, 0);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("registration: jj repo registers only workspace commands and no virtual-cwd hooks", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured, pi } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default:def000\n");
        }
        return ok();
      });

      assert.deepEqual([...captured.commands.keys()].sort(), [
        "ws-create",
        "ws-finish",
        "ws-list",
        "ws-switch",
      ]);
      assert.deepEqual(captured.tools, []);
      assert.equal(captured.appendedEntries.length, 0);
      assert.equal(pi.getHandlers("user_bash").length, 0);
      assert.equal(pi.getHandlers("before_agent_start").length, 0);
      assert.equal(pi.getHandlers("session_start").length, 0);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("workspace list refresh still calls jj with --color=never", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\n");
          return ok();
        }));

      const wsList = captured.commands.get("ws-list")!;
      await wsList.handler("", createCommandCtx().ctx);

      const listCall = execCalls.find((call) =>
        call.command === "jj"
        && call.args[1] === "workspace"
        && call.args[2] === "list"
      );

      assert.ok(listCall, "expected jj workspace list call");
      assert.equal(listCall!.args[0], "--color=never");
      assert.deepEqual(
        listCall!.args.slice(1),
        ["workspace", "list", "-T", 'name ++ ":" ++ self.target().change_id() ++ "\\n"'],
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
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\n");
        return ok();
      });

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

test("/ws-create: requires tmux", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: undefined, TERM_PROGRAM: undefined, TERM: "xterm-256color" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\n");
          return ok();
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /require tmux/i);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create: rejects invocation from a named workspace session", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nfeature:abc123\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@") return ok("abc123\n");
          return ok();
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /must be run from the default workspace/i);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-create: success path uses bare pi and tags the tmux window", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@") return ok("def000\n");
          if (args[1] === "root") return ok(`${repoDir}\n`);
          if (args[1] === "workspace" && args[2] === "add") {
            fs.mkdirSync(wsPath, { recursive: true });
            return ok();
          }
          if (args[0] === "new-window") return ok("@7\n");
          if (args[0] === "set-window-option") return ok();
          if (args[0] === "select-window") return ok();
          return ok();
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      const newWindowCall = execCalls.find((call) => call.command === "tmux" && call.args[0] === "new-window");
      assert.ok(newWindowCall);
      assert.equal(newWindowCall!.args[newWindowCall!.args.length - 1], "pi");
      assert.ok(execCalls.some((call) => call.command === "tmux" && call.args.join(" ").includes("@pi-ws auth")));
      assert.ok(execCalls.some((call) => call.command === "tmux" && call.args.join(" ").includes("remain-on-exit off")));
      assert.equal(captured.appendedEntries.length, 0);
      assert.ok(notifications.some((n) => /Created workspace 'auth'/.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-create: tmux setup failure rolls back workspace forget and directory cleanup", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@") return ok("def000\n");
          if (args[1] === "root") return ok(`${repoDir}\n`);
          if (args[1] === "workspace" && args[2] === "add") {
            fs.mkdirSync(wsPath, { recursive: true });
            return ok();
          }
          if (args[0] === "new-window") return ok("@7\n");
          if (args[0] === "set-window-option" && args[3] === "@pi-ws") return fail("tag failed");
          if (args[0] === "kill-window") return ok();
          if (args[1] === "workspace" && args[2] === "forget") return ok();
          return ok();
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "jj" && call.args[1] === "workspace" && call.args[2] === "forget"));
      assert.equal(fs.existsSync(wsPath), false);
      const lastNotification = notifications[notifications.length - 1]!;
      assert.equal(lastNotification.level, "error");
      assert.match(lastNotification.message, /tag failed/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-switch: reuses tagged window even when tmux title is mutated", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\n");
          if (args[0] === "list-windows") return ok("@7\tws:auth ✻\tauth\t0\n");
          if (args[0] === "select-window") return ok();
          return ok();
        }));

      const wsSwitch = captured.commands.get("ws-switch")!;
      const { notifications, ctx } = createCommandCtx();
      await wsSwitch.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "tmux" && call.args[0] === "select-window" && call.args[2] === "@7"));
      assert.ok(notifications.some((n) => /existing tmux window/i.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-switch: recreates missing window with pi -c", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\n");
          if (args[0] === "list-windows") return ok("");
          if (args[1] === "workspace" && args[2] === "root") return ok(`${wsPath}\n`);
          if (args[0] === "new-window") return ok("@9\n");
          if (args[0] === "set-window-option") return ok();
          if (args[0] === "select-window") return ok();
          return ok();
        }));

      const wsSwitch = captured.commands.get("ws-switch")!;
      const { notifications, ctx } = createCommandCtx();
      await wsSwitch.handler("auth", ctx);

      const newWindowCall = execCalls.find((call) => call.command === "tmux" && call.args[0] === "new-window");
      assert.ok(newWindowCall);
      assert.equal(newWindowCall!.args[newWindowCall!.args.length - 1], "pi -c");
      assert.ok(notifications.some((n) => /Re-created tmux window/i.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-list shows window open vs missing and active window marker", async () => {
  const repoDir = createJjRepoTempDir();
  const authPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  const uiPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-ui`);

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\nui:def456\n");
          if (args[0] === "list-windows") return ok("@7\tws:auth ✻\tauth\t1\n");
          if (args[1] === "workspace" && args[2] === "root" && args[4] === "auth") return ok(`${authPath}\n`);
          if (args[1] === "workspace" && args[2] === "root" && args[4] === "ui") return ok(`${uiPath}\n`);
          return ok();
        }));

      const wsList = captured.commands.get("ws-list")!;
      const { notifications, ctx } = createCommandCtx();
      await wsList.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /window: open \(active window\)/);
      assert.match(notifications[0]!.message, /window: —/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("getArgumentCompletions excludes default workspace", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") {
          return ok("default:def000\nauth:abc123\nui:def456\n");
        }
        return ok();
      });

      const wsSwitch = captured.commands.get("ws-switch")!;
      assert.deepEqual(wsSwitch.getArgumentCompletions?.("a"), [
        { value: "auth", label: "auth" },
      ]);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-finish: missing name shows usage error", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async (_command, args) => {
        if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\n");
        return ok();
      });

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx();
      await wsFinish.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /Usage: \/ws-finish <name>/);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-finish: rejects invocation from a named workspace session", async () => {
  const repoDir = createJjRepoTempDir();

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@") return ok("abc123\n");
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx();
      await wsFinish.handler("auth", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /must be run from the default workspace/i);
      assert.equal(notifications[0]!.level, "error");
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-finish: kills window, snapshots workspace state, and completes merge", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      let listWindowsCount = 0;
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@" && args[5] === "change_id") return ok("def000\n");
          if (args[1] === "workspace" && args[2] === "root") return ok(`${wsPath}\n`);
          if (args[0] === "list-windows") {
            listWindowsCount += 1;
            return listWindowsCount === 1
              ? ok("@7\tws:auth ✻\tauth\t0\n")
              : ok("");
          }
          if (args[0] === "kill-window") return ok();
          if (args[1] === "status") {
            assert.equal(options?.cwd, wsPath);
            return ok("Working copy changes:\nM a.txt\n");
          }
          if (args[1] === "log" && String(args[3]).includes("ancestors(auth@) & mutable()")) {
            return ok("abc123|finish auth|false|false\n");
          }
          if (args[1] === "log" && args[3] === "default@") return ok("true\n");
          if (args[1] === "op" && args[2] === "log") return ok("op123\n");
          if (args[1] === "log" && String(args[3]).includes("heads(ancestors(auth@)")) return ok("abc123\n");
          if (args[1] === "new") return ok();
          if (args[1] === "log" && args[3] === "@" && String(args[6]).includes("conflict")) return ok("false|merge123\n");
          if (args[1] === "workspace" && args[2] === "forget") return ok();
          if (args[1] === "root") return ok(`${repoDir}\n`);
          if (args[1] === "log" && args[3] === "ancestors(@, 4)") return ok("abcd123 finish workspace auth\n");
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, confirmations, ctx } = createCommandCtx();
      await wsFinish.handler("auth", ctx);

      assert.equal(confirmations.length, 2);
      assert.ok(execCalls.some((call) => call.command === "jj" && call.args[1] === "status" && call.cwd === wsPath));
      assert.ok(execCalls.some((call) => call.command === "tmux" && call.args[0] === "kill-window"));
      assert.ok(notifications.some((n) => /Finished workspace auth/i.test(n.message)));
      assert.equal(fs.existsSync(wsPath), false);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: snapshot failure aborts before forget/delete", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@" && args[5] === "change_id") return ok("def000\n");
          if (args[1] === "workspace" && args[2] === "root") return ok(`${wsPath}\n`);
          if (args[0] === "list-windows") return ok("");
          if (args[1] === "status") {
            assert.equal(options?.cwd, wsPath);
            return fail("snapshot failed");
          }
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx();
      await wsFinish.handler("auth", ctx);

      assert.ok(notifications.some((n) => /snapshot failed/i.test(n.message)));
      assert.ok(!execCalls.some((call) => call.command === "jj" && call.args[1] === "workspace" && call.args[2] === "forget"));
      assert.equal(fs.existsSync(wsPath), true);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: merge conflict restores operation after snapshot", async () => {
  const repoDir = createJjRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[1] === "workspace" && args[2] === "list") return ok("default:def000\nauth:abc123\n");
          if (args[1] === "log" && args[2] === "-r" && args[3] === "@" && args[5] === "change_id") return ok("def000\n");
          if (args[1] === "workspace" && args[2] === "root") return ok(`${wsPath}\n`);
          if (args[0] === "list-windows") return ok("");
          if (args[1] === "status") {
            assert.equal(options?.cwd, wsPath);
            return ok("The working copy has no changes.\n");
          }
          if (args[1] === "log" && String(args[3]).includes("ancestors(auth@) & mutable()")) {
            return ok("abc123|finish auth|false|false\n");
          }
          if (args[1] === "log" && args[3] === "default@") return ok("true\n");
          if (args[1] === "op" && args[2] === "log") return ok("op123\n");
          if (args[1] === "log" && String(args[3]).includes("heads(ancestors(auth@)")) return ok("abc123\n");
          if (args[1] === "new") return ok();
          if (args[1] === "log" && args[3] === "@" && String(args[6]).includes("conflict")) return ok("true|merge123\n");
          if (args[1] === "op" && args[2] === "restore") return ok();
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx();
      await wsFinish.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "jj" && call.args[1] === "op" && call.args[2] === "restore"));
      assert.ok(notifications.some((n) => /restored to pre-finish state/i.test(n.message)));
      assert.ok(!execCalls.some((call) => call.command === "jj" && call.args[1] === "workspace" && call.args[2] === "forget"));
      assert.equal(fs.existsSync(wsPath), true);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});
