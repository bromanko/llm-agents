/**
 * /jj-commit — agentic commit workflow for jujutsu repositories.
 *
 * Analyzes working-copy changes, generates conventional commit messages using
 * a model (preferred: Sonnet 4.6, fallback: session model, final: deterministic),
 * optionally splits unrelated changes into multiple commits, updates existing
 * changelogs, and can push via bookmark.
 *
 * Flags:
 *   --dry-run       Preview commit plan without mutating
 *   --push          Push after committing (defaults bookmark to "main")
 *   --bookmark <n>  Bookmark name for push
 *   --no-changelog  Skip changelog detection/updates
 *   --no-absorb     Skip jj absorb pre-pass
 *   --context <t>   Additional context for the model
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isJjRepo } from "../lib/utils.ts";
import { ControlledJj } from "../lib/commit/jj.ts";
import { runCommitPipeline, pushWithBookmark } from "../lib/commit/pipeline.ts";
import type { PipelineContext } from "../lib/commit/pipeline.ts";
import type { CommitCommandArgs } from "../lib/commit/types.ts";
import type { ModelCandidate } from "../lib/commit/model-resolver.ts";

interface JjCommitCommandDeps {
  isJjRepo: (cwd: string) => boolean;
  ControlledJj: new (cwd: string) => ControlledJj;
  runCommitPipeline: typeof runCommitPipeline;
  pushWithBookmark: typeof pushWithBookmark;
}

const defaultDeps: JjCommitCommandDeps = {
  isJjRepo,
  ControlledJj,
  runCommitPipeline,
  pushWithBookmark,
};

function modelKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

export function registerJjCommitCommand(
  pi: ExtensionAPI,
  deps: JjCommitCommandDeps = defaultDeps,
): void {
  pi.registerCommand("jj-commit", {
    description:
      "Analyze jj working copy and create well-structured commits with AI-generated messages",
    handler: createJjCommitHandler(pi, deps),
  });
}

export function createJjCommitHandler(
  pi: ExtensionAPI,
  deps: JjCommitCommandDeps = defaultDeps,
) {
  return async (argsStr: string | undefined, ctx: any) => {
    if (!deps.isJjRepo(ctx.cwd)) {
      ctx.ui.notify("Not a jujutsu repository.", "error");
      return;
    }

    // Parse command arguments
    const args = parseArgs(argsStr ?? "");

    const jj = new deps.ControlledJj(ctx.cwd);

    // Build model candidates from the pi model registry
    const availableModels: ModelCandidate[] = [];
    const registryModelByKey = new Map<string, any>();
    let sessionModel: ModelCandidate | undefined;

    if (ctx.modelRegistry) {
      // Use getAll() rather than getAvailable() to include models
      // authenticated via OAuth (e.g. pi-sub-bar).  getAvailable() is a
      // fast check that skips OAuth token refresh and may omit valid models.
      // The hasApiKey callback below performs the full auth check per candidate.
      const models = ctx.modelRegistry.getAll();
      for (const m of models) {
        availableModels.push({
          provider: m.provider,
          id: m.id,
          name: m.name,
        });
        registryModelByKey.set(modelKey(m.provider, m.id), m);
      }
    }

    if (ctx.model) {
      sessionModel = {
        provider: ctx.model.provider,
        id: ctx.model.id,
        name: ctx.model.name,
      };
    }

    const apiKeyPresenceCache = new Map<string, Promise<boolean>>();
    const hasApiKey = async (model: ModelCandidate): Promise<boolean> => {
      if (!ctx.modelRegistry) return false;

      const key = modelKey(model.provider, model.id);
      const cached = apiKeyPresenceCache.get(key);
      if (cached) return cached;

      const checkPromise = (async () => {
        // Try the fast-path map first (built from getAvailable), then fall
        // back to a full registry lookup.  getAvailable() is a fast check
        // that skips OAuth token refresh, so models authenticated via OAuth
        // (e.g. pi-sub-bar) may not appear there.
        const found =
          registryModelByKey.get(key) ??
          ctx.modelRegistry.find(model.provider, model.id);
        if (!found) return false;
        try {
          const apiKey = await ctx.modelRegistry.getApiKey(found);
          return apiKey !== undefined && apiKey !== null && apiKey !== "";
        } catch {
          return false;
        }
      })();

      apiKeyPresenceCache.set(key, checkPromise);
      return checkPromise;
    };

    // Progress callback
    const onProgress = (message: string) => {
      ctx.ui.notify(message, "info");
    };

    // Build pipeline context
    const pipelineCtx: PipelineContext = {
      jj,
      cwd: ctx.cwd,
      args,
      availableModels,
      sessionModel,
      hasApiKey,
      onProgress,
      // Agentic session is wired through pi's sendUserMessage for now.
      // For a full agentic session, we would need to create a sub-agent
      // session with custom tools. For the initial release, we use the
      // deterministic fallback + the model's inline analysis via a
      // steering message approach.
      runAgenticSession: createAgenticSession(pi, ctx),
    };

    // Run the pipeline
    const result = await deps.runCommitPipeline(pipelineCtx);

    // Show warnings
    for (const warning of result.warnings) {
      ctx.ui.notify(`⚠ ${warning}`, "warning");
    }

    // Recovery guidance is useful for real failures, but noisy for no-op outcomes.
    const shouldShowRecoveryGuidance =
      !result.committed
      && !args.dryRun
      && result.summary !== "Nothing to commit."
      && result.summary !== "All changes were absorbed into ancestor commits.";

    if (shouldShowRecoveryGuidance) {
      ctx.ui.notify(
        "To inspect operations: jj op log\nTo undo last operation: jj op undo",
        "info",
      );
    }

    // Show summary
    ctx.ui.notify(result.summary, "info");

    // Show commit messages
    if (result.messages.length > 0) {
      for (const msg of result.messages) {
        ctx.ui.notify(msg, "info");
      }
    }

    // Push if requested
    if (args.push && result.committed) {
      const bookmark = args.bookmark ?? "main";
      const pushResult = await deps.pushWithBookmark(jj, bookmark, onProgress);
      if (pushResult.success) {
        ctx.ui.notify(`Pushed bookmark '${bookmark}' to remote.`, "info");
      } else {
        ctx.ui.notify(
          `Push failed: ${pushResult.error}\n\nTo retry manually:\n  jj bookmark set ${bookmark} -r @-\n  jj git push --bookmark ${bookmark}`,
          "error",
        );
      }
    }
  };
}

export default function (pi: ExtensionAPI) {
  registerJjCommitCommand(pi);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface ParsedToken {
  value: string;
  start: number;
}

function tokenizeArgs(argsStr: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null = re.exec(argsStr);
  while (match) {
    tokens.push({ value: match[0], start: match.index });
    match = re.exec(argsStr);
  }
  return tokens;
}

export function parseArgs(argsStr: string): CommitCommandArgs {
  const tokens = tokenizeArgs(argsStr);
  const result: CommitCommandArgs = {
    dryRun: false,
    push: false,
    noChangelog: false,
    noAbsorb: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].value;

    if (token.startsWith("--bookmark=")) {
      const bookmark = token.slice("--bookmark=".length);
      if (bookmark.length > 0) {
        result.bookmark = bookmark;
      }
      continue;
    }

    switch (token) {
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--push":
        result.push = true;
        break;
      case "--bookmark": {
        const next = tokens[i + 1]?.value;
        if (next && !next.startsWith("--")) {
          result.bookmark = next;
          i += 1;
        }
        break;
      }
      case "--no-changelog":
        result.noChangelog = true;
        break;
      case "--no-absorb":
        result.noAbsorb = true;
        break;
      case "--context": {
        const nextToken = tokens[i + 1];
        if (nextToken) {
          result.context = argsStr.slice(nextToken.start);
        }
        i = tokens.length; // consume rest
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agentic session factory
//
// Creates an agentic session runner that uses pi's model infrastructure.
// For the initial release, this sends a structured prompt to the model
// and parses the response into a commit proposal.
// ---------------------------------------------------------------------------

function createAgenticSession(
  pi: ExtensionAPI,
  ctx: any,
): PipelineContext["runAgenticSession"] {
  return async (input) => {
    // For now, we use a simplified approach: construct a prompt with the
    // diff and stat information, send it to the model, and parse the response.
    // A full agentic loop with custom tools would be a future enhancement.

    const prompt = buildCommitPrompt(input);

    try {
      // Use pi.exec to call the model via a simple inference approach
      // We'll use the session's model to generate a commit message
      const result = await runModelInference(pi, ctx, input.model, prompt);
      if (result) {
        return parseModelResponse(result, input.changedFiles);
      }
    } catch {
      // Fall through to no result
    }

    return {};
  };
}

export function buildCommitPrompt(input: {
  changedFiles: string[];
  diff: string;
  stat: string;
  changelogTargets: string[];
  userContext?: string;
}): string {
  const parts = [
    "You are a conventional commit expert. Analyze these jujutsu working copy changes and respond with a JSON commit proposal.",
    "",
    "## Changed Files",
    input.changedFiles.join("\n"),
    "",
    "## Diff Stat",
    input.stat,
    "",
    "## Diff",
    input.diff.slice(0, 50_000), // Truncate large diffs
    "",
  ];

  if (input.userContext) {
    parts.push("## User Context", input.userContext, "");
  }

  if (input.changelogTargets.length > 0) {
    parts.push(
      "## Changelog Targets",
      input.changelogTargets.join("\n"),
      "",
    );
  }

  parts.push(
    "## Instructions",
    "Respond with ONLY a JSON object (no markdown fences, no explanation) in one of these formats:",
    "",
    'For a single commit: {"type":"single","commit":{"type":"<commit_type>","scope":"<scope_or_null>","summary":"<past_tense_summary_max_72_chars>","details":[{"text":"<detail>","userVisible":false}]}}',
    "",
    'For split commits: {"type":"split","commits":[{"files":["<file>"],"type":"<commit_type>","scope":"<scope_or_null>","summary":"<past_tense_summary>","details":[],"dependencies":[]}],"mode":"file"}',
    "",
    "Rules:",
    "- Summary MUST start with a past-tense verb (added, fixed, refactored, etc.)",
    "- Summary max 72 characters, no trailing period",
    "- Scope: lowercase, letters/digits/hyphens/underscores only",
    "- For split commits: every changed file must appear exactly once across all commits",
    "- commit_type is one of: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert",
  );

  return parts.join("\n");
}

/**
 * Injectable completion function. In production this is `completeSimple`
 * from `@mariozechner/pi-ai`; tests supply a mock.
 */
