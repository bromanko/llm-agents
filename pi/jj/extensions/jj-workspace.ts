import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { existsSync, rmSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { isJjRepo } from "../lib/utils.ts";

interface WorkspaceRef {
  name: string;
  path: string;
}

interface WorkspaceHead {
  name: string;
  changeId: string;
}

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

const DEFAULT_JJ_TIMEOUT = 20_000;
const LONG_JJ_TIMEOUT = 60_000;

const WORKSPACE_STATE_ENTRY = "jj-workspace-state";
const WORKSPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const WORKSPACE_NAME_MAX_LENGTH = 128;
const CWD_LINE_RE = /^Current working directory: .*$/gm;

function isValidWorkspaceName(name: string): boolean {
  return name.length <= WORKSPACE_NAME_MAX_LENGTH && WORKSPACE_NAME_RE.test(name);
}

interface Tool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  operations?: BashOperations;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<unknown>>;
}

type ToolFactory = (cwd: string) => Tool;

interface ToolFactories {
  createReadTool: ToolFactory;
  createWriteTool: ToolFactory;
  createEditTool: ToolFactory;
  createBashTool: ToolFactory;
}

function createFallbackToolFactory(name: string): ToolFactory {
  return (cwd: string): Tool => ({
    name,
    label: name,
    description: `Fallback ${name} tool (extension test mode)`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    operations: { exec: async () => ({ exitCode: 0 }) },
    async execute() {
      return {
        content: [
          {
            type: "text" as const,
            text: `${name} fallback executed in ${cwd}`,
          },
        ],
        details: undefined,
      };
    },
  });
}

async function loadToolFactories(): Promise<ToolFactories> {
  try {
    const mod = await import("@mariozechner/pi-coding-agent");

    if (
      typeof mod.createReadTool === "function"
      && typeof mod.createWriteTool === "function"
      && typeof mod.createEditTool === "function"
      && typeof mod.createBashTool === "function"
    ) {
      return {
        createReadTool: mod.createReadTool as ToolFactory,
        createWriteTool: mod.createWriteTool as ToolFactory,
        createEditTool: mod.createEditTool as ToolFactory,
        createBashTool: mod.createBashTool as ToolFactory,
      };
    }
  } catch {
    // Tests run without @mariozechner/pi-coding-agent installed as an npm dependency.
  }

  return {
    createReadTool: createFallbackToolFactory("read"),
    createWriteTool: createFallbackToolFactory("write"),
    createEditTool: createFallbackToolFactory("edit"),
    createBashTool: createFallbackToolFactory("bash"),
  };
}

function parseBoolean(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error(`Expected 'true' or 'false', got '${trimmed}'`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type SavedWorkspaceResult =
  | { status: "found"; workspace: WorkspaceRef }
  | { status: "cleared" }
  | { status: "absent" };

function parseSavedWorkspace(entries: unknown[]): SavedWorkspaceResult {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!isObject(entry)) continue;

    const customType = typeof entry.customType === "string"
      ? entry.customType
      : (typeof entry.type === "string" && entry.type === WORKSPACE_STATE_ENTRY
        ? entry.type
        : undefined);

    if (customType !== WORKSPACE_STATE_ENTRY) continue;

    const data = (entry as { data?: unknown }).data;
    if (data === null || data === undefined) return { status: "cleared" };
    if (!isObject(data)) return { status: "cleared" };

    const name = data.name;
    const path = data.path;
    if (typeof name !== "string" || typeof path !== "string") return { status: "cleared" };

    return { status: "found", workspace: { name, path } };
  }

  return { status: "absent" };
}

