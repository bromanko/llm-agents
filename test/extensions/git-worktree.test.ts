import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

import gitWorktreeExtension from "../../pi/git/extensions/git-worktree.ts";
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

type CommandContext = ExtensionCommandContext;

interface CommandRegistration {
  description: string;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
}

interface CapturedRegistration {
  commands: Map<string, CommandRegistration>;
}

interface CaptureResult {
  pi: MockExtensionAPI;
  captured: CapturedRegistration;
  execCalls: Array<{ command: string; args: string[]; cwd?: string }>;
}

const MAIN_HEAD = "1111111111111111111111111111111111111111";
const WS_HEAD = "2222222222222222222222222222222222222222";
const FEATURE_HEAD = "4444444444444444444444444444444444444444";

function ok(stdout = "", stderr = ""): ExecResult {
  return { code: 0, stdout, stderr, killed: false };
}

function fail(stderr = "failed", stdout = "", code = 1): ExecResult {
  return { code, stdout, stderr, killed: false };
}

function createGitRepoTempDir(prefix = "git-worktree-ext-"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(tempDir, ".git"));
  return tempDir;
}

function createPlainTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "git-worktree-non-git-"));
}

function createLinkedWorktreeDir(prefix = "git-linked-worktree-"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(tempDir, ".git"), "gitdir: /tmp/mock\n");
  return tempDir;
}

function worktreeList(repoDir: string, wsPath?: string, extra?: string): string {
  const parts = [
    `worktree ${repoDir}`,
    `HEAD ${MAIN_HEAD}`,
    "branch refs/heads/main",
    "",
  ];

  if (wsPath) {
    parts.push(
      `worktree ${wsPath}`,
      `HEAD ${WS_HEAD}`,
      "branch refs/heads/pi-ws/auth",
      "",
    );
  }

  if (extra) parts.push(extra);
  return parts.join("\n");
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
  };

  pi.registerCommand = (name: string, options: CommandRegistration) => {
    captured.commands.set(name, options);
  };

  const execCalls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  pi.execMock.fn = async (command, args = [], options) => {
    execCalls.push({ command, args: [...args], cwd: options?.cwd });

    if (command === "git" && args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
      const cwd = options?.cwd ?? process.cwd();
      return fs.existsSync(path.join(cwd, ".git")) ? ok("true\n") : fail("not a git worktree");
    }

    return execFn(command, args, options);
  };

  await gitWorktreeExtension(pi as unknown as Parameters<typeof gitWorktreeExtension>[0]);
  return { pi, captured, execCalls };
}

function createCommandCtx(options?: {
  confirm?: boolean;
  entries?: unknown[];
}) {
  const notifications: NotifyEntry[] = [];
  const confirmations: ConfirmEntry[] = [];
  const ctx = {
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
  } as unknown as CommandContext;

  return { notifications, confirmations, ctx };
}