export type CompletionBlock =
  | { type: "text"; text?: string }
  | { type: string; [key: string]: unknown };

export type CompleteInput = {
  messages: Array<{
    role: "user" | "assistant" | "system";
    content: Array<{ type: "text"; text: string }>;
    timestamp?: number;
  }>;
};

export type CompleteOptions = {
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
};

export type CompleteFn = (
  model: unknown,
  context: CompleteInput,
  options?: CompleteOptions,
) => Promise<{ content: CompletionBlock[] }>;

export type CompleteFnImporter = () => Promise<CompleteFn>;

interface ModelRegistryForInference {
  find: (provider: string, id: string) => unknown;
  getApiKey: (model: unknown) => Promise<string | null | undefined>;
}

interface InferenceLogger {
  debug?: (message: string, meta?: unknown) => void;
}

interface InferenceContext {
  modelRegistry?: ModelRegistryForInference;
  logger?: InferenceLogger;
}

let _completeFn: CompleteFn | undefined;
let _completeFnImporter: CompleteFnImporter | undefined;

/** Override the completion function (for tests). */
export function setCompleteFn(fn: CompleteFn | undefined): void {
  _completeFn = fn;
}

/** Override completion function importer (for tests). */
export function setCompleteFnImporter(importer: CompleteFnImporter | undefined): void {
  _completeFnImporter = importer;
}

