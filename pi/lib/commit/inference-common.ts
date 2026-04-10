/**
 * Shared inference helpers used by both git-commit and jj-commit modules.
 *
 * Contains auth resolution, response extraction, model resolution, and
 * completion option building — parameterized where the modules diverge
 * (e.g. maxTokens).
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type CompletionBlock =
  | { type: "text"; text?: string }
  | { type: string;[key: string]: unknown };

export type CompleteOptions = {
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
};

export interface ModelRegistryForInference {
  find: (provider: string, id: string) => unknown;
  getAll?: () => unknown[];
  getApiKey: (model: unknown) => Promise<string | null | undefined>;
  getApiKeyAndHeaders?: (model: unknown) => Promise<
    | { ok: true; apiKey?: string; headers?: Record<string, string> }
    | { ok: false; error?: string }
  >;
}

export interface InferenceContext {
  modelRegistry?: ModelRegistryForInference;
  logger?: { debug?: (message: string, meta?: unknown) => void };
  model?: { provider?: string; id?: string;[key: string]: unknown };
}

export interface ModelCandidate {
  provider: string;
  id: string;
  name?: string;
}

/** Result of resolving a model object from registry or session. */
export interface ResolvedModel {
  /** The model object to pass to the completion function. */
  value: unknown;
  /** The registry model used for API key lookup, or null when from session. */
  fromRegistry: unknown | null;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// Auth header allowlisting
// ---------------------------------------------------------------------------

/**
 * Returns true for header names that are safe to forward as auth credentials.
 * Allows `Authorization`, `api-key` (Azure), and custom `x-*` headers.
 * Blocks potentially dangerous headers like Host, Cookie, Content-Type, etc.
 */
function isAllowedAuthHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === "authorization"
    || lower === "api-key"
    || lower.startsWith("x-")
  );
}

export function sanitizeAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const sanitized: Record<string, string> = {};
  let count = 0;
  for (const [key, value] of Object.entries(headers)) {
    if (isAllowedAuthHeader(key)) {
      sanitized[key] = value;
      count++;
    }
  }
  return count > 0 ? sanitized : undefined;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

/**
 * Find the model object via: registry find → registry getAll → session model.
 * Returns the resolved object and whether it came from the registry.
 */
export function resolveModelObject(
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

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

/**
 * Resolve auth credentials (API key and/or headers) for a registry model.
 *
 * Prefers `getApiKeyAndHeaders` when available. When it returns `ok: true`,
 * the result is authoritative. When it returns `ok: false`, falls through
 * to the legacy `getApiKey` path. Auth headers are sanitized via an allowlist.
 */
export async function resolveRequestAuth(
  ctx: InferenceContext,
  registryModel: unknown,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  if (!registryModel || !ctx.modelRegistry) return {};

  try {
    if (typeof ctx.modelRegistry.getApiKeyAndHeaders === "function") {
      const result = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
      if (result && result.ok) {
        return {
          apiKey:
            typeof result.apiKey === "string" && result.apiKey.trim().length > 0
              ? result.apiKey
              : undefined,
          headers: sanitizeAuthHeaders(result.headers),
        };
      }
      // ok: false — fall through to legacy getApiKey
    }

    const key = await ctx.modelRegistry.getApiKey(registryModel);
    if (typeof key === "string" && key.trim().length > 0) {
      return { apiKey: key };
    }
  } catch (err) {
    ctx.logger?.debug?.("resolveRequestAuth failed", { error: err });
  }

  return {};
}

export async function resolveApiKey(
  ctx: InferenceContext,
  registryModel: unknown,
): Promise<string | undefined> {
  return (await resolveRequestAuth(ctx, registryModel)).apiKey;
}

// ---------------------------------------------------------------------------
// Completion options
// ---------------------------------------------------------------------------

export function buildCompleteOptions(
  model: ModelCandidate,
  auth: { apiKey?: string; headers?: Record<string, string> },
  maxTokens: number,
): CompleteOptions {
  const options: CompleteOptions = {
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxTokens,
  };

  if (model.provider !== "openai-codex") {
    options.temperature = 0.2;
  }

  return options;
}

// ---------------------------------------------------------------------------
// Response text extraction
// ---------------------------------------------------------------------------

export function extractFirstTextBlock(
  response: {
    content?: CompletionBlock[];
    output_text?: string;
    output?: unknown[];
    [key: string]: unknown;
  } | null | undefined,
): string | null {
  if (typeof response?.output_text === "string" && response.output_text.length > 0) {
    return response.output_text;
  }

  if (Array.isArray(response?.content)) {
    for (const block of response.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        return block.text;
      }
    }
  }

  if (Array.isArray(response?.output)) {
    for (const item of response.output) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) {
        continue;
      }
      for (const block of item.content) {
        if (!isRecord(block)) continue;
        if (block.type === "output_text" && typeof block.text === "string" && block.text.length > 0) {
          return block.text;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Extension-level auth check
// ---------------------------------------------------------------------------

/**
 * Check if a model has valid auth credentials via the registry.
 * Used by extension-level `hasApiKey` callbacks.
 *
 * When `getApiKeyAndHeaders` is present and returns `ok: true`, that result
 * is treated as authoritative — no fallthrough to `getApiKey`.
 */
export async function hasModelAuth(
  modelRegistry: ModelRegistryForInference,
  registryModel: unknown,
): Promise<boolean> {
  if (!registryModel) return false;

  try {
    if (typeof modelRegistry.getApiKeyAndHeaders === "function") {
      const auth = await modelRegistry.getApiKeyAndHeaders(registryModel);
      if (auth && auth.ok) {
        // ok: true is authoritative — check if credentials are present
        const hasKey = typeof auth.apiKey === "string" && auth.apiKey !== "";
        const hasHeaders = auth.headers != null && Object.keys(auth.headers).length > 0;
        return hasKey || hasHeaders;
      }
      // ok: false — fall through to legacy getApiKey
    }

    const apiKey = await modelRegistry.getApiKey(registryModel);
    return apiKey !== undefined && apiKey !== null && apiKey !== "";
  } catch {
    return false;
  }
}
