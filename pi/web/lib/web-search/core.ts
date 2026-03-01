import type { SearchProvider, SearchParams } from "./providers/base.ts";
import {
  SearchProviderError,
  type SearchProviderId,
  type SearchRecency,
  type SearchResponse,
  type SearchSource,
} from "./types.ts";

export const DEFAULT_LIMIT = 5;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 10;
export const DEFAULT_PROVIDER: SearchProviderId | "auto" = "auto";
export const DEFAULT_SNIPPET_CHARS = 280;

export interface SearchInput {
  query: string;
  provider?: "auto" | SearchProviderId;
  recency?: SearchRecency;
  limit?: number;
}

export interface NormalizedSearchInput {
  query: string;
  provider: "auto" | SearchProviderId;
  recency?: SearchRecency;
  limit: number;
}

export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(limit)));
}

export function normalizeSearchInput(input: SearchInput): NormalizedSearchInput {
  const query = input.query?.trim() ?? "";
  if (!query) {
    throw new Error("Query must not be empty.");
  }

  const provider = input.provider ?? DEFAULT_PROVIDER;
  const limit = clampLimit(input.limit ?? DEFAULT_LIMIT);

  return {
    query,
    provider,
    recency: input.recency,
    limit,
  };
}

export async function resolveProvider(
  requested: "auto" | SearchProviderId,
  providers: SearchProvider[],
): Promise<SearchProvider> {
  if (requested !== "auto") {
    const explicit = providers.find((provider) => provider.id === requested);
    if (!explicit) {
      throw new SearchProviderError(
        requested,
        `Requested provider '${requested}' is not registered.`,
      );
    }
    return explicit;
  }

  for (const provider of providers) {
    if (await provider.isAvailable()) {
      return provider;
    }
  }

  throw new SearchProviderError(
    "brave",
    "No search providers are available. Set BRAVE_API_KEY to enable provider 'brave'.",
  );
}

export async function runSearch(
  input: SearchInput,
  providers: SearchProvider[],
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const normalized = normalizeSearchInput(input);
  const provider = await resolveProvider(normalized.provider, providers);

  const params: SearchParams = {
    query: normalized.query,
    limit: normalized.limit,
    recency: normalized.recency,
    signal,
  };

  const response = await provider.search(params);
  return {
    ...response,
    provider: provider.id,
    sources: response.sources,
  };
}

export function truncateSnippet(snippet: string, maxChars = DEFAULT_SNIPPET_CHARS): string {
  const cleaned = snippet.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sliced = cleaned.slice(0, maxChars).trimEnd();
  return `${sliced}… [truncated]`;
}

export function formatSourceForOutput(
  source: SearchSource,
  index: number,
  maxSnippetChars = DEFAULT_SNIPPET_CHARS,
): string {
  const lines: string[] = [];
  lines.push(`[${index}] ${source.title}`);
  lines.push(`    ${source.url}`);

  if (source.snippet) {
    lines.push(`    ${truncateSnippet(source.snippet, maxSnippetChars)}`);
  }

  if (source.fetchedExcerpt) {
    lines.push(`    Excerpt: ${truncateSnippet(source.fetchedExcerpt, maxSnippetChars)}`);
  }

  if (source.fetchError) {
    lines.push(`    Fetch error: ${source.fetchError}`);
  }

  return lines.join("\n");
}

export function formatSourcesSection(
  sources: SearchSource[],
  maxSnippetChars = DEFAULT_SNIPPET_CHARS,
): string {
  if (sources.length === 0) {
    return "## Sources\nNo sources found.";
  }

  const rendered = sources.map((source, index) => formatSourceForOutput(source, index + 1, maxSnippetChars));
  return ["## Sources", ...rendered].join("\n");
}
