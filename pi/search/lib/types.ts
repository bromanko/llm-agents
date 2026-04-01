export type SearchOutputMode = "content" | "files_with_matches" | "count";

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  defaultLimit?: number;
}

export interface PaginationResult<T> {
  items: T[];
  totalCount: number;
  truncated: boolean;
  nextOffset: number | undefined;
}

export type PathKind = "file" | "directory";

export type PathValidationResult =
  | { valid: true; resolved: string; kind: PathKind }
  | { valid: false; suggestions: string[] };

export type MultiPathValidationResult =
  | { valid: true; resolved: string[] }
  | { valid: false; failedPath: string; suggestions: string[] };

export interface ResultEnvelope {
  mode: string;
  scope: string;
  items: string[];
  totalCount: number;
  truncated: boolean;
  nextOffset: number | undefined;
  offset?: number;
  summaryLine?: string;
}

export interface GrepToolParams {
  pattern?: string;
  anyOf?: string[];
  path?: string | string[];
  glob?: string;
  type?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  regex?: boolean;
  context?: number;
  limit?: number;
  offset?: number;
  outputMode?: SearchOutputMode;
  hidden?: boolean;
  respectIgnore?: boolean;
}

export interface FindToolParams {
  pattern: string;
  path?: string;
  limit?: number;
  offset?: number;
  hidden?: boolean;
  respectIgnore?: boolean;
}

export interface SearchToolDetails {
  mode: string;
  scope: string;
  items: string[];
  totalCount: number;
  returnedCount: number;
  truncated: boolean;
  nextOffset: number | undefined;
  offset: number;
  totalMatchCount?: number;
}

export interface RgResult {
  lines: string[];
  matched: boolean;
  error: string | null;
}

export type RgExecutor = (args: string[], cwd?: string) => Promise<RgResult>;

export type SinglePathValidator = (
  requestedPath: string | undefined,
  root: string,
) => Promise<PathValidationResult>;