async function loadCompleteFn(): Promise<CompleteFn> {
  if (_completeFnImporter) {
    return _completeFnImporter();
  }
  const { completeSimple } = await import("@mariozechner/pi-ai");
  return completeSimple as CompleteFn;
}

async function getCompleteFn(): Promise<CompleteFn> {
  if (_completeFn) return _completeFn;
  _completeFn = await loadCompleteFn();
  return _completeFn;
}

export async function runModelInference(
  _pi: ExtensionAPI,
  ctx: InferenceContext,
  model: ModelCandidate,
  prompt: string,
): Promise<string | null> {
  try {
    const registryModel = ctx.modelRegistry?.find(model.provider, model.id);
    if (!registryModel) return null;

    // Resolve API key — may be undefined for OAuth-authenticated models,
    // in which case completeSimple will use the provider's own auth.
    const apiKey = await ctx.modelRegistry?.getApiKey(registryModel);

    // Use the pi-ai completeSimple API which properly dispatches through
    // the registered API provider for the model's api type.
    const complete = await getCompleteFn();
    const response = await complete(registryModel, {
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
    }, {
      apiKey,
      maxTokens: 2048,
      temperature: 0.2,
    });

    // Extract the first text block from the assistant message
    if (Array.isArray(response?.content)) {
      for (const block of response.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          return block.text;
        }
      }
    }
  } catch (err) {
    ctx?.logger?.debug?.("runModelInference failed", {
      err,
      provider: model.provider,
      modelId: model.id,
    });
    // Fall through to null — caller uses deterministic fallback
  }

  return null;
}

