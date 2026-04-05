import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import {
  createWorkspaceWindow,
  inTmuxEnv,
  killWindow,
  listWorkspaceWindows,
  selectWindow,
  type TmuxWorkspaceWindow,
} from "../../lib/tmux-workspaces.ts";
import { isValidWorkspaceName } from "../../jj/lib/workspace.ts";
import {
  computeMainWorktreeRoot,
  linkedWorktreeOnManagedBranch,
  managedBranchRef,
  parseGitWorktreeList,
  toManagedGitWorktree,
  type ManagedGitWorktree,
} from "../lib/worktree.ts";

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

type CommandContext = ExtensionCommandContext;

interface ManagedWorktreeState extends ManagedGitWorktree {
  baseBranch: string | null;
}

interface TmuxVersion {
  major: number;
  minor: number;
}

type RefreshManagedWorktreeCacheResult =
  | {
    ok: true;
    managed: ManagedWorktreeState[];
  }
  | {
    ok: false;
    error: Error;
  };

const DEFAULT_GIT_TIMEOUT = 20_000;
const LONG_GIT_TIMEOUT = 60_000;
const MIN_TMUX_VERSION: TmuxVersion = { major: 3, minor: 2 };
const GIT_HEADS_PREFIX = "refs/heads/";
const TMUX_VERSION_RE = /tmux\s+(\d+)(?:\.(\d+))?/;

function shortBranchName(branchRef: string): string {
  return branchRef.startsWith(GIT_HEADS_PREFIX)
    ? branchRef.slice(GIT_HEADS_PREFIX.length)
    : branchRef;
}

function configKey(name: string): string {
  return `pi.worktree.${name}.baseBranch`;
}