function isAncestorOrSame(candidate: string, target: string): boolean {
  const rel = relative(candidate, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export default async function(pi: ExtensionAPI) {
  const defaultCwd = process.cwd();
  if (!isJjRepo(defaultCwd)) return;

  const {
    createReadTool,
    createWriteTool,
    createEditTool,
    createBashTool,
  } = await loadToolFactories();

  let activeCwd = defaultCwd;
  let activeWorkspace: WorkspaceRef | null = null;
  let workspaceHeadsCache: WorkspaceHead[] = [];

  function getActiveCwd(): string {
    return activeCwd;
  }

  async function runJj(
    args: string[],
    options?: { cwd?: string; timeout?: number },
  ): Promise<JjResult> {
    const result = await pi.exec("jj", ["--color=never", ...args], {
      cwd: options?.cwd ?? defaultCwd,
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

  function persistWorkspaceState(workspace: WorkspaceRef | null) {
    pi.appendEntry(WORKSPACE_STATE_ENTRY, workspace);
  }

  async function listWorkspaceHeads(): Promise<WorkspaceHead[]> {
    const result = await runJj([
      "workspace",
      "list",
      "-T",
      'name ++ "|" ++ self.target().change_id() ++ "\\n"',
    ]);

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "Failed to list workspaces");
    }

    const heads: WorkspaceHead[] = [];
    for (const rawLine of result.stdout.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;

      const sep = line.indexOf("|");
      if (sep === -1) continue;

      const name = line.slice(0, sep);
      const changeId = line.slice(sep + 1);
      if (!name || !changeId) continue;
      heads.push({ name, changeId });
    }

    return heads;
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

  function workspaceCompletionItems(
    names: string[],
    prefix: string,
  ): AutocompleteItem[] | null {
    const current = prefix.trim();
    const filtered = names
      .filter((name) => name.startsWith(current))
      .sort()
      .map((name) => ({ value: name, label: name }));

    return filtered.length > 0 ? filtered : null;
  }

  function getWorkspaceNamesForCompletion(): string[] {
    return workspaceHeadsCache
      .filter((ws) => ws.name !== "default")
      .map((ws) => ws.name);
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

      changes.push({
        changeId,
        description,
        empty,
        conflict,
      });
    }

    return changes;
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

  function setActiveWorkspace(workspace: WorkspaceRef | null) {
    activeWorkspace = workspace;
    activeCwd = workspace?.path ?? defaultCwd;
  }

  function registerToolOverride(toolFactory: ToolFactory) {
    const defaultTool = toolFactory(defaultCwd);
    let cachedCwd = defaultCwd;
    let cachedTool = defaultTool;

    pi.registerTool({
      ...defaultTool,
      async execute(
        toolCallId: string,
        params: unknown,
        signal: AbortSignal | undefined,
        onUpdate: AgentToolUpdateCallback | undefined,
        ctx: ExtensionContext,
      ) {
        const cwd = getActiveCwd();
        if (cwd !== cachedCwd) {
          cachedTool = toolFactory(cwd);
          cachedCwd = cwd;
        }
        return cachedTool.execute(toolCallId, params, signal, onUpdate, ctx);
      },
    });
  }

  registerToolOverride(createReadTool);
  registerToolOverride(createWriteTool);
  registerToolOverride(createEditTool);
  registerToolOverride(createBashTool);

  pi.on("user_bash", () => {
    if (!activeWorkspace) return;

    const bashTool = createBashTool(getActiveCwd());
    return { operations: bashTool.operations as BashOperations };
  });

  pi.registerCommand("ws-create", {
    description: "Create a jj workspace and switch tool CWD into it",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ws-create <name>", "error");
        return;
      }

      if (!isValidWorkspaceName(name)) {
        ctx.ui.notify(
          `Invalid workspace name '${name}'. Names must start with a letter or digit, contain only letters, digits, hyphens, and underscores, and be at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`,
          "error",
        );
        return;
      }

      const repoRootResult = await runJj(["root"]);
      if (repoRootResult.code !== 0) {
        ctx.ui.notify(
          repoRootResult.stderr.trim() || "Failed to determine repository root.",
          "error",
        );
        return;
      }

      const repoRoot = repoRootResult.stdout.trim();
      if (!repoRoot) {
        ctx.ui.notify("Failed to determine repository root.", "error");
        return;
      }

      const repoName = basename(repoRoot);
      const wsPath = resolve(repoRoot, "..", `${repoName}-ws-${name}`);

      if (existsSync(wsPath)) {
        ctx.ui.notify(
          `Workspace path already exists on disk: ${wsPath}`,
          "error",
        );
        return;
      }

      const createResult = await runJj(["workspace", "add", "--name", name, wsPath], { timeout: LONG_JJ_TIMEOUT });
      if (createResult.code !== 0) {
        ctx.ui.notify(createResult.stderr.trim() || `Failed to create workspace '${name}'.`, "error");
        return;
      }

      setActiveWorkspace({ name, path: wsPath });
      persistWorkspaceState(activeWorkspace);
      await refreshWorkspaceHeadsCache();

      ctx.ui.notify(`Switched to workspace ${name} at ${wsPath}`, "info");
    },
  });

  pi.registerCommand("ws-list", {
    description: "List non-default jj workspaces",
    handler: async (_args, ctx) => {
      await refreshWorkspaceHeadsCache();
      const nonDefault = workspaceHeadsCache.filter((ws) => ws.name !== "default");

      if (nonDefault.length === 0) {
        ctx.ui.notify("No non-default workspaces found.", "info");
        return;
      }

      const pathEntries = await Promise.all(
        nonDefault.map(async (ws) => ({
          ws,
          wsPath: await resolveWorkspacePath(ws.name),
        })),
      );

      const lines: string[] = [];
      for (const { ws, wsPath } of pathEntries) {
        const activeMarker = activeWorkspace?.name === ws.name ? " (active)" : "";

        lines.push(`- ${ws.name}${activeMarker}`);
        lines.push(`  path: ${wsPath ?? "<missing>"}`);
        lines.push(`  change: ${ws.changeId}`);
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("ws-switch", {
    description: "Switch to an existing jj workspace",
    getArgumentCompletions(prefix: string) {
      return workspaceCompletionItems(getWorkspaceNamesForCompletion(), prefix);
    },
    handler: async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.ui.notify("Usage: /ws-switch <name>", "error");
        return;
      }

      if (!isValidWorkspaceName(name)) {
        ctx.ui.notify(
          `Invalid workspace name '${name}'. Names must start with a letter or digit, contain only letters, digits, hyphens, and underscores, and be at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`,
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

      if (!existsSync(wsPath)) {
        ctx.ui.notify(`Workspace path does not exist on disk: ${wsPath}`, "error");
        return;
      }

      setActiveWorkspace({ name, path: wsPath });
      persistWorkspaceState(activeWorkspace);

      ctx.ui.notify(`Switched to workspace ${name} at ${wsPath}`, "info");
    },
  });

  pi.registerCommand("ws-default", {
    description: "Return to the default jj workspace without deleting others",
    handler: async (_args, ctx) => {
      const previous = activeWorkspace?.name;
      setActiveWorkspace(null);
      persistWorkspaceState(null);

      if (previous) {
        ctx.ui.notify(
          `Switched back to default workspace. Workspace ${previous} is preserved.`,
          "info",
        );
      } else {
        ctx.ui.notify("Already in default workspace.", "info");
      }
    },
  });

  pi.registerCommand("ws-finish", {
    description: "Merge a workspace into default, forget it, and clean up",
    getArgumentCompletions(prefix: string) {
      return workspaceCompletionItems(getWorkspaceNamesForCompletion(), prefix);
    },
    handler: async (args, ctx) => {
      const requested = args.trim();
      const name = requested || activeWorkspace?.name;
      if (!name) {
        ctx.ui.notify("Usage: /ws-finish <name> (or run inside an active workspace)", "error");
        return;
      }

      if (!isValidWorkspaceName(name)) {
        ctx.ui.notify(
          `Invalid workspace name '${name}'. Names must start with a letter or digit, contain only letters, digits, hyphens, and underscores, and be at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`,
          "error",
        );
        return;
      }

      if (name === "default") {
        ctx.ui.notify("Refusing to finish the default workspace.", "error");
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

      const confirmed = await ctx.ui.confirm(
        "Finish workspace",
        [
          `Finish workspace '${name}'?`,
          "",
          "This will merge changes into default, forget the workspace, and delete:",
          wsPath,
        ].join("\n"),
      );

      if (!confirmed) {
        ctx.ui.notify("Cancelled workspace finish.", "info");
        return;
      }

      let changes: WorkspaceChange[];
      try {
        changes = await getUniqueWorkspaceChanges(name);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
        return;
      }

      const hasConflictsInWorkspace = changes.some((change) => change.conflict);
      if (hasConflictsInWorkspace) {
        ctx.ui.notify(
          `Workspace '${name}' has conflicted commits. Resolve conflicts in the workspace and retry.`,
          "error",
        );
        return;
      }

      // Check if the default workspace has uncommitted changes. If so, block
      // the finish to avoid baking WIP edits into the merge commit's ancestry.
      if (changes.some((change) => !change.empty)) {
        const defaultEmptyResult = await runJj([
          "log",
          "-r",
          "default@",
          "--no-graph",
          "-T",
          "empty",
        ]);

        if (defaultEmptyResult.code === 0) {
          const defaultIsEmpty = defaultEmptyResult.stdout.trim() === "true";
          if (!defaultIsEmpty) {
            ctx.ui.notify(
              "The default workspace has uncommitted changes. Commit or stash them before finishing a workspace to avoid mixing work-in-progress into the merge.",
              "error",
            );
            return;
          }
        }
      }

      // If every unique commit is empty, abandon them and skip the merge entirely.
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

        // Re-query to guard against races where a new commit appeared between
        // the initial query and the abandon.
        try {
          changes = await getUniqueWorkspaceChanges(name);
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
          return;
        }

        const newChanges = changes.filter((c) => !abandonedIds.has(c.changeId));
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
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
          return;
        }

        // Find the non-empty head commits of the unique workspace changes.
        // Using heads() with ~empty() avoids pulling in the workspace's empty
        // working-copy commit as a merge parent, which would leave dangling
        // empty commits in the log after workspace forget.
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
          .map((l) => l.trim())
          .filter(Boolean);

        // Fall back to ${name}@ if no non-empty heads found (shouldn't happen
        // since we already checked changes.length > 0, but be defensive).
        const mergeParents = headIds.length > 0 ? headIds : [`${name}@`];

        const mergeResult = await runJj([
          "new",
          "default@",
          ...mergeParents,
          "-m",
          `finish workspace ${name}`,
        ], { timeout: LONG_JJ_TIMEOUT });

        if (mergeResult.code !== 0) {
          ctx.ui.notify(
            mergeResult.stderr.trim() || `Failed to merge workspace '${name}'.`,
            "error",
          );
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
          await runJj(["op", "restore", preMergeOpId], { timeout: LONG_JJ_TIMEOUT });
          ctx.ui.notify(
            `Merge conflict detected while finishing ${name}. Repository restored to pre-finish state. Resolve in workspace and retry.`,
            "error",
          );
          return;
        }
      }

      setActiveWorkspace(null);
      persistWorkspaceState(null);

      const forgetResult = await runJj(["workspace", "forget", name], { timeout: LONG_JJ_TIMEOUT });
      if (forgetResult.code !== 0) {
        ctx.ui.notify(
          forgetResult.stderr.trim() || `Merged workspace '${name}', but failed to forget it.`,
          "error",
        );
        return;
      }

      const repoRootResult = await runJj(["root"]);
      const repoRoot = repoRootResult.code === 0 ? repoRootResult.stdout.trim() : defaultCwd;
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
      ]
        .filter(Boolean)
        .join("\n\n");

      ctx.ui.notify(message, "info");

      if (!deletion.deleted) {
        ctx.ui.notify(
          `Warning: could not delete workspace directory ${wsPath}: ${deletion.reason}`,
          "warning",
        );
      }
    },
  });

  pi.on("before_agent_start", (event) => {
    if (!activeWorkspace) return;

    const cwdLine = `Current working directory: ${getActiveCwd()}`;
    const replaced = event.systemPrompt.replace(CWD_LINE_RE, cwdLine);
    const rewrittenPrompt = replaced !== event.systemPrompt
      ? replaced
      : `${event.systemPrompt}\n${cwdLine}`;

    const workspaceInstructions = [
      `You are working in jj workspace "${activeWorkspace.name}".`,
      "- Use `jj` for version control. NEVER use `git` commands directly.",
      "- The full history is available via `jj log`.",
      "- Keep commits incremental and descriptive.",
    ].join("\n");

    return {
      systemPrompt: `${rewrittenPrompt}\n\n${workspaceInstructions}`,
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await refreshWorkspaceHeadsCache();

    const entries = ctx.sessionManager.getEntries();
    const saved = parseSavedWorkspace(entries as unknown[]);
    if (saved.status === "absent") return;

    if (saved.status === "cleared") {
      setActiveWorkspace(null);
      return;
    }

    const { workspace } = saved;
    const existsByName = workspaceHeadsCache.some((ws) => ws.name === workspace.name);
    const existsOnDisk = existsSync(workspace.path);

    if (existsByName && existsOnDisk) {
      setActiveWorkspace(workspace);
      return;
    }

    setActiveWorkspace(null);

    if (ctx.hasUI) {
      if (!existsByName) {
        ctx.ui.notify(
          `Workspace '${workspace.name}' no longer exists, returning to default workspace.`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `Workspace path '${workspace.path}' is missing, returning to default workspace.`,
          "warning",
        );
      }
    }
  });
}
