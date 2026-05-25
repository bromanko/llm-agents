export const DEFAULT_SKIP_NAMES = [
  ".git",
  ".jj",
  ".svn",
  ".hg",
  ".bzr",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "__pycache__",
] as const;

export const DEFAULT_SKIP_GLOBS = DEFAULT_SKIP_NAMES.map((name) => `!${name}`);

export const DEFAULT_GREP_LIMIT = 50;
export const MAX_GREP_LIMIT = 100;
export const GREP_MAX_COLUMNS = 500;
export const MAX_GREP_RESULT_LINE_CHARS = 500;
export const MAX_GREP_OUTPUT_CHARS = 50_000;
export const DEFAULT_FIND_LIMIT = 50;

export function buildSkipGlobArgs(): string[] {
  return DEFAULT_SKIP_GLOBS.flatMap((glob) => ["--glob", glob]);
}

export function hasGlobMetacharacters(value: string): boolean {
  return /[*?[{]/.test(value);
}
