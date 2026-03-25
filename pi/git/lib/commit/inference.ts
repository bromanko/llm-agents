import type { CommitSnapshot, CommitProposal, CommitType, HunkSelector, SplitCommitPlan } from "./types.ts";
import type { ModelCandidate } from "./model-resolver.ts";

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

export function setCompleteFn(fn: CompleteFn | undefined): void {
  _completeFn = fn;
}

export function setCompleteFnImporter(importer: CompleteFnImporter | undefined): void {
  _completeFnImporter = importer;
}

async function loadCompleteFn(): Promise<CompleteFn> {
  if (_completeFnImporter) return _completeFnImporter();
  const { completeSimple } = await import("@mariozechner/pi-ai");
  return completeSimple as CompleteFn;
}

async function getCompleteFn(): Promise<CompleteFn> {
  if (_completeFn) return _completeFn;
  _completeFn = await loadCompleteFn();
  return _completeFn;
}

export interface ModelRegistryForInference {
  find: (provider: string, id: string) => unknown;
  getAll?: () => unknown[];
  getApiKey: (model: unknown) => Promise<string | null | undefined>;
}

export interface InferenceContext {
  modelRegistry?: ModelRegistryForInference;
  logger?: { debug?: (message: string, meta?: unknown) => void };
  model?: { provider?: string; id?: string;[key: string]: unknown };
}

export interface ModelInferenceResult {
  text: string | null;
  rawResponse?: { content: CompletionBlock[] } | null;
  error?: string;
}

export async function runModelInferenceDetailed(
  ctx: InferenceContext,
  model: ModelCandidate,
  prompt: string,
): Promise<ModelInferenceResult> {
  try {
    const resolvedModel = resolveModelObject(ctx, model);
    if (!resolvedModel) {
      return { text: null, error: "Model could not be resolved from registry or active session." };
    }

    const apiKey = await resolveApiKey(ctx, resolvedModel.fromRegistry);
    const complete = await getCompleteFn();
    const response = await complete(
      resolvedModel.value,
      {
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      },
      {
        apiKey,
        maxTokens: 4096,
        temperature: 0.2,
      },
    );

    const text = extractFirstTextBlock(response);
    if (text === null) {
      ctx?.logger?.debug?.("runModelInference empty-text-response", {
        provider: model.provider,
        modelId: model.id,
        blockTypes: Array.isArray(response?.content)
          ? response.content.map((block) => String(block?.type ?? "unknown"))
          : [],
      });
    }

    return { text, rawResponse: response };
  } catch (error) {
    const safeError = error instanceof Error ? error.message : String(error);
    ctx?.logger?.debug?.("runModelInference failed", {
      error: safeError,
      provider: model.provider,
      modelId: model.id,
    });
    return { text: null, error: safeError };
  }
}

export async function runModelInference(
  ctx: InferenceContext,
  model: ModelCandidate,
  prompt: string,
): Promise<string | null> {
  const result = await runModelInferenceDetailed(ctx, model, prompt);
  return result.text;
}

interface ResolvedModel {
  value: unknown;
  fromRegistry: unknown | null;
}