const VALID_COMMIT_TYPES = new Set([
  "feat",
  "fix",
  "refactor",
  "perf",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "style",
  "revert",
]);

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function sanitizeType(value: unknown): import("../lib/commit/types.ts").CommitType {
  if (typeof value === "string" && VALID_COMMIT_TYPES.has(value)) {
    return value as import("../lib/commit/types.ts").CommitType;
  }
  return "chore";
}

function sanitizeScope(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  if (!/^[a-z0-9][a-z0-9_-]*(\/?[a-z0-9][a-z0-9_-]*)?$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function sanitizeSummary(value: unknown): string {
  if (typeof value !== "string") return "updated files";
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : "updated files";
}

function sanitizeDetails(value: unknown): Array<{ text: string; userVisible: boolean }> {
  if (!Array.isArray(value)) return [];
  const details: Array<{ text: string; userVisible: boolean }> = [];

  for (const item of value) {
    if (typeof item === "string") {
      const text = item.trim();
      if (text.length > 0) {
        details.push({ text, userVisible: false });
      }
      continue;
    }

    if (!isRecord(item)) continue;

    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) continue;
    details.push({ text, userVisible: item.userVisible === true });
  }

  return details;
}

function sanitizeFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const files: string[] = [];
  const seen = new Set<string>();

  for (const file of value) {
    if (typeof file !== "string") continue;
    const normalized = file.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    files.push(normalized);
  }

  return files;
}

function sanitizeDependencies(value: unknown, maxIndex: number): number[] {
  if (!Array.isArray(value)) return [];
  const deps: number[] = [];
  const seen = new Set<number>();

  for (const dep of value) {
    if (!Number.isInteger(dep)) continue;
    const n = dep as number;
    if (n < 0 || n >= maxIndex || seen.has(n)) continue;
    seen.add(n);
    deps.push(n);
  }

  return deps;
}

function parseJsonFromModelResponse(response: string): unknown {
  let cleaned = response.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```[\w-]*\s*\r?\n?/, "")
      .replace(/(?:\r?\n)?```\s*$/, "");
  }
  return JSON.parse(cleaned);
}

function validateSplitCoverage(commits: Array<{ files: string[] }>, changedFiles: string[]): boolean {
  if (commits.length === 0) return false;

  const changed = new Set(changedFiles);
  const covered = new Set<string>();

  for (const commit of commits) {
    if (!Array.isArray(commit.files) || commit.files.length === 0) {
      return false;
    }

    for (const file of commit.files) {
      if (!changed.has(file)) return false;
      if (covered.has(file)) return false;
      covered.add(file);
    }
  }

  for (const file of changed) {
    if (!covered.has(file)) return false;
  }

  return true;
}

export function parseModelResponse(
  response: string,
  changedFiles: string[],
): {
  proposal?: import("../lib/commit/types.ts").CommitProposal;
  splitPlan?: import("../lib/commit/types.ts").SplitCommitPlan;
} {
  try {
    const parsed = parseJsonFromModelResponse(response);
    if (!isRecord(parsed)) {
      return {};
    }

    if (parsed.type === "single" && isRecord(parsed.commit)) {
      return {
        proposal: {
          type: sanitizeType(parsed.commit.type),
          scope: sanitizeScope(parsed.commit.scope),
          summary: sanitizeSummary(parsed.commit.summary),
          details: sanitizeDetails(parsed.commit.details),
          issueRefs: [],
          warnings: [],
        },
      };
    }

    if (parsed.type === "split" && Array.isArray(parsed.commits)) {
      const commits: Array<{
        files: string[];
        type: import("../lib/commit/types.ts").CommitType;
        scope: string | null;
        summary: string;
        details: Array<{ text: string; userVisible: boolean }>;
        issueRefs: string[];
        dependencies: number[];
      }> = [];

      const commitCount = parsed.commits.length;
      for (const rawCommit of parsed.commits) {
        if (!isRecord(rawCommit)) {
          return {};
        }

        commits.push({
          files: sanitizeFiles(rawCommit.files),
          type: sanitizeType(rawCommit.type),
          scope: sanitizeScope(rawCommit.scope),
          summary: sanitizeSummary(rawCommit.summary),
          details: sanitizeDetails(rawCommit.details),
          issueRefs: [],
          dependencies: sanitizeDependencies(rawCommit.dependencies, commitCount),
        });
      }

      if (!validateSplitCoverage(commits, changedFiles)) {
        return {};
      }

      return {
        splitPlan: {
          commits,
          warnings: [],
          mode: parsed.mode === "hunk" ? "hunk" : "file",
        },
      };
    }
  } catch {
    // Parse failed
  }

  return {};
}
