import { DEFAULT_GREP_LIMIT } from "./constants.ts";
import type { PaginationOptions, PaginationResult } from "./types.ts";

export function normalizeLimit(limit: number | undefined, defaultLimit = DEFAULT_GREP_LIMIT, maxLimit?: number): number {
  const normalized = typeof limit !== "number" || !Number.isFinite(limit)
    ? defaultLimit
    : Math.max(1, Math.floor(limit));

  if (typeof maxLimit !== "number" || !Number.isFinite(maxLimit)) return normalized;
  return Math.min(normalized, Math.max(1, Math.floor(maxLimit)));
}

export function normalizeOffset(offset: number | undefined): number {
  if (typeof offset !== "number" || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

export function paginate<T>(items: T[], options: PaginationOptions = {}): PaginationResult<T> {
  const limit = normalizeLimit(options.limit, options.defaultLimit ?? DEFAULT_GREP_LIMIT, options.maxLimit);
  const offset = normalizeOffset(options.offset);
  const totalCount = items.length;

  if (offset >= totalCount) {
    return {
      items: [],
      totalCount,
      truncated: false,
      nextOffset: undefined,
    };
  }

  const pageItems = items.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const truncated = nextOffset < totalCount;

  return {
    items: pageItems,
    totalCount,
    truncated,
    nextOffset: truncated ? nextOffset : undefined,
  };
}