test("registration: no-op outside Git repos", async () => {
  const tempDir = createPlainTempDir();

  try {
    await withCwd(tempDir, async () => {
      const { captured } = await setupExtension(async () => ok());
      assert.equal(captured.commands.size, 0);
    });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("registration: no-op inside jj repos even when .git exists", async () => {
  const repoDir = createGitRepoTempDir();
  fs.mkdirSync(path.join(repoDir, ".jj"));

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await setupExtension(async () => ok());
      assert.equal(captured.commands.size, 0);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("registration: linked Git worktrees still register commands", async () => {
  const linkedDir = createLinkedWorktreeDir();

  try {
    await withCwd(linkedDir, async () => {
      const { captured } = await setupExtension(async () => ok());
      assert.deepEqual([...captured.commands.keys()].sort(), [
        "ws-create",
        "ws-finish",
        "ws-list",
        "ws-switch",
      ]);
    });
  } finally {
    fs.rmSync(linkedDir, { recursive: true, force: true });
  }
});

test("/ws-create: success path creates worktree, records base branch, and opens bare pi", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir));
          if (args[0] === "config" && args[2] === "--get-regexp") return fail("missing", "", 1);
          if (args[0] === "symbolic-ref") return ok("refs/heads/main\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") return fail("no merge");
          if (args[0] === "show-ref") return fail("missing");
          if (args[0] === "worktree" && args[1] === "add") {
            fs.mkdirSync(wsPath, { recursive: true });
            return ok();
          }
          if (args[0] === "config" && args[2] === "pi.worktree.auth.baseBranch") return ok();
          if (args[0] === "new-window") return ok("@7\n");
          if (args[0] === "set-window-option") return ok();
          if (args[0] === "select-window") return ok();
          throw new Error(`Unexpected command: git ${args.join(" ")} cwd=${options?.cwd ?? ""}`);
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "git" && call.args.slice(0, 4).join(" ") === "worktree add -b pi-ws/auth"));
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "config --local pi.worktree.auth.baseBranch main"));
      const newWindowCall = execCalls.find((call) => call.command === "tmux" && call.args[0] === "new-window");
      assert.ok(newWindowCall);
      assert.equal(newWindowCall!.args[newWindowCall!.args.length - 1], "pi");
      assert.ok(notifications.some((n) => /Created worktree 'auth'/.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-create: rejects invocation from a linked worktree", async () => {
  const repoDir = createGitRepoTempDir();
  const linkedDir = createLinkedWorktreeDir();

  try {
    await withCwd(linkedDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${linkedDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(`${path.join(repoDir, ".git")}\n`);
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, linkedDir));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "-V") return ok("tmux 3.10\n");
          return ok();
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      assert.ok(notifications.some((n) => /must be run from the main worktree/i.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(linkedDir, { recursive: true, force: true });
  }
});

test("/ws-create: tmux setup failure rolls back worktree and branch", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir));
          if (args[0] === "config" && args[2] === "--get-regexp") return fail("missing", "", 1);
          if (args[0] === "symbolic-ref") return ok("refs/heads/main\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") return fail("no merge");
          if (args[0] === "show-ref") return fail("missing");
          if (args[0] === "worktree" && args[1] === "add") {
            fs.mkdirSync(wsPath, { recursive: true });
            return ok();
          }
          if (args[0] === "config" && args[2] === "pi.worktree.auth.baseBranch") return ok();
          if (args[0] === "new-window") return ok("@9\n");
          if (args[0] === "set-window-option" && args[3] === "@pi-ws") return fail("tag failed");
          if (args[0] === "kill-window") return ok();
          if (args[0] === "worktree" && args[1] === "remove") {
            fs.rmSync(wsPath, { recursive: true, force: true });
            return ok();
          }
          if (args[0] === "branch" && args[1] === "-D") return ok();
          if (args[0] === "config" && args[2] === "--unset") return ok();
          throw new Error(`Unexpected command: git ${args.join(" ")}`);
        }));

      const wsCreate = captured.commands.get("ws-create")!;
      const { notifications, ctx } = createCommandCtx();
      await wsCreate.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === `worktree remove ${wsPath}`));
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "branch -D pi-ws/auth"));
      assert.equal(fs.existsSync(wsPath), false);
      assert.ok(notifications.some((n) => /tag failed/.test(n.message) && n.level === "error"));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-list: renders managed worktrees, omits unrelated entries, and shows unknown base branches", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  const unrelatedPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-feature`);

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") {
            return ok(worktreeList(
              repoDir,
              wsPath,
              [
                `worktree ${unrelatedPath}`,
                `HEAD ${FEATURE_HEAD}`,
                "branch refs/heads/feature/auth",
                "",
              ].join("\n"),
            ));
          }
          if (args[0] === "config" && args[2] === "--get-regexp") return fail("missing", "", 1);
          if (args[0] === "list-windows") return ok("");
          return ok();
        }));

      const wsList = captured.commands.get("ws-list")!;
      const { notifications, ctx } = createCommandCtx();
      await wsList.handler("", ctx);

      assert.equal(notifications.length, 1);
      assert.match(notifications[0]!.message, /- auth/);
      assert.match(notifications[0]!.message, /base branch: <unknown>/);
      assert.match(notifications[0]!.message, /repair: missing base branch config/);
      assert.doesNotMatch(notifications[0]!.message, /feature\/auth/);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-switch: selects an existing tagged window", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "list-windows") return ok("@7\tws:auth ✻\tauth\t0\n");
          if (args[0] === "select-window") return ok();
          return ok();
        }));

      const wsSwitch = captured.commands.get("ws-switch")!;
      const { notifications, ctx } = createCommandCtx();
      await wsSwitch.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "tmux" && call.args.join(" ") === "select-window -t @7"));
      assert.ok(notifications.some((n) => /existing tmux window/i.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test("/ws-switch: recreates a missing window with pi -c", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "list-windows") return ok("");
          if (args[0] === "new-window") return ok("@8\n");
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

test("/ws-finish: clean success merges, removes worktree, deletes branch, and clears config", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      let listWindowsCount = 0;
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/pi-ws/auth\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") return fail("no merge");
          if (args[0] === "rev-parse" && args[1] === "refs/heads/pi-ws/auth") return ok(`${WS_HEAD}\n`);
          if (args[0] === "status" && options?.cwd === wsPath) return ok("");
          if (args[0] === "status" && options?.cwd === repoDir) return ok("");
          if (args[0] === "merge-base") return fail("not ancestor", "", 1);
          if (args[0] === "merge") return ok();
          if (args[0] === "list-windows") {
            listWindowsCount += 1;
            return listWindowsCount === 1 ? ok("@7\tws:auth\tauth\t0\n") : ok("");
          }
          if (args[0] === "kill-window") return ok();
          if (args[0] === "worktree" && args[1] === "remove") {
            fs.rmSync(wsPath, { recursive: true, force: true });
            return ok();
          }
          if (args[0] === "branch" && args[1] === "-d") return ok();
          if (args[0] === "config" && args[2] === "--unset") return ok();
          if (args[0] === "log") return ok("abcd123 finish workspace auth\nbeef456 previous\n");
          throw new Error(`Unexpected command: git ${args.join(" ")} cwd=${options?.cwd ?? ""}`);
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx();
      await wsFinish.handler("auth", ctx);

      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "merge --no-ff --no-edit -m finish workspace auth refs/heads/pi-ws/auth"));
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === `worktree remove ${wsPath}`));
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "branch -d pi-ws/auth"));
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "config --local --unset pi.worktree.auth.baseBranch"));
      assert.ok(notifications.some((n) => /Finished workspace auth/.test(n.message)));
      assert.equal(fs.existsSync(wsPath), false);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: rejects dirty main worktree and wrong linked branch", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/main\n");
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const wrongBranch = createCommandCtx();
      await wsFinish.handler("auth", wrongBranch.ctx);
      assert.ok(wrongBranch.notifications.some((n) => /no longer on pi-ws\/auth/i.test(n.message)));
    });

    await withCwd(repoDir, async () => {
      const { captured } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/pi-ws/auth\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") return fail("no merge");
          if (args[0] === "status" && options?.cwd === wsPath) return ok("");
          if (args[0] === "status" && options?.cwd === repoDir) return ok(" M README.md\n");
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const dirtyMain = createCommandCtx();
      await wsFinish.handler("auth", dirtyMain.ctx);
      assert.ok(dirtyMain.notifications.some((n) => /main worktree has uncommitted changes/i.test(n.message)));
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: conflict decline aborts merge and preserves worktree", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/pi-ws/auth\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") {
            if (execCalls.some((call) => call.command === "git" && call.args[0] === "merge" && call.args[1] === "--no-ff")) {
              return ok(`${WS_HEAD}\n`);
            }
            return fail("no merge");
          }
          if (args[0] === "status") return ok("");
          if (args[0] === "merge-base") return fail("not ancestor", "", 1);
          if (args[0] === "merge" && args[1] === "--no-ff") {
            return fail(
              [
                "Auto-merging src/app.ts",
                "CONFLICT (content): Merge conflict in src/app.ts",
                "Automatic merge failed; fix conflicts and then commit the result.",
              ].join("\n"),
            );
          }
          if (args[0] === "diff") return ok("src/app.ts\nsrc/lib/auth.ts\n");
          if (args[0] === "merge" && args[1] === "--abort") return ok();
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, confirmations, ctx } = createCommandCtx({ confirm: false });
      await wsFinish.handler("auth", ctx);

      assert.equal(confirmations.length, 1);
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "merge --abort"));
      assert.ok(notifications.some((n) => /Merge aborted/.test(n.message)));
      assert.equal(fs.existsSync(wsPath), true);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: conflict accept sends a single model handoff and does not clean up", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls, pi } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/pi-ws/auth\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") {
            if (execCalls.some((call) => call.command === "git" && call.args[0] === "merge" && call.args[1] === "--no-ff")) {
              return ok(`${WS_HEAD}\n`);
            }
            return fail("no merge");
          }
          if (args[0] === "status") return ok("");
          if (args[0] === "merge-base") return fail("not ancestor", "", 1);
          if (args[0] === "merge" && args[1] === "--no-ff") {
            return fail(
              [
                "Auto-merging src/app.ts",
                "CONFLICT (content): Merge conflict in src/app.ts",
                "Automatic merge failed; fix conflicts and then commit the result.",
              ].join("\n"),
            );
          }
          if (args[0] === "diff") return ok("src/app.ts\nsrc/lib/auth.ts\n");
          return ok();
        }));

      const sentMessages: string[] = [];
      pi.sendUserMessage = (content: unknown) => {
        sentMessages.push(typeof content === "string" ? content : JSON.stringify(content));
      };

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx({ confirm: true });
      await wsFinish.handler("auth", ctx);

      assert.equal(sentMessages.length, 1);
      assert.match(sentMessages[0]!, /src\/app.ts/);
      assert.match(sentMessages[0]!, /Git conflict markers/);
      assert.ok(!execCalls.some((call) => call.command === "git" && call.args.join(" ") === "merge --abort"));
      assert.ok(!execCalls.some((call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove"));
      assert.ok(notifications.some((n) => n.level === "warning" && /Asking model to resolve/.test(n.message)));
      assert.equal(fs.existsSync(wsPath), true);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: rerun with unresolved conflicts errors, rerun after resolution commits and cleans up", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      let listWindowsCount = 0;
      let conflictsResolved = false;
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/pi-ws/auth\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") return ok(`${WS_HEAD}\n`);
          if (args[0] === "rev-parse" && args[1] === "refs/heads/pi-ws/auth") return ok(`${WS_HEAD}\n`);
          if (args[0] === "diff") {
            return conflictsResolved ? ok("") : ok("src/app.ts\n");
          }
          if (args[0] === "commit") return ok("[main abc123] finish workspace auth\n");
          if (args[0] === "list-windows") {
            listWindowsCount += 1;
            return listWindowsCount === 1 ? ok("@7\tws:auth\tauth\t0\n") : ok("");
          }
          if (args[0] === "kill-window") return ok();
          if (args[0] === "worktree" && args[1] === "remove") {
            fs.rmSync(wsPath, { recursive: true, force: true });
            return ok();
          }
          if (args[0] === "branch" && args[1] === "-d") return ok();
          if (args[0] === "config" && args[2] === "--unset") return ok();
          if (args[0] === "log") return ok("abcd123 finish workspace auth\n");
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const unresolved = createCommandCtx();
      await wsFinish.handler("auth", unresolved.ctx);
      assert.ok(unresolved.notifications.some((n) => /unresolved merge conflicts remain/i.test(n.message)));
      assert.ok(!execCalls.some((call) => call.command === "git" && call.args.join(" ") === "commit --no-edit"));
      assert.equal(fs.existsSync(wsPath), true);

      execCalls.length = 0;
      conflictsResolved = true;
      const resolved = createCommandCtx();
      await wsFinish.handler("auth", resolved.ctx);
      assert.ok(execCalls.some((call) => call.command === "git" && call.args.join(" ") === "commit --no-edit"));
      assert.ok(execCalls.some((call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove"));
      assert.ok(resolved.notifications.some((n) => /Finished workspace auth/.test(n.message)));
      assert.equal(fs.existsSync(wsPath), false);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});

test("/ws-finish: non-conflict merge failure surfaces the Git error and performs no cleanup", async () => {
  const repoDir = createGitRepoTempDir();
  const wsPath = path.resolve(repoDir, "..", `${path.basename(repoDir)}-ws-auth`);
  fs.mkdirSync(wsPath, { recursive: true });

  try {
    await withCwd(repoDir, async () => {
      const { captured, execCalls } = await withEnv({ TMUX: "/tmp/test-tmux" }, async () =>
        setupExtension(async (_command, args, options) => {
          if (args[0] === "-V") return ok("tmux 3.6a\n");
          if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return ok(`${repoDir}\n`);
          if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return ok(".git\n");
          if (args[0] === "worktree" && args[1] === "list") return ok(worktreeList(repoDir, wsPath));
          if (args[0] === "config" && args[2] === "--get-regexp") return ok("pi.worktree.auth.baseBranch main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === repoDir) return ok("refs/heads/main\n");
          if (args[0] === "symbolic-ref" && options?.cwd === wsPath) return ok("refs/heads/pi-ws/auth\n");
          if (args[0] === "rev-parse" && args[1] === "MERGE_HEAD") return fail("no merge");
          if (args[0] === "status") return ok("");
          if (args[0] === "merge-base") return fail("not ancestor", "", 1);
          if (args[0] === "merge" && args[1] === "--no-ff") return fail("fatal: merge strategy failed");
          return ok();
        }));

      const wsFinish = captured.commands.get("ws-finish")!;
      const { notifications, ctx } = createCommandCtx();
      await wsFinish.handler("auth", ctx);

      assert.ok(notifications.some((n) => /merge strategy failed/i.test(n.message)));
      assert.ok(!execCalls.some((call) => call.command === "git" && call.args[0] === "worktree" && call.args[1] === "remove"));
      assert.equal(fs.existsSync(wsPath), true);
    });
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(wsPath, { recursive: true, force: true });
  }
});
