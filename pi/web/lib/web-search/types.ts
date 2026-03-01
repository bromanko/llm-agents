export type SearchProviderId = "brave";

export type SearchRecency = "day" | "week" | "month" | "year";

export interface SearchSource {
  title: string;
  url: string;
  snippet?: string;
  publishedDate?: string;
  ageSeconds?: number;
  fetchedExcerpt?: string;
  fetchedAt?: string;
  fetchError?: string;
}

export interface SearchResponse {
  provider: SearchProviderId | "none";
  answer?: string;
  sources: SearchSource[];
  requestId?: string;
  warnings?: string[];
}

export class SearchProviderError extends Error {
  readonly provider: SearchProviderId;
  readonly status?: number;

  constructor(provider: SearchProviderId, message: string, status?: number) {
    super(message);
    this.name = "SearchProviderError";
    this.provider = provider;
    this.status = status;
  }
}