function isJjRepo(dir: string): boolean {
  let current = dir;
  while (true) {
    if (existsSync(join(current, ".jj"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function parseTmuxVersionTuple(output: string): TmuxVersion | null {
  const match = output.trim().match(TMUX_VERSION_RE);
  if (!match) return null;

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;

  return { major, minor };
}

function isAtLeastTmuxVersion(actual: TmuxVersion, minimum: TmuxVersion): boolean {
  return actual.major > minimum.major
    || (actual.major === minimum.major && actual.minor >= minimum.minor);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function workspaceCompletionItems(names: string[], prefix: string): AutocompleteItem[] | null {
  const current = prefix.trim();
  const filtered = names
    .filter((name) => name.startsWith(current))
    .sort()
    .map((name) => ({ value: name, label: name }));

  return filtered.length > 0 ? filtered : null;
}

function formatExecError(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function formatWindowStatus(active: boolean): string {
  return active ? "open (active window)" : "open";
}

export default async function(pi: ExtensionAPI) {
  const defaultCwd = process.cwd();
  if (isJjRepo(defaultCwd)) return;

  async function isGitCheckout(cwd: string): Promise<boolean> {
    const result = await pi.exec("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      timeout: 3_000,
    });

    return !result.killed && result.code === 0 && (result.stdout ?? "").trim() === "true";
  }

  if (!(await isGitCheckout(defaultCwd))) return;

  let managedWorktreeCache: ManagedWorktreeState[] = [];

  async function runGit(
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<GitResult> {
    const result = await pi.exec("git", args, {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeout ?? DEFAULT_GIT_TIMEOUT,
    });

    if (result.killed) {
      return {
        stdout: result.stdout ?? "",
        stderr: `Command timed out: git ${args.join(" ")}`,
        code: result.code,
        killed: true,
      };
    }

    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code,
      killed: false,
    };
  }

  async function ensureTmuxReady(): Promise<string | null> {
    if (!inTmuxEnv()) {
      return "Workspace commands require tmux. Start pi inside tmux and retry.";
    }

    const result = await pi.exec("tmux", ["-V"], { timeout: 3_000 });
    if (result.killed || result.code !== 0) {
      return "Workspace commands require tmux 3.2 or later. Could not determine tmux version.";
    }

    const versionText = (result.stdout ?? "").trim();
    const version = parseTmuxVersionTuple(versionText);
    if (version === null) {
      return `Workspace commands require tmux 3.2 or later. Found: ${versionText || "unknown"}.`;
    }

    if (!isAtLeastTmuxVersion(version, MIN_TMUX_VERSION)) {
      return `Workspace commands require tmux 3.2 or later. Found: ${versionText || "unknown"}.`;
    }

    return null;
  }

  async function getCheckoutRoot(cwd: string): Promise<string> {
    const result = await runGit(["rev-parse", "--show-toplevel"], { cwd });
    if (result.code !== 0) {
      throw new Error(formatExecError(result, "Failed to determine Git checkout root."));
    }

    const root = result.stdout.trim();
    if (!root) throw new Error("Failed to determine Git checkout root.");
    return root;
  }

  async function getMainWorktreeRoot(cwd: string): Promise<string> {
    const showTopLevel = await getCheckoutRoot(cwd);
    const commonDirResult = await runGit(["rev-parse", "--git-common-dir"], { cwd });
    if (commonDirResult.code !== 0) {
      throw new Error(formatExecError(commonDirResult, "Failed to determine Git common directory."));
    }

    const gitCommonDir = commonDirResult.stdout.trim();
    if (!gitCommonDir) throw new Error("Failed to determine Git common directory.");
    return computeMainWorktreeRoot(showTopLevel, gitCommonDir);
  }

  async function getWorktreeRoots(cwd: string): Promise<{ checkoutRoot: string; mainRoot: string }> {
    const checkoutRoot = await getCheckoutRoot(cwd);
    const mainRoot = await getMainWorktreeRoot(cwd);
    return { checkoutRoot, mainRoot };
  }

  async function getCurrentBranchRef(cwd: string): Promise<string | null> {
    const result = await runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd });
    if (result.code !== 0) return null;

    const branchRef = result.stdout.trim();
    return branchRef.length > 0 ? branchRef : null;
  }

  async function getCurrentBranch(cwd: string): Promise<string | null> {
    const branchRef = await getCurrentBranchRef(cwd);
    return branchRef ? shortBranchName(branchRef) : null;
  }

  async function listBaseBranches(mainRoot: string): Promise<Map<string, string>> {
    const result = await runGit([
      "config",
      "--local",
      "--get-regexp",
      "^pi\\.worktree\\..*\\.baseBranch$",
    ], { cwd: mainRoot });

    if (result.code !== 0) {
      if (!result.killed && result.code === 1) return new Map();
      throw new Error(formatExecError(result, "Failed to read managed worktree base-branch config."));
    }

    const baseBranches = new Map<string, string>();
    for (const rawLine of result.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const match = line.match(/^pi\.worktree\.([^\s]+)\.baseBranch\s+(.+)$/);
      if (!match) continue;

      const [, name, baseBranch] = match;
      if (!name || !baseBranch) continue;
      baseBranches.set(name, baseBranch);
    }

    return baseBranches;
  }

  async function setBaseBranch(name: string, baseBranch: string, cwd: string): Promise<GitResult> {
    return runGit(["config", "--local", configKey(name), baseBranch], {
      cwd,
      timeout: LONG_GIT_TIMEOUT,
    });
  }

  async function unsetBaseBranch(name: string, cwd: string): Promise<void> {
    await runGit(["config", "--local", "--unset", configKey(name)], {
      cwd,
      timeout: LONG_GIT_TIMEOUT,
    });
  }

  async function listManagedWorktrees(mainRoot?: string): Promise<ManagedWorktreeState[]> {
    const resolvedMainRoot = mainRoot ?? await getMainWorktreeRoot(process.cwd());
    const result = await runGit(["worktree", "list", "--porcelain"], { cwd: resolvedMainRoot });
    if (result.code !== 0) {
      throw new Error(formatExecError(result, "Failed to list Git worktrees."));
    }

    const baseBranches = await listBaseBranches(resolvedMainRoot);
    const managed = parseGitWorktreeList(result.stdout)
      .map((entry) => toManagedGitWorktree(entry))
      .filter((entry): entry is ManagedGitWorktree => entry !== null)
      .filter((entry) => resolve(entry.path) !== resolve(resolvedMainRoot));

    return managed.map((entry) => ({
      ...entry,
      baseBranch: baseBranches.get(entry.name) ?? null,
    }));
  }

  async function refreshManagedWorktreeCache(mainRoot?: string): Promise<RefreshManagedWorktreeCacheResult> {
    try {
      const managed = await listManagedWorktrees(mainRoot);
      managedWorktreeCache = managed;
      return { ok: true, managed };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  }

  function getManagedNamesForCompletion(): string[] {
    return managedWorktreeCache.map((entry) => entry.name);
  }

  async function refreshManagedWorktreeCacheOrNotify(
    ctx: CommandContext,
    mainRoot?: string,
    action = "refresh managed worktree state",
  ): Promise<ManagedWorktreeState[] | null> {
    const refresh = await refreshManagedWorktreeCache(mainRoot);
    if (!refresh.ok) {
      ctx.ui.notify(`Failed to ${action}: ${refresh.error.message}`, "error");
      return null;
    }

    return refresh.managed;
  }

  function indexWorkspaceWindowsByName(windows: TmuxWorkspaceWindow[]): Map<string, TmuxWorkspaceWindow> {
    return new Map(windows.map((window) => [window.wsName, window]));
  }

  async function branchExists(mainRoot: string, branchRef: string): Promise<boolean> {
    const result = await runGit(["show-ref", "--verify", "--quiet", branchRef], { cwd: mainRoot });
    return result.code === 0;
  }

  async function resolveRef(cwd: string, ref: string): Promise<string | null> {
    const result = await runGit(["rev-parse", ref], { cwd });
    if (result.code !== 0) return null;

    const value = result.stdout.trim();
    return value.length > 0 ? value : null;
  }

  async function getMergeHead(cwd: string): Promise<string | null> {
    return resolveRef(cwd, "MERGE_HEAD");
  }

  async function worktreeIsDirty(cwd: string): Promise<{ dirty: boolean; error?: string }> {
    const result = await runGit(["status", "--porcelain"], { cwd });
    if (result.code !== 0) {
      return { dirty: false, error: formatExecError(result, "Failed to inspect Git status.") };
    }

    return { dirty: result.stdout.trim().length > 0 };
  }

  async function listUnmergedFiles(cwd: string): Promise<string[]> {
    const result = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd });
    if (result.code !== 0) return [];

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function createManagedWorktree(name: string, wsPath: string, baseBranch: string, mainRoot: string): Promise<GitResult> {
    return runGit([
      "worktree",
      "add",
      "-b",
      shortBranchName(managedBranchRef(name)),
      wsPath,
      baseBranch,
    ], {
      cwd: mainRoot,
      timeout: LONG_GIT_TIMEOUT,
    });
  }

  async function removeManagedWorktree(wsPath: string, mainRoot: string): Promise<GitResult> {
    return runGit(["worktree", "remove", wsPath], {
      cwd: mainRoot,
      timeout: LONG_GIT_TIMEOUT,
    });
  }

  async function deleteManagedBranch(name: string, mainRoot: string, force = false): Promise<GitResult> {
    return runGit(["branch", force ? "-D" : "-d", shortBranchName(managedBranchRef(name))], {
      cwd: mainRoot,
      timeout: LONG_GIT_TIMEOUT,
    });
  }

  async function rollbackCreate(name: string, wsPath: string, mainRoot: string): Promise<void> {
    if (existsSync(wsPath)) {
      await removeManagedWorktree(wsPath, mainRoot);
    }
    await deleteManagedBranch(name, mainRoot, true);
    await unsetBaseBranch(name, mainRoot);
  }

  async function cleanupManagedWorktree(
    worktree: ManagedWorktreeState,
    mainRoot: string,
    ctx: CommandContext,
    existingWindow?: TmuxWorkspaceWindow | null,
  ): Promise<boolean> {
    const window = existingWindow ?? indexWorkspaceWindowsByName(await listWorkspaceWindows(pi)).get(worktree.name) ?? null;
    if (window) {
      const killed = await killWindow(pi, window.windowId);
      if (!killed) {
        ctx.ui.notify(`Could not close tmux window for workspace '${worktree.name}'.`, "error");
        return false;
      }

      const windowsAfterKill = await listWorkspaceWindows(pi);
      if (windowsAfterKill.some((entry) => entry.windowId === window.windowId)) {
        ctx.ui.notify(`Could not close tmux window for workspace '${worktree.name}'.`, "error");
        return false;
      }
    }

    const removeResult = await removeManagedWorktree(worktree.path, mainRoot);
    if (removeResult.code !== 0) {
      ctx.ui.notify(
        formatExecError(removeResult, `Failed to remove worktree '${worktree.name}'.`),
        "error",
      );
      return false;
    }

    const deleteBranchResult = await deleteManagedBranch(worktree.name, mainRoot);
    if (deleteBranchResult.code !== 0) {
      ctx.ui.notify(
        formatExecError(deleteBranchResult, `Removed worktree '${worktree.name}', but failed to delete its branch.`),
        "error",
      );
      return false;
    }

    await unsetBaseBranch(worktree.name, mainRoot);
    managedWorktreeCache = managedWorktreeCache.filter((entry) => entry.name !== worktree.name);

    const summaryResult = await runGit(["log", "--oneline", "-n", "4"], { cwd: mainRoot });
    const summary = summaryResult.code === 0 ? summaryResult.stdout.trim() : "";
    const message = [
      `Finished workspace ${worktree.name}, merged into ${worktree.baseBranch ?? "<unknown>"}, removed worktree ${worktree.path}, deleted branch ${shortBranchName(worktree.branchRef)}.`,
      summary ? `Recent history:\n${summary}` : "",
    ].filter(Boolean).join("\n\n");

    ctx.ui.notify(message, "info");
    return true;
  }

  await refreshManagedWorktreeCache();

  pi.registerCommand("ws-create", {
    description: "Create a Git worktree and open it in a tmux window",
    handler: async (args: string, ctx: CommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ws-create <name>", "error");
        return;
      }

      if (!isValidWorkspaceName(name)) {
        ctx.ui.notify(`Invalid workspace name '${name}'.`, "error");
        return;
      }

      const tmuxError = await ensureTmuxReady();
      if (tmuxError) {
        ctx.ui.notify(tmuxError, "error");
        return;
      }

      let roots: { checkoutRoot: string; mainRoot: string };
      try {
        roots = await getWorktreeRoots(process.cwd());
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (resolve(roots.checkoutRoot) !== resolve(roots.mainRoot)) {
        ctx.ui.notify("/ws-create must be run from the main worktree.", "error");
        return;
      }

      const currentBranchRef = await getCurrentBranchRef(roots.mainRoot);
      if (!currentBranchRef) {
        ctx.ui.notify("/ws-create requires the main worktree to be on a branch, not detached HEAD.", "error");
        return;
      }
      const baseBranch = shortBranchName(currentBranchRef);

      if (await getMergeHead(roots.mainRoot)) {
        ctx.ui.notify("Cannot create a workspace while a merge is in progress in the main worktree.", "error");
        return;
      }

      const managed = await refreshManagedWorktreeCacheOrNotify(ctx, roots.mainRoot, "load managed worktrees");
      if (!managed) return;
      if (managed.some((entry) => entry.name === name)) {
        ctx.ui.notify(`Workspace '${name}' already exists.`, "error");
        return;
      }

      const branchRef = managedBranchRef(name);
      if (await branchExists(roots.mainRoot, branchRef)) {
        ctx.ui.notify(`Managed branch '${shortBranchName(branchRef)}' already exists.`, "error");
        return;
      }

      const wsPath = resolve(roots.mainRoot, "..", `${basename(roots.mainRoot)}-ws-${name}`);
      if (existsSync(wsPath)) {
        ctx.ui.notify(`Workspace path already exists on disk: ${wsPath}`, "error");
        return;
      }

      const createResult = await createManagedWorktree(name, wsPath, baseBranch, roots.mainRoot);
      if (createResult.code !== 0) {
        ctx.ui.notify(formatExecError(createResult, `Failed to create workspace '${name}'.`), "error");
        return;
      }

      const configResult = await setBaseBranch(name, baseBranch, roots.mainRoot);
      if (configResult.code !== 0) {
        await rollbackCreate(name, wsPath, roots.mainRoot);
        ctx.ui.notify(formatExecError(configResult, `Failed to record base branch for '${name}'.`), "error");
        return;
      }

      const windowResult = await createWorkspaceWindow(pi, {
        wsName: name,
        cwd: wsPath,
        continueRecent: false,
      });
      if (!windowResult.ok) {
        await rollbackCreate(name, wsPath, roots.mainRoot);
        ctx.ui.notify(windowResult.error, "error");
        return;
      }

      managedWorktreeCache = [
        ...managedWorktreeCache.filter((entry) => entry.name !== name),
        { name, path: wsPath, branchRef, head: "", baseBranch },
      ];
      ctx.ui.notify(
        `Created worktree '${name}' at ${wsPath}. Opened tmux window ws:${name}.`,
        "info",
      );
      if (!windowResult.selected) {
        ctx.ui.notify(`Created workspace window ws:${name}, but could not select it automatically.`, "warning");
      }
    },
  });

  pi.registerCommand("ws-list", {
    description: "List managed Git worktrees and tmux window state",
    handler: async (_args: string, ctx: CommandContext) => {
      const tmuxError = await ensureTmuxReady();
      if (tmuxError) {
        ctx.ui.notify(tmuxError, "error");
        return;
      }

      const managed = await refreshManagedWorktreeCacheOrNotify(ctx, undefined, "load managed worktrees");
      if (!managed) return;

      if (managed.length === 0) {
        ctx.ui.notify("No managed Git worktrees found.", "info");
        return;
      }

      const windowsByName = indexWorkspaceWindowsByName(await listWorkspaceWindows(pi));
      const lines: string[] = [];
      for (const worktree of managed.sort((a, b) => a.name.localeCompare(b.name))) {
        const window = windowsByName.get(worktree.name) ?? null;
        const relPath = relative(process.cwd(), worktree.path) || worktree.path;
        lines.push(`- ${worktree.name}`);
        lines.push(`  path: ${relPath === "" ? worktree.path : relPath}`);
        lines.push(`  branch: ${shortBranchName(worktree.branchRef)}`);
        lines.push(`  base branch: ${worktree.baseBranch ?? "<unknown>"}`);
        lines.push(`  window: ${window ? formatWindowStatus(window.active) : "missing"}`);
        if (!worktree.baseBranch) {
          lines.push("  repair: missing base branch config");
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ws-switch", {
    description: "Switch to an existing Git worktree tmux window",
    getArgumentCompletions(prefix: string) {
      return workspaceCompletionItems(getManagedNamesForCompletion(), prefix);
    },
    handler: async (args: string, ctx: CommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ws-switch <name>", "error");
        return;
      }

      if (!isValidWorkspaceName(name)) {
        ctx.ui.notify(`Invalid workspace name '${name}'.`, "error");
        return;
      }

      const tmuxError = await ensureTmuxReady();
      if (tmuxError) {
        ctx.ui.notify(tmuxError, "error");
        return;
      }

      const managed = await refreshManagedWorktreeCacheOrNotify(ctx, undefined, "load managed worktrees");
      if (!managed) return;
      const worktree = managed.find((entry) => entry.name === name) ?? null;
      if (!worktree) {
        ctx.ui.notify(`Workspace '${name}' does not exist.`, "error");
        return;
      }

      const windowsByName = indexWorkspaceWindowsByName(await listWorkspaceWindows(pi));
      const existingWindow = windowsByName.get(name) ?? null;
      if (existingWindow) {
        const selected = await selectWindow(pi, existingWindow.windowId);
        if (!selected) {
          ctx.ui.notify(`Found tmux window for workspace '${name}', but could not select it.`, "error");
          return;
        }

        ctx.ui.notify(`Switched to existing tmux window for workspace '${name}'.`, "info");
        return;
      }

      if (!existsSync(worktree.path)) {
        ctx.ui.notify(`Workspace path does not exist on disk: ${worktree.path}`, "error");
        return;
      }

      const windowResult = await createWorkspaceWindow(pi, {
        wsName: name,
        cwd: worktree.path,
        continueRecent: true,
      });
      if (!windowResult.ok) {
        ctx.ui.notify(windowResult.error, "error");
        return;
      }

      ctx.ui.notify(`Re-created tmux window for workspace '${name}'.`, "info");
      if (!windowResult.selected) {
        ctx.ui.notify(`Created workspace window ws:${name}, but could not select it automatically.`, "warning");
      }
    },
  });

  pi.registerCommand("ws-finish", {
    description: "Merge a managed Git worktree, remove it, and clean up",
    getArgumentCompletions(prefix: string) {
      return workspaceCompletionItems(getManagedNamesForCompletion(), prefix);
    },
    handler: async (args: string, ctx: CommandContext) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ws-finish <name>", "error");
        return;
      }

      if (!isValidWorkspaceName(name)) {
        ctx.ui.notify(`Invalid workspace name '${name}'.`, "error");
        return;
      }

      const tmuxError = await ensureTmuxReady();
      if (tmuxError) {
        ctx.ui.notify(tmuxError, "error");
        return;
      }

      let roots: { checkoutRoot: string; mainRoot: string };
      try {
        roots = await getWorktreeRoots(process.cwd());
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (resolve(roots.checkoutRoot) !== resolve(roots.mainRoot)) {
        ctx.ui.notify("/ws-finish must be run from the main worktree.", "error");
        return;
      }

      const managed = await refreshManagedWorktreeCacheOrNotify(ctx, roots.mainRoot, "load managed worktrees");
      if (!managed) return;
      const worktree = managed.find((entry) => entry.name === name) ?? null;
      if (!worktree) {
        ctx.ui.notify(`Workspace '${name}' does not exist.`, "error");
        return;
      }

      if (!worktree.baseBranch) {
        ctx.ui.notify(
          `Workspace '${name}' is missing its recorded base branch. Repair ${configKey(name)} before finishing.`,
          "error",
        );
        return;
      }

      const currentBranch = await getCurrentBranch(roots.mainRoot);
      if (currentBranch !== worktree.baseBranch) {
        ctx.ui.notify(
          `/ws-finish must be run from branch '${worktree.baseBranch}'. Current branch: ${currentBranch ?? "<detached>"}.`,
          "error",
        );
        return;
      }

      const linkedBranchRef = await getCurrentBranchRef(worktree.path);
      if (!linkedWorktreeOnManagedBranch(linkedBranchRef, name)) {
        ctx.ui.notify(
          `Linked worktree '${name}' is no longer on ${shortBranchName(managedBranchRef(name))}. Repair it manually before finishing.`,
          "error",
        );
        return;
      }

      const mergeHead = await getMergeHead(roots.mainRoot);
      const managedHead = await resolveRef(roots.mainRoot, worktree.branchRef);
      if (mergeHead) {
        if (!managedHead || mergeHead !== managedHead) {
          ctx.ui.notify("Another merge is already in progress in the main worktree.", "error");
          return;
        }

        const unresolvedFiles = await listUnmergedFiles(roots.mainRoot);
        if (unresolvedFiles.length > 0) {
          ctx.ui.notify(
            `Cannot finish workspace '${name}': unresolved merge conflicts remain in ${unresolvedFiles.join(", ")}.`,
            "error",
          );
          return;
        }

        const commitResult = await runGit(["commit", "--no-edit"], {
          cwd: roots.mainRoot,
          timeout: LONG_GIT_TIMEOUT,
        });
        if (commitResult.code !== 0) {
          ctx.ui.notify(formatExecError(commitResult, `Failed to finalize merge for '${name}'.`), "error");
          return;
        }

        const windowsByName = indexWorkspaceWindowsByName(await listWorkspaceWindows(pi));
        await cleanupManagedWorktree(worktree, roots.mainRoot, ctx, windowsByName.get(worktree.name) ?? null);
        return;
      }

      const linkedDirty = await worktreeIsDirty(worktree.path);
      if (linkedDirty.error) {
        ctx.ui.notify(linkedDirty.error, "error");
        return;
      }
      if (linkedDirty.dirty) {
        ctx.ui.notify(
          `Workspace '${name}' has uncommitted changes. Commit or stash them in ${worktree.path} before finishing.`,
          "error",
        );
        return;
      }

      const mainDirty = await worktreeIsDirty(roots.mainRoot);
      if (mainDirty.error) {
        ctx.ui.notify(mainDirty.error, "error");
        return;
      }
      if (mainDirty.dirty) {
        ctx.ui.notify("The main worktree has uncommitted changes. Clean it before finishing a workspace.", "error");
        return;
      }

      const alreadyMerged = await runGit(["merge-base", "--is-ancestor", worktree.branchRef, "HEAD"], {
        cwd: roots.mainRoot,
      });
      if (alreadyMerged.code === 0) {
        const windowsByName = indexWorkspaceWindowsByName(await listWorkspaceWindows(pi));
        await cleanupManagedWorktree(worktree, roots.mainRoot, ctx, windowsByName.get(worktree.name) ?? null);
        return;
      }
      if (alreadyMerged.code !== 1) {
        ctx.ui.notify(formatExecError(alreadyMerged, `Failed to compare merge state for '${name}'.`), "error");
        return;
      }

      const mergeResult = await runGit([
        "merge",
        "--no-ff",
        "--no-edit",
        "-m",
        `finish workspace ${name}`,
        worktree.branchRef,
      ], {
        cwd: roots.mainRoot,
        timeout: LONG_GIT_TIMEOUT,
      });
      if (mergeResult.code === 0) {
        const windowsByName = indexWorkspaceWindowsByName(await listWorkspaceWindows(pi));
        await cleanupManagedWorktree(worktree, roots.mainRoot, ctx, windowsByName.get(worktree.name) ?? null);
        return;
      }

      const mergeHeadAfterFailure = await getMergeHead(roots.mainRoot);
      if (!mergeHeadAfterFailure) {
        ctx.ui.notify(formatExecError(mergeResult, `Failed to merge workspace '${name}'.`), "error");
        return;
      }

      const conflictedFiles = await listUnmergedFiles(roots.mainRoot);
      if (conflictedFiles.length === 0) {
        ctx.ui.notify(formatExecError(mergeResult, `Failed to merge workspace '${name}'.`), "error");
        return;
      }

      const resolveWithModel = await ctx.ui.confirm(
        "Merge conflict detected",
        [
          `Merge produced conflicts in: ${conflictedFiles.join(", ")}`,
          "",
          "Would you like the session model to attempt resolving the conflicts?",
          `If not, the merge will be aborted and you can retry /ws-finish ${name} later.`,
        ].join("\n"),
      );

      if (!resolveWithModel) {
        const abortResult = await runGit(["merge", "--abort"], {
          cwd: roots.mainRoot,
          timeout: LONG_GIT_TIMEOUT,
        });
        if (abortResult.code !== 0) {
          ctx.ui.notify(formatExecError(abortResult, `Merge conflict detected while finishing ${name}.`), "error");
          return;
        }

        ctx.ui.notify(
          `Merge conflict detected while finishing ${name}. Merge aborted. Resolve in the worktree and retry.`,
          "error",
        );
        return;
      }

      pi.sendUserMessage([
        `The merge while finishing workspace '${name}' produced conflicts in: ${conflictedFiles.join(", ")}.`,
        "",
        "Please resolve these Git merge conflicts in the main worktree:",
        "1. Read each conflicted file and inspect the Git conflict markers",
        "2. Edit each file to remove the conflict markers and keep the correct content",
        `3. After resolving all conflicted files, tell me to run \`/ws-finish ${name}\` again to finalize the merge and clean up the worktree`,
        "",
        "Git conflict markers look like:",
        "```",
        "<<<<<<< HEAD",
        "current branch content",
        "=======",
        `worktree branch content from ${shortBranchName(worktree.branchRef)}`,
        `>>>>>>> ${shortBranchName(worktree.branchRef)}`,
        "```",
      ].join("\n"));

      ctx.ui.notify(
        `Merge conflict in: ${conflictedFiles.join(", ")}. Asking model to resolve. Run /ws-finish ${name} again after resolution.`,
        "warning",
      );
    },
  });
}
