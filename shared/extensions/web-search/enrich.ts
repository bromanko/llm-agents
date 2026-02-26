import { fetchUrl } from "../../lib/fetch-core.ts";
import type { SearchSource } from "./types.ts";

export interface EnrichOptions {
  enrich: boolean;
  fetchTop: number;
  perSourceTimeoutMs?: number;
  maxExcerptChars?: number;
}

export interface NormalizedEnrichOptions {
  enrich: boolean;
  fetchTop: number;
  perSourceTimeoutMs: number;
  maxExcerptChars: number;
}

type FetchExcerptFn = (
  url: string,
  opts: { timeoutMs: number },
) => Promise<{ excerpt: string }>;

const DEFAULT_FETCH_TOP = 0;
const MAX_FETCH_TOP = 5;
const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_MAX_EXCERPT_CHARS = 600;

function clampFetchTop(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_FETCH_TOP;
  return Math.min(MAX_FETCH_TOP, Math.max(0, Math.floor(value)));
}

export function normalizeEnrichOptions(options: EnrichOptions): NormalizedEnrichOptions {
  return {
    enrich: options.enrich,
    fetchTop: clampFetchTop(options.fetchTop),
    perSourceTimeoutMs:
      Number.isFinite(options.perSourceTimeoutMs) && (options.perSourceTimeoutMs ?? 0) > 0
        ? Math.floor(options.perSourceTimeoutMs!)
        : DEFAULT_TIMEOUT_MS,
    maxExcerptChars:
      Number.isFinite(options.maxExcerptChars) && (options.maxExcerptChars ?? 0) > 0
        ? Math.floor(options.maxExcerptChars!)
        : DEFAULT_MAX_EXCERPT_CHARS,
  };
}

function sanitizeExcerpt(excerpt: string): string {
  return excerpt
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateExcerpt(excerpt: string, maxExcerptChars: number): string {
  if (excerpt.length <= maxExcerptChars) return excerpt;
  return `${excerpt.slice(0, maxExcerptChars).trimEnd()}… [truncated]`;
}

export async function defaultFetchExcerpt(
  url: string,
  opts: { timeoutMs: number },
): Promise<{ excerpt: string }> {
  const response = await fetchUrl({
    url,
    timeoutSeconds: opts.timeoutMs / 1000,
    raw: false,
    maxBytes: 12 * 1024,
    maxLines: 200,
  });

  return { excerpt: response.content };
}

export async function enrichSourcesWithFetch(
  sources: SearchSource[],
  options: EnrichOptions,
  fetchFn: FetchExcerptFn = defaultFetchExcerpt,
): Promise<{ sources: SearchSource[]; warnings: string[] }> {
  const normalized = normalizeEnrichOptions(options);

  if (!normalized.enrich || normalized.fetchTop === 0 || sources.length === 0) {
    return { sources, warnings: [] };
  }

  const enriched = sources.map((source) => ({ ...source }));
  const warnings: string[] = [];

  const fetchCount = Math.min(normalized.fetchTop, enriched.length);
  let successCount = 0;

  for (let i = 0; i < fetchCount; i++) {
    const source = enriched[i]!;

    try {
      const fetched = await fetchFn(source.url, { timeoutMs: normalized.perSourceTimeoutMs });
      const sanitized = sanitizeExcerpt(fetched.excerpt);
      source.fetchedExcerpt = truncateExcerpt(sanitized, normalized.maxExcerptChars);
      source.fetchedAt = new Date().toISOString();
      successCount += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      source.fetchError = message;
      warnings.push(`Failed to fetch source ${i + 1} (${message}); showing search snippet only.`);
    }
  }

  if (successCount === 0 && warnings.length === fetchCount) {
    const firstWarning = warnings[0] ?? "fetch adapter failed";
    return {
      sources,
      warnings: [`Fetch enrichment unavailable (${firstWarning}). Returning base search results.`],
    };
  }

  return { sources: enriched, warnings };
}
