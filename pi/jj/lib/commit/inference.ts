/**
 * Model inference and response parsing for jj-commit.
 *
 * Handles:
 * - Prompt construction for the commit analysis model
 * - Model completion via pi-ai's completeSimple API
 * - Parsing and sanitizing model JSON responses into CommitProposal / SplitCommitPlan
 */

import type { CommitProposal, CommitType, SplitCommitPlan } from "./types.ts";
import type { ModelCandidate } from "./model-resolver.ts";

// ---------------------------------------------------------------------------
// Completion function injection
// ---------------------------------------------------------------------------

export type CompletionBlock =
  | { type: "text"; text?: string }
  | { type: string;[key: string]: unknown };

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

// ---------------------------------------------------------------------------
// Model inference
// ---------------------------------------------------------------------------

export interface ModelRegistryForInference {
  find: (provider: string, id: string) => unknown;
  getAll?: () => unknown[];
  getApiKey: (model: unknown) => Promise<string | null | undefined>;
}

export interface InferenceLogger {
  debug?: (message: string, meta?: unknown) => void;
}

export interface InferenceContext {
  modelRegistry?: ModelRegistryForInference;
  logger?: InferenceLogger;
  model?: {
    provider?: string;
    id?: string;
    [key: string]: unknown;
  };
}

/**
 * Resolve the model object from the registry or session, call the completion
 * API, and return the first text block. Returns null if the model cannot be
 * found or the completion fails.
 */
export async function runModelInference(
  ctx: InferenceContext,
  model: ModelCandidate,
  prompt: string,
): Promise<string | null> {
  try {
    const resolvedModel = resolveModelObject(ctx, model);
    if (!resolvedModel) return null;

    const apiKey = await resolveApiKey(ctx, resolvedModel.fromRegistry);

    const complete = await getCompleteFn();
    const response = await complete(resolvedModel.value, {
      messages: [
        { role: "user", content: [{ type: "text", text: prompt }] },
      ],
    }, {
      apiKey,
      maxTokens: 2048,
      temperature: 0.2,
    });

    return extractFirstTextBlock(response);
  } catch (err) {
    const safeErr = err instanceof Error ? err.message : String(err);
    ctx?.logger?.debug?.("runModelInference failed", {
      error: safeErr,
      provider: model.provider,
      modelId: model.id,
    });
    return null;
  }
}

/** Result of resolving a model object from registry or session. */
interface ResolvedModel {
  /** The model object to pass to the completion function. */
  value: unknown;
  /** The registry model used for API key lookup, or null when from session. */
  fromRegistry: unknown | null;
}

/**
 * Find the model object via: registry find → registry getAll → session model.
 * Returns the resolved object and whether it came from the registry.
 */
function resolveModelObject(
  ctx: InferenceContext,
  model: ModelCandidate,
): ResolvedModel | null {
  let registryModel = ctx.modelRegistry?.find(model.provider, model.id);

  if (!registryModel && ctx.modelRegistry?.getAll) {
    const models = ctx.modelRegistry.getAll();
    registryModel = models.find((m) => {
      if (!isRecord(m)) return false;
      return m.provider === model.provider && m.id === model.id;
    });
  }

  if (registryModel) {
    return { value: registryModel, fromRegistry: registryModel };
  }

  // Fall back to the active session model when registry lookup misses
  // (e.g. OAuth-backed session adapters).
  const sessionModel =
    ctx.model
      && ctx.model.provider === model.provider
      && ctx.model.id === model.id
      ? ctx.model
      : undefined;

  if (sessionModel) {
    return { value: sessionModel, fromRegistry: null };
  }

  return null;
}

async function resolveApiKey(
  ctx: InferenceContext,
  registryModel: unknown,
): Promise<string | undefined> {
  if (!registryModel || !ctx.modelRegistry) return undefined;
  try {
    const key = await ctx.modelRegistry.getApiKey(registryModel);
    if (typeof key === "string" && key.trim().length > 0) return key;
  } catch {
    // Swallow — caller proceeds without a key
  }
  return undefined;
}

function extractFirstTextBlock(
  response: { content: CompletionBlock[] } | null | undefined,
): string | null {
  if (!Array.isArray(response?.content)) return null;
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
      return block.text;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseModelResponse(
  response: string,
  changedFiles: string[],
): {
  proposal?: CommitProposal;
  splitPlan?: SplitCommitPlan;
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
        type: CommitType;
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

// ---------------------------------------------------------------------------
// JSON extraction helpers
// ---------------------------------------------------------------------------

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (raw: string) => {
    const candidate = raw.trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  // 1) Whole response (best case: model returned plain JSON)
  pushCandidate(text);

  // 2) JSON fenced code blocks anywhere in the response
  for (const match of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    pushCandidate(match[1]);
  }

  // 3) Any balanced top-level JSON object embedded in prose
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) { escaped = false; }
      else if (ch === "\\") { escaped = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === "{") { if (depth === 0) start = i; depth++; continue; }
    if (ch === "}") {
      if (depth === 0) continue;
      depth--;
      if (depth === 0 && start >= 0) {
        pushCandidate(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseJsonFromModelResponse(response: string): unknown {
  const cleaned = response.trim();
  const candidates = extractJsonObjectCandidates(cleaned);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next candidate
    }
  }

  throw new Error("Model response did not contain parseable JSON");
}

// ---------------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------------

const VALID_COMMIT_TYPES = new Set([
  "feat", "fix", "refactor", "perf", "docs",
  "test", "build", "ci", "chore", "style", "revert",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeType(value: unknown): CommitType {
  if (typeof value === "string" && VALID_COMMIT_TYPES.has(value)) {
    return value as CommitType;
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

function truncateToWordBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const lastSpace = text.lastIndexOf(" ", maxLen);
  if (lastSpace > 0) {
    return text.slice(0, lastSpace);
  }
  return text.slice(0, maxLen);
}

function sanitizeSummary(value: unknown): string {
  if (typeof value !== "string") return "updated files";
  // Remove control characters and enforce max length at word boundary
  const normalized = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (normalized.length === 0) return "updated files";
  return truncateToWordBoundary(normalized, 72);
}

function sanitizeDetails(value: unknown): Array<{ text: string; userVisible: boolean }> {
  if (!Array.isArray(value)) return [];
  const details: Array<{ text: string; userVisible: boolean }> = [];

  for (const item of value) {
    if (typeof item === "string") {
      const text = item.replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (text.length > 0) {
        details.push({ text, userVisible: false });
      }
      continue;
    }

    if (!isRecord(item)) continue;

    const text = (typeof item.text === "string" ? item.text : "")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim();
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

// ---------------------------------------------------------------------------
// Test-only exports — internal helpers exposed for unit testing
// ---------------------------------------------------------------------------

/** @internal */
export const _testHelpers = {
  extractJsonObjectCandidates,
  extractFirstTextBlock,
  parseJsonFromModelResponse,
  resolveModelObject,
  resolveApiKey,
  sanitizeSummary,
  sanitizeDetails,
  validateSplitCoverage,
};
