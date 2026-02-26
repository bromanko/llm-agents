import type { SearchProviderId, SearchRecency, SearchResponse } from "../types.ts";

export interface SearchParams {
  query: string;
  limit: number;
  recency?: SearchRecency;
  signal?: AbortSignal;
}

export interface SearchProvider {
  id: SearchProviderId;
  label: string;
  isAvailable(): Promise<boolean> | boolean;
  search(params: SearchParams): Promise<SearchResponse>;
}
