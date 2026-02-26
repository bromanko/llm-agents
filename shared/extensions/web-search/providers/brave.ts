import type { SearchProvider, SearchParams } from "./base.ts";
import {
  SearchProviderError,
  type SearchRecency,
  type SearchResponse,
  type SearchSource,
} from "../types.ts";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const MIN_LIMIT = 1;
const MAX_LIMIT = 10;

export const BRAVE_MISSING_KEY_ERROR =
  "BRAVE_API_KEY not found. Set it in environment before using web_search.";

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.floor(limit)));
}

export function mapRecencyToBraveFreshness(recency?: SearchRecency): "pd" | "pw" | "pm" | "py" | undefined {
  switch (recency) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
}

function parseAgeSeconds(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return raw;
  }

  if (typeof raw !== "string") return undefined;
  const match = raw.trim().toLowerCase().match(/^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!match) return undefined;

  const count = Number.parseInt(match[1]!, 10);
  const unit = match[2]!;
  const secondsPerUnit: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 60 * 60,
    day: 60 * 60 * 24,
    week: 60 * 60 * 24 * 7,
    month: 60 * 60 * 24 * 30,
    year: 60 * 60 * 24 * 365,
  };

  return count * (secondsPerUnit[unit] ?? 0);
}

export function parseBraveWebResponse(payload: unknown): {
  sources: SearchSource[];
  requestId?: string;
} {
  const data = payload as {
    request_id?: unknown;
    query?: { request_id?: unknown };
    web?: { results?: Array<Record<string, unknown>> };
  };

  const requestId =
    typeof data?.request_id === "string"
      ? data.request_id
      : typeof data?.query?.request_id === "string"
        ? data.query.request_id
        : undefined;

  const results = Array.isArray(data?.web?.results) ? data.web.results : [];

  const sources: SearchSource[] = [];
  for (const result of results) {
    const title = typeof result.title === "string" ? result.title.trim() : "";
    const url = typeof result.url === "string" ? result.url.trim() : "";

    if (!title || !url) {
      continue;
    }

    const snippet =
      typeof result.description === "string"
        ? result.description.trim()
        : typeof result.snippet === "string"
          ? result.snippet.trim()
          : undefined;

    const publishedDate = typeof result.page_age === "string" ? result.page_age : undefined;
    const ageSeconds = parseAgeSeconds(result.age);

    sources.push({
      title,
      url,
      snippet: snippet && snippet.length > 0 ? snippet : undefined,
      publishedDate,
      ageSeconds,
    });
  }

  return { sources, requestId };
}

export class BraveSearchProvider implements SearchProvider {
  readonly id = "brave" as const;
  readonly label = "Brave";

  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;

  constructor(fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env) {
    this.fetchImpl = fetchImpl;
    this.env = env;
  }

  isAvailable(): boolean {
    return Boolean(this.env.BRAVE_API_KEY?.trim());
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const apiKey = this.env.BRAVE_API_KEY?.trim();
    if (!apiKey) {
      throw new SearchProviderError(this.id, BRAVE_MISSING_KEY_ERROR);
    }

    const url = new URL(BRAVE_ENDPOINT);
    url.searchParams.set("q", params.query);
    url.searchParams.set("count", String(clampLimit(params.limit)));

    const freshness = mapRecencyToBraveFreshness(params.recency);
    if (freshness) {
      url.searchParams.set("freshness", freshness);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        signal: params.signal,
      });
    } catch (error) {
      throw new SearchProviderError(this.id, `Brave search request failed: ${String(error)}`);
    }

    if (!response.ok) {
      throw new SearchProviderError(
        this.id,
        `Brave search request failed with status ${response.status}.`,
        response.status,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new SearchProviderError(this.id, "Brave search returned invalid JSON.");
    }

    const parsed = parseBraveWebResponse(payload);

    return {
      provider: this.id,
      sources: parsed.sources,
      requestId: parsed.requestId,
    };
  }
}