function resolveModelObject(
  ctx: InferenceContext,
  model: ModelCandidate,
): ResolvedModel | null {
  let registryModel = ctx.modelRegistry?.find(model.provider, model.id);

  if (!registryModel && ctx.modelRegistry?.getAll) {
    registryModel = ctx.modelRegistry.getAll().find((entry) => {
      if (!isRecord(entry)) return false;
      return entry.provider === model.provider && entry.id === model.id;
    });
  }

  if (registryModel) {
    return { value: registryModel, fromRegistry: registryModel };
  }

  const sessionModel =
    ctx.model && ctx.model.provider === model.provider && ctx.model.id === model.id
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
    if (typeof key === "string" && key.trim()) return key;
  } catch {
    // ignore
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

const MAX_PROMPT_DIFF_CHARS = 15_000;

export function buildCommitPrompt(input: {
  snapshot: CommitSnapshot;
  userContext?: string;
}): string {
  const fileSummary = input.snapshot.files
    .map((file) => `${file.path} | kind=${file.kind} | binary=${file.isBinary} | hunks=${file.hunks.length} | splitAllowed=${file.splitAllowed}`)
    .join("\n");

  const hunkCatalog = input.snapshot.files
    .map((file) => {
      if (!file.splitAllowed) return `${file.path}: whole-file only`;
      return [
        `${file.path}:`,
        ...file.hunks.map((hunk) => `  H${hunk.index + 1}: ${hunk.header}`),
      ].join("\n");
    })
    .join("\n\n");

  const truncatedDiff = input.snapshot.diff.slice(0, MAX_PROMPT_DIFF_CHARS);
  const diffNote = input.snapshot.diff.length > MAX_PROMPT_DIFF_CHARS
    ? `Diff truncated to ${MAX_PROMPT_DIFF_CHARS} characters out of ${input.snapshot.diff.length}. Prefer a coarse file-level plan when evidence is incomplete.`
    : undefined;

  const parts = [
    "You are an expert at planning atomic Git commits.",
    "Analyze the staged changes and respond with ONLY a JSON object.",
    "",
    "## Changed Files",
    fileSummary,
    "",
    "## Hunk Catalog",
    hunkCatalog,
    "",
    "## Diff Stat",
    input.snapshot.stat,
    diffNote ? `\n${diffNote}` : "",
    "",
    "## Diff",
    truncatedDiff,
    "",
  ];

  if (input.userContext) {
    parts.push("## User Context", input.userContext, "");
  }

  parts.push(
    "## Output Formats",
    'Single commit: {"type":"single","commit":{"type":"<commit_type>","scope":"<scope_or_null>","summary":"<past_tense_summary>","details":[{"text":"<detail>","userVisible":false}]}}',
    '',
    'Split commits: {"type":"split","commits":[{"changes":[{"path":"src/file.ts","hunks":{"type":"all"}},{"path":"src/other.ts","hunks":{"type":"indices","indices":[1,2]}}],"type":"<commit_type>","scope":"<scope_or_null>","summary":"<past_tense_summary>","details":[],"dependencies":[]}]}',
    "",
    "## Rules",
    "- Summary MUST start with a past-tense verb",
    "- Summary max 72 characters, no trailing period",
    "- Scope must be lowercase and contain only letters/digits/hyphens/underscores, optionally one /",
    "- Every changed file must be fully covered exactly once across the plan",
    "- For files with splitAllowed=false, use {type:'all'} exactly once",
    "- For files split across multiple commits, use hunk indices from the catalog (1-based)",
    "- Never reuse the same hunk index in more than one commit",
    "- commit_type is one of: feat, fix, refactor, perf, docs, test, build, ci, chore, style, revert",
  );

  return parts.join("\n");
}

export function parseModelResponse(
  response: string,
): { proposal?: CommitProposal; splitPlan?: SplitCommitPlan } {
  try {
    const parsed = parseJsonFromModelResponse(response);
    if (!isRecord(parsed)) return {};

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
      const commitsRaw = parsed.commits;
      return {
        splitPlan: {
          commits: commitsRaw.map((rawCommit) => {
            const commit = isRecord(rawCommit) ? rawCommit : {};
            return {
              changes: sanitizeChanges(commit.changes),
              type: sanitizeType(commit.type),
              scope: sanitizeScope(commit.scope),
              summary: sanitizeSummary(commit.summary),
              details: sanitizeDetails(commit.details),
              issueRefs: [],
              dependencies: sanitizeDependencies(commit.dependencies, commitsRaw.length),
            };
          }),
          warnings: [],
        },
      };
    }
  } catch {
    // ignore
  }

  return {};
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const candidate = raw.trim();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  push(text);

  for (const match of text.matchAll(/```(?:json|JSON)?\s*([\s\S]*?)```/g)) {
    push(match[1]);
  }

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

function parseJsonFromModelResponse(response: string): unknown {
  for (const candidate of extractJsonObjectCandidates(response.trim())) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  throw new Error("Model response did not contain parseable JSON");
}

const VALID_COMMIT_TYPES = new Set([
  "feat", "fix", "refactor", "perf", "docs", "test", "build", "ci", "chore", "style", "revert",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeType(value: unknown): CommitType {
  return typeof value === "string" && VALID_COMMIT_TYPES.has(value)
    ? (value as CommitType)
    : "chore";
}

function sanitizeScope(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized) return null;
  return /^[a-z0-9][a-z0-9_-]*(\/?[a-z0-9][a-z0-9_-]*)?$/.test(normalized)
    ? normalized
    : null;
}

function sanitizeSummary(value: unknown): string {
  if (typeof value !== "string") return "updated files";
  const normalized = value.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!normalized) return "updated files";
  if (normalized.length <= 72) return normalized;
  const lastSpace = normalized.lastIndexOf(" ", 72);
  return (lastSpace > 0 ? normalized.slice(0, lastSpace) : normalized.slice(0, 72)).trim();
}

function sanitizeDetails(value: unknown): Array<{ text: string; userVisible: boolean }> {
  if (!Array.isArray(value)) return [];
  const details: Array<{ text: string; userVisible: boolean }> = [];

  for (const item of value) {
    if (typeof item === "string") {
      const text = item.replace(/[\x00-\x1f\x7f]/g, "").trim();
      if (text) details.push({ text, userVisible: false });
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

function sanitizeChanges(value: unknown): Array<{ path: string; hunks: HunkSelector }> {
  if (!Array.isArray(value)) return [];
  const changes: Array<{ path: string; hunks: HunkSelector }> = [];

  for (const item of value) {
    if (!isRecord(item) || typeof item.path !== "string") continue;
    const path = item.path.trim();
    if (!path) continue;
    changes.push({ path, hunks: sanitizeHunks(item.hunks) });
  }

  return changes;
}

function sanitizeHunks(value: unknown): HunkSelector {
  if (isRecord(value) && value.type === "indices" && Array.isArray(value.indices)) {
    const indices = Array.from(
      new Set(
        value.indices
          .filter((entry) => Number.isInteger(entry))
          .map((entry) => Number(entry))
          .filter((entry) => entry > 0),
      ),
    ).sort((a, b) => a - b);
    return { type: "indices", indices };
  }

  return { type: "all" };
}

function sanitizeDependencies(value: unknown, maxIndex: number): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((entry) => Number.isInteger(entry))
        .map((entry) => Number(entry))
        .filter((entry) => entry >= 0 && entry < maxIndex),
    ),
  );
}

export const _testHelpers = {
  buildCommitPrompt,
  parseModelResponse,
  resolveModelObject,
  sanitizeChanges,
};
