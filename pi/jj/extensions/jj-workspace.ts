import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { existsSync, rmSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import {
  createWorkspaceWindow,
  findWorkspaceWindow,
  inTmuxEnv,
  killWindow,
  listWorkspaceWindows,
  parseTmuxVersion,
  selectWindow,
} from "../lib/tmux-workspaces.ts";
import {
  JJ_WORKSPACE_COMMANDS,
  isValidWorkspaceName,
  parseWorkspaceHeads,
  parseWorkspaceNameFromOutput,
  type WorkspaceHead,
} from "../lib/workspace.ts";
import { isJjRepo } from "../lib/utils.ts";

interface WorkspaceChange {
  changeId: string;
  description: string;
  empty: boolean;
  conflict: boolean;
}

interface JjResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface CommandContext {
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
}

const DEFAULT_JJ_TIMEOUT = 20_000;
const LONG_JJ_TIMEOUT = 60_000;
const MIN_TMUX_VERSION = 3.2;

function parseBoolean(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error(`Expected 'true' or 'false', got '${trimmed}'`);
}

function isAncestorOrSame(candidate: string, target: string): boolean {
  const rel = relative(candidate, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function workspaceCompletionItems(names: string[], prefix: string): AutocompleteItem[] | null {
  const current = prefix.trim();
  const filtered = names
    .filter((name) => name.startsWith(current))
    .sort()
    .map((name) => ({ value: name, label: name }));

  return filtered.length > 0 ? filtered : null;
}

export default async function(pi: ExtensionAPI) {
  const defaultCwd = process.cwd();
  if (!isJjRepo(defaultCwd)) return;

  let workspaceHeadsCache: WorkspaceHead[] = [];

  async function runJj(
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<JjResult> {
    const result = await pi.exec("jj", ["--color=never", ...args], {
      cwd: options?.cwd ?? process.cwd(),
      timeout: options?.timeout ?? DEFAULT_JJ_TIMEOUT,
    });

    if (result.killed) {
      const command = `jj ${args.join(" ")}`;
      return {
        stdout: result.stdout ?? "",
        stderr: `Command timed out: ${command}`,
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

  async function listWorkspaceHeads(): Promise<WorkspaceHead[]> {
    const result = await pi.exec("jj", [...JJ_WORKSPACE_COMMANDS.workspaceList], {
      cwd: process.cwd(),
      timeout: DEFAULT_JJ_TIMEOUT,
    });

    if (result.killed) {
      throw new Error("Command timed out: jj workspace list");
    }

    if (result.code !== 0) {
      throw new Error((result.stderr ?? "").trim() || "Failed to list workspaces");
    }

    return parseWorkspaceHeads(result.stdout ?? "");
  }

  async function refreshWorkspaceHeadsCache() {
    try {
      workspaceHeadsCache = await listWorkspaceHeads();
    } catch {
      workspaceHeadsCache = [];
    }
  }

  async function resolveWorkspacePath(name: string): Promise<string | null> {
    const result = await runJj(["workspace", "root", "--name", name]);
    if (result.code !== 0) return null;

    const resolvedPath = result.stdout.trim();
    return resolvedPath.length > 0 ? resolvedPath : null;
  }

  function getWorkspaceNamesForCompletion(): string[] {
    return workspaceHeadsCache
      .filter((ws) => ws.name !== "default")
      .map((ws) => ws.name);
  }

  async function getCurrentNamedWorkspace(cwd: string): Promise<string | null> {
    const changeResult = await pi.exec("jj", [...JJ_WORKSPACE_COMMANDS.currentChangeId], {
      cwd,
      timeout: DEFAULT_JJ_TIMEOUT,
    });

    if (changeResult.killed) {
      throw new Error("Command timed out: jj log -r @ -T change_id --no-graph");
    }

    if (changeResult.code !== 0) {
      throw new Error((changeResult.stderr ?? "").trim() || "Failed to determine current workspace change id.");
    }

    const workspaceListResult = await pi.exec("jj", [...JJ_WORKSPACE_COMMANDS.workspaceList], {
      cwd,
      timeout: DEFAULT_JJ_TIMEOUT,
    });

    if (workspaceListResult.killed) {
      throw new Error("Command timed out: jj workspace list");
    }

    if (workspaceListResult.code !== 0) {
      throw new Error((workspaceListResult.stderr ?? "").trim() || "Failed to determine current workspace.");
    }

    return parseWorkspaceNameFromOutput(
      (changeResult.stdout ?? "").trim(),
      workspaceListResult.stdout ?? "",
    );
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
    const version = parseTmuxVersion(versionText);
    if (version === null) {
      return `Workspace commands require tmux 3.2 or later. Found: ${versionText || "unknown"}.`;
    }

    if (version < MIN_TMUX_VERSION) {
      return `Workspace commands require tmux 3.2 or later. Found: ${versionText || version.toString()}.`;
    }

    return null;
  }

  async function getUniqueWorkspaceChanges(name: string): Promise<WorkspaceChange[]> {
    const result = await runJj([
      "log",
      "-r",
      `ancestors(${name}@) & mutable() & ~ancestors(default@)`,
      "--no-graph",
      "-T",
      'change_id ++ "|" ++ description.first_line() ++ "|" ++ empty ++ "|" ++ conflict ++ "\\n"',
    ]);

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to query workspace commits");
    }

    const changes: WorkspaceChange[] = [];
    for (const rawLine of result.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const firstSep = line.indexOf("|");
      if (firstSep === -1) continue;
      const secondSep = line.indexOf("|", firstSep + 1);
      if (secondSep === -1) continue;
      const thirdSep = line.indexOf("|", secondSep + 1);
      if (thirdSep === -1) continue;

      const changeId = line.slice(0, firstSep).trim();
      const description = line.slice(firstSep + 1, secondSep).trim();
      const empty = parseBoolean(line.slice(secondSep + 1, thirdSep));
      const conflict = parseBoolean(line.slice(thirdSep + 1));
      if (!changeId) continue;

      changes.push({ changeId, description, empty, conflict });
    }

    return changes;
  }

  async function getConflictedFiles(): Promise<string[]> {
    const result = await runJj(["resolve", "--list", "-r", "@"]);
    if (result.code !== 0) return [];

    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\S+)/);
        return match ? match[1]! : "";
      })
      .filter(Boolean);
  }

  async function getPreMergeOpId(): Promise<string> {
    const result = await runJj(["op", "log", "-n", "1", "--no-graph", "-T", "id.short()"]);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to get operation id");
    }

    const opId = result.stdout.trim();
    if (!opId) throw new Error("Missing operation id");
    return opId;
  }

  async function safeDeleteWorkspaceDir(
    wsPath: string,
    repoRoot: string,
  ): Promise<{ deleted: boolean; reason?: string }> {
    const resolvedWsPath = resolve(wsPath);
    const resolvedRepoRoot = resolve(repoRoot);

    if (!basename(resolvedWsPath).includes("-ws-")) {
      return { deleted: false, reason: "Path basename does not include -ws-" };
    }

    if (resolvedWsPath === "/") {
      return { deleted: false, reason: "Refusing to delete root directory" };
    }

    if (resolvedWsPath === resolvedRepoRoot) {
      return { deleted: false, reason: "Refusing to delete repository root" };
    }

    if (isAncestorOrSame(resolvedWsPath, resolvedRepoRoot)) {
      return {
        deleted: false,
        reason: "Refusing to delete path that contains repository root",
      };
    }

    if (!existsSync(resolvedWsPath)) {
      return { deleted: false, reason: "Directory already missing" };
    }

    try {
      rmSync(resolvedWsPath, { recursive: true, force: false });
      return { deleted: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { deleted: false, reason };
    }
  }

  await refreshWorkspaceHeadsCache();

  pi.registerCommand("ws-create", {
    description: "Create a jj workspace and open it in a tmux window",
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

      let currentNamedWorkspace: string | null;
      try {
        currentNamedWorkspace = await getCurrentNamedWorkspace(process.cwd());
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (currentNamedWorkspace !== null) {
        ctx.ui.notify(
          `/ws-create must be run from the default workspace. Current workspace: ${currentNamedWorkspace}.`,
          "error",
        );
        return;
      }

      await refreshWorkspaceHeadsCache();
      if (workspaceHeadsCache.some((ws) => ws.name === name)) {
        ctx.ui.notify(`Workspace '${name}' already exists.`, "error");
        return;
      }

      const rootResult = await runJj(["root"]);
      if (rootResult.code !== 0) {
        ctx.ui.notify(rootResult.stderr.trim() || "Failed to determine repository root.", "error");
        return;
      }

      const defaultRoot = rootResult.stdout.trim();
      if (!defaultRoot) {
        ctx.ui.notify("Failed to determine repository root.", "error");
        return;
      }

      const wsPath = resolve(defaultRoot, "..", `${basename(defaultRoot)}-ws-${name}`);
      if (existsSync(wsPath)) {
        ctx.ui.notify(`Workspace path already exists on disk: ${wsPath}`, "error");
        return;
      }

      const createResult = await runJj(["workspace", "add", "--name", name, wsPath], {
        timeout: LONG_JJ_TIMEOUT,
      });
      if (createResult.code !== 0) {
        ctx.ui.notify(createResult.stderr.trim() || `Failed to create workspace '${name}'.`, "error");
        return;
      }

      const windowResult = await createWorkspaceWindow(pi, {
        wsName: name,
        cwd: wsPath,
        continueRecent: false,
      });

      if (!windowResult.ok) {
        await runJj(["workspace", "forget", name], { timeout: LONG_JJ_TIMEOUT });
        await safeDeleteWorkspaceDir(wsPath, defaultRoot);
        await refreshWorkspaceHeadsCache();
        ctx.ui.notify(windowResult.error, "error");
        return;
      }

      await refreshWorkspaceHeadsCache();
      const successMessage = [
        `Created workspace '${name}' at ${wsPath}.`,
        `Opened tmux window ws:${name}.`,
      ].join(" ");
      ctx.ui.notify(successMessage, "info");

      if (!windowResult.selected) {
        ctx.ui.notify(`Created workspace window ws:${name}, but could not select it automatically.`, "warning");
      }
    },
  });

  pi.registerCommand("ws-list", {
    description: "List non-default jj workspaces and tmux window state",
    handler: async (_args: string, ctx: CommandContext) => {
      const tmuxError = await ensureTmuxReady();
      if (tmuxError) {
        ctx.ui.notify(tmuxError, "error");
        return;
      }

      await refreshWorkspaceHeadsCache();
      const nonDefault = workspaceHeadsCache.filter((ws) => ws.name !== "default");
      if (nonDefault.length === 0) {
        ctx.ui.notify("No non-default workspaces found.", "info");
        return;
      }

      const windows = await listWorkspaceWindows(pi);
      const pathEntries = await Promise.all(nonDefault.map(async (ws) => ({
        ws,
        wsPath: await resolveWorkspacePath(ws.name),
        window: windows.find((window) => window.wsName === ws.name) ?? null,
      })));

      const lines: string[] = [];
      for (const entry of pathEntries) {
        const status = entry.window
          ? (entry.window.active ? "open (active window)" : "open")
          : "—";

        lines.push(`- ${entry.ws.name}`);
        lines.push(`  path: ${entry.wsPath ?? "<missing>"}`);
        lines.push(`  change: ${entry.ws.changeId}`);
        lines.push(`  window: ${status}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ws-switch", {
    description: "Switch to an existing jj workspace tmux window",
    getArgumentCompletions(prefix: string) {
      return workspaceCompletionItems(getWorkspaceNamesForCompletion(), prefix);
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

      await refreshWorkspaceHeadsCache();
      if (!workspaceHeadsCache.some((ws) => ws.name === name)) {
        ctx.ui.notify(`Workspace '${name}' does not exist.`, "error");
        return;
      }

      const existingWindow = await findWorkspaceWindow(pi, name);
      if (existingWindow) {
        const selected = await selectWindow(pi, existingWindow.windowId);
        if (!selected) {
          ctx.ui.notify(`Found tmux window for workspace '${name}', but could not select it.`, "error");
          return;
        }

        ctx.ui.notify(`Switched to existing tmux window for workspace '${name}'.`, "info");
        return;
      }

      const wsPath = await resolveWorkspacePath(name);
      if (!wsPath) {
        ctx.ui.notify(`Could not resolve path for workspace '${name}'.`, "error");
        return;
      }

      if (!existsSync(wsPath)) {
        ctx.ui.notify(`Workspace path does not exist on disk: ${wsPath}`, "error");
        return;
      }

      const windowResult = await createWorkspaceWindow(pi, {
        wsName: name,
        cwd: wsPath,
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
    description: "Merge a workspace into default, forget it, and clean up",
    getArgumentCompletions(prefix: string) {
      return workspaceCompletionItems(getWorkspaceNamesForCompletion(), prefix);
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

      if (name === "default") {
        ctx.ui.notify("Refusing to finish the default workspace.", "error");
        return;
      }

      const tmuxError = await ensureTmuxReady();
      if (tmuxError) {
        ctx.ui.notify(tmuxError, "error");
        return;
      }

      let currentNamedWorkspace: string | null;
      try {
        currentNamedWorkspace = await getCurrentNamedWorkspace(process.cwd());
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (currentNamedWorkspace !== null) {
        ctx.ui.notify(
          `/ws-finish must be run from the default workspace. Current workspace: ${currentNamedWorkspace}.`,
          "error",
        );
        return;
      }

      await refreshWorkspaceHeadsCache();
      if (!workspaceHeadsCache.some((ws) => ws.name === name)) {
        ctx.ui.notify(`Workspace '${name}' does not exist.`, "error");
        return;
      }

      const wsPath = await resolveWorkspacePath(name);
      if (!wsPath) {
        ctx.ui.notify(`Could not resolve path for workspace '${name}'.`, "error");
        return;
      }

      const existingWindow = await findWorkspaceWindow(pi, name);
      if (existingWindow) {
        const confirmedWindowClose = await ctx.ui.confirm(
          "Close workspace window",
          `Workspace '${name}' has an open tmux window. Close it before finishing?`,
        );
        if (!confirmedWindowClose) {
          ctx.ui.notify("Cancelled workspace finish.", "info");
          return;
        }

        await killWindow(pi, existingWindow.windowId);
        const afterKill = await findWorkspaceWindow(pi, name);
        if (afterKill) {
          ctx.ui.notify(`Could not close tmux window for workspace '${name}'.`, "error");
          return;
        }
      }

      const snapshotResult = await runJj(["status"], {
        cwd: wsPath,
        timeout: LONG_JJ_TIMEOUT,
      });
      if (snapshotResult.code !== 0) {
        ctx.ui.notify(
          snapshotResult.stderr.trim() || `Failed to snapshot workspace '${name}' before finish.`,
          "error",
        );
        return;
      }

      const snapshotHasChanges = !snapshotResult.stdout.includes("The working copy has no changes.");
      if (snapshotHasChanges) {
        const confirmedSnapshot = await ctx.ui.confirm(
          "Merge snapshotted workspace changes",
          [
            `Snapshot detected working-copy changes in ${wsPath}.`,
            "These changes have been snapshotted into jj and will be merged into default.",
            "Continue?",
          ].join("\n\n"),
        );
        if (!confirmedSnapshot) {
          ctx.ui.notify("Cancelled workspace finish after snapshot.", "info");
          return;
        }
      }

      let changes: WorkspaceChange[];
      try {
        changes = await getUniqueWorkspaceChanges(name);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        return;
      }

      if (changes.some((change) => change.conflict)) {
        ctx.ui.notify(
          `Workspace '${name}' has conflicted commits. Resolve conflicts in the workspace and retry.`,
          "error",
        );
        return;
      }

      if (changes.some((change) => !change.empty)) {
        const defaultEmptyResult = await runJj(["log", "-r", "default@", "--no-graph", "-T", "empty"]);
        if (defaultEmptyResult.code === 0 && defaultEmptyResult.stdout.trim() !== "true") {
          ctx.ui.notify(
            "The default workspace has uncommitted changes. Commit or stash them before finishing a workspace.",
            "error",
          );
          return;
        }
      }

      if (changes.length > 0 && changes.every((change) => change.empty)) {
        const abandonedIds = new Set(changes.map((change) => change.changeId));
        const abandonResult = await runJj(["abandon", ...abandonedIds], { timeout: LONG_JJ_TIMEOUT });
        if (abandonResult.code !== 0) {
          ctx.ui.notify(
            abandonResult.stderr.trim() || `Failed to clean empty commits in workspace '${name}'.`,
            "error",
          );
          return;
        }

        try {
          changes = await getUniqueWorkspaceChanges(name);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }

        const newChanges = changes.filter((change) => !abandonedIds.has(change.changeId));
        if (newChanges.length > 0) {
          ctx.ui.notify(
            `Warning: ${newChanges.length} new commit(s) appeared in workspace '${name}' during cleanup. They will be included in the merge.`,
            "warning",
          );
        }
      }

      if (changes.length > 0) {
        let preMergeOpId: string;
        try {
          preMergeOpId = await getPreMergeOpId();
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
          return;
        }

        const headsResult = await runJj([
          "log",
          "-r",
          `heads(ancestors(${name}@) & mutable() & ~ancestors(default@) & ~empty())`,
          "--no-graph",
          "-T",
          'change_id ++ "\\n"',
        ]);
        if (headsResult.code !== 0) {
          ctx.ui.notify(
            headsResult.stderr.trim() || `Failed to determine workspace head commits for '${name}'.`,
            "error",
          );
          return;
        }

        const headIds = headsResult.stdout
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);
        const mergeParents = headIds.length > 0 ? headIds : [`${name}@`];

        const mergeResult = await runJj([
          "new",
          "default@",
          ...mergeParents,
          "-m",
          `finish workspace ${name}`,
        ], { timeout: LONG_JJ_TIMEOUT });
        if (mergeResult.code !== 0) {
          ctx.ui.notify(mergeResult.stderr.trim() || `Failed to merge workspace '${name}'.`, "error");
          return;
        }

        const conflictResult = await runJj([
          "log",
          "-r",
          "@",
          "--no-graph",
          "-T",
          'conflict ++ "|" ++ change_id.short() ++ "\\n"',
        ]);
        if (conflictResult.code !== 0) {
          ctx.ui.notify(
            conflictResult.stderr.trim() || "Failed to verify merge conflict status.",
            "error",
          );
          return;
        }

        const currentConflictLine = conflictResult.stdout.trim().split("\n")[0] ?? "";
        const conflictFlag = currentConflictLine.split("|")[0] ?? "";

        let hasConflict: boolean;
        try {
          hasConflict = parseBoolean(conflictFlag);
        } catch {
          await runJj(["op", "restore", preMergeOpId], { timeout: LONG_JJ_TIMEOUT });
          ctx.ui.notify(
            `Unexpected conflict status '${conflictFlag}' after merge. Repository restored to pre-finish state.`,
            "error",
          );
          return;
        }

        if (hasConflict) {
          const conflictedFiles = await getConflictedFiles();
          const fileList = conflictedFiles.length > 0
            ? conflictedFiles.join(", ")
            : "unknown files";

          const resolveWithModel = await ctx.ui.confirm(
            "Merge conflict detected",
            [
              `Merge produced conflicts in: ${fileList}`,
              "",
              "Would you like the session model to attempt resolving the conflicts?",
              "If not, the repository will be restored to its pre-finish state.",
            ].join("\n"),
          );

          if (!resolveWithModel) {
            await runJj(["op", "restore", preMergeOpId], { timeout: LONG_JJ_TIMEOUT });
            ctx.ui.notify(
              `Merge conflict detected while finishing ${name}. Repository restored to pre-finish state. Resolve in workspace and retry.`,
              "error",
            );
            return;
          }

          // Keep the merge commit and ask the model to resolve conflicts
          pi.sendUserMessage([
            `The merge while finishing workspace '${name}' produced conflicts in: ${fileList}.`,
            "",
            "Please resolve these merge conflicts:",
            "1. Read each conflicted file to see the jj conflict markers",
            "2. Edit each file to resolve the conflicts — remove the conflict markers and keep the correct content",
            `3. After resolving all conflicts, tell me to run \`/ws-finish ${name}\` to complete the merge`,
            "",
            "jj conflict markers look like:",
            "```",
            "<<<<<<< conflict N of M",
            "%%%%%%% diff from: <base commit>",
            '\\\\\\\\\\\\\\        to: <side A commit>',
            "-old line",
            "+new line from A",
            "+++++++ <side B commit>",
            "content from side B",
            ">>>>>>> conflict N of M ends",
            "```",
          ].join("\n"));

          ctx.ui.notify(
            `Merge conflict in: ${fileList}. Asking model to resolve. Run /ws-finish ${name} again after resolution.`,
            "warning",
          );
          return;
        }
      }

      // Safety check: ensure default@ is not conflicted before forgetting.
      // This catches the case where a previous model-assisted conflict resolution
      // was incomplete and the user re-ran /ws-finish prematurely.
      const defaultConflictCheck = await runJj([
        "log", "-r", "default@", "--no-graph", "-T", "conflict",
      ]);
      if (defaultConflictCheck.code === 0 && defaultConflictCheck.stdout.trim() === "true") {
        ctx.ui.notify(
          `Cannot finish workspace '${name}': the default workspace has unresolved merge conflicts. Resolve conflicts and retry.`,
          "error",
        );
        return;
      }

      const forgetResult = await runJj(["workspace", "forget", name], { timeout: LONG_JJ_TIMEOUT });
      if (forgetResult.code !== 0) {
        ctx.ui.notify(
          forgetResult.stderr.trim() || `Merged workspace '${name}', but failed to forget it.`,
          "error",
        );
        return;
      }

      const repoRootResult = await runJj(["root"]);
      const repoRoot = repoRootResult.code === 0 ? repoRootResult.stdout.trim() : process.cwd();
      const deletion = await safeDeleteWorkspaceDir(wsPath, repoRoot);

      await refreshWorkspaceHeadsCache();

      const summaryResult = await runJj([
        "log",
        "-r",
        "ancestors(@, 4)",
        "--no-graph",
        "-T",
        'change_id.short() ++ " " ++ description.first_line() ++ "\\n"',
      ]);
      const summary = summaryResult.code === 0 ? summaryResult.stdout.trim() : "";

      const deletionText = deletion.deleted
        ? `deleted ${wsPath}`
        : `did not delete ${wsPath}${deletion.reason ? ` (${deletion.reason})` : ""}`;

      const message = [
        `Finished workspace ${name}, merged into default, forgot workspace, ${deletionText}.`,
        summary ? `Recent history:\n${summary}` : "",
      ].filter(Boolean).join("\n\n");

      ctx.ui.notify(message, "info");
      if (!deletion.deleted) {
        ctx.ui.notify(`Warning: could not delete workspace directory ${wsPath}: ${deletion.reason}`, "warning");
      }
    },
  });
}
