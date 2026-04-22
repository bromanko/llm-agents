export type FixLevel = "high" | "medium" | "low" | "all";

export interface ReviewOptions {
  range: string;
  fixLevel?: FixLevel;
  reportLevel?: FixLevel;
}

export interface ParsedReviewArgs {
  language: string | undefined;
  types: string[];
  options: ReviewOptions;
  error?: string;
}

export interface RangeDiffResult {
  diff: string | null;
  source: "jj" | "git" | null;
  error?: string;
}

export const REVIEW_USAGE =
  "Usage: /review <language> [types...] [-r|--revisions <range>] [--fix <high|medium|low|all>] [--report <high|medium|low|all>]";

/** Pattern for safe VCS revision range characters. */
const SAFE_RANGE_PATTERN = /^[a-zA-Z0-9@._~^:\-\/]+$/;

/**
 * Validate that a range string contains only safe VCS revision characters
 * and cannot be interpreted as a flag.
 */
export function validateRange(range: string): boolean {
  return SAFE_RANGE_PATTERN.test(range) && !range.startsWith("-");
}

/**
 * Sanitize user-provided strings for inclusion in display messages.
 * Strips control characters and truncates to a maximum length.
 */
export function sanitizeForDisplay(input: string, maxLen = 100): string {
  return input
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`)
    .slice(0, maxLen);
}

function normalizeFixLevel(value: string): FixLevel | undefined {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "high" ||
    normalized === "medium" ||
    normalized === "low" ||
    normalized === "all"
  ) {
    return normalized;
  }
  return undefined;
}

/**
 * Parse /review command arguments.
 */
export function parseReviewArgs(args: string): ParsedReviewArgs {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  const result: ParsedReviewArgs = {
    language: undefined,
    types: [],
    options: { range: "@" },
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;

    if (token === "-r" || token === "--revisions") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        return {
          ...result,
          error: `Missing value for ${token}. ${REVIEW_USAGE}`,
        };
      }
      result.options.range = value;
      i += 1;
      continue;
    }

    if (token === "--fix" || token === "--report") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        return {
          ...result,
          error: `Missing value for ${token}. ${REVIEW_USAGE}`,
        };
      }

      const level = normalizeFixLevel(value);
      if (!level) {
        return {
          ...result,
          error: `Invalid ${token} level "${sanitizeForDisplay(value)}". Expected one of: high, medium, low, all.`,
        };
      }

      if (token === "--fix") {
        result.options.fixLevel = level;
      } else {
        result.options.reportLevel = level;
      }
      i += 1;
      continue;
    }

    if (token.startsWith("-")) {
      return {
        ...result,
        error: `Unknown flag: ${sanitizeForDisplay(token)}. ${REVIEW_USAGE}`,
      };
    }

    if (!result.language) {
      result.language = token;
    } else {
      result.types.push(token);
    }
  }

  if (result.options.fixLevel && result.options.reportLevel) {
    return {
      ...result,
      error: "Cannot use --fix and --report together. Choose one post-review action.",
    };
  }

  return result;
}

function summarizeCommandFailure(command: string, result: {
  code: number;
  stdout: string;
  stderr: string;
}): string {
  const raw = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
  const truncated = raw.slice(0, 200);
  return `${command}: ${truncated}${raw.length > 200 ? "…" : ""}`;
}

/**
 * Translate a jj-style `@` to git's `HEAD` in a revision range.
 *
 * `@` is jj syntax for the current working-copy commit; git uses `HEAD`.
 * This replaces standalone `@` tokens (delimited by `..` boundaries or
 * start/end of string) but leaves email-like or other embedded `@` untouched.
 */
export function translateJjToGitRange(range: string): string {
  return range.replace(/(^|(?:\.\.))@(?=(\.\.)|$)/g, "$1HEAD");
}

export function rangeIncludesWorkingCopy(range: string): boolean {
  return /(^|(?:\.\.))@(?=(\.\.)|$)/.test(range);
}

function getGitArgsForRange(range: string): string[] {
  const gitRange = translateJjToGitRange(range);

  if (gitRange === "HEAD") {
    return ["diff", "HEAD"];
  }

  if (gitRange.includes("..")) {
    return ["diff", gitRange];
  }

  return ["show", "--format=", "--patch", gitRange];
}

export function normalizeDiff(diff: string | null): string | null {
  if (!diff || diff.trim().length === 0) {
    return null;
  }
  return diff.trimEnd() + "\n";
}

export function extractDiffFilePaths(diff: string | null): Set<string> {
  const paths = new Set<string>();
  if (!diff) return paths;

  for (const line of diff.split("\n")) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match) {
      paths.add(match[1]!);
    }
  }

  return paths;
}

// Even when jj succeeds, we still scan for untracked files via `git ls-files --others`.
// jj-managed repos can have files that are gitignored but not jj-ignored (or vice versa),
// so jj's diff may miss files that git considers untracked. The deduplication via
// extractDiffFilePaths ensures we only append entries not already covered.
async function appendMissingUntrackedDiffs(
  pi: {
    exec(
      command: string,
      args?: string[],
      options?: { timeout?: number; cwd?: string },
    ): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
  },
  execOptions: { timeout?: number; cwd?: string },
  diff: string | null,
): Promise<string | null> {
  const untrackedListResult = await pi.exec(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    execOptions,
  ).catch(() => ({ code: 1, stdout: "", stderr: "", killed: false }));

  const baseDiff = normalizeDiff(diff);
  if (untrackedListResult.code !== 0 || untrackedListResult.stdout.length === 0) {
    return baseDiff;
  }

  const existingPaths = extractDiffFilePaths(baseDiff);
  const untrackedPaths = untrackedListResult.stdout
    .split("\0")
    .filter(Boolean)
    .filter((filePath) => !existingPaths.has(filePath))
    .filter((filePath) => filePath.length > 0 && !/[\x00\n\r]/.test(filePath));

  if (untrackedPaths.length === 0) {
    return baseDiff;
  }

  const CONCURRENCY_LIMIT = 10;
  const appendedSections: string[] = [];
  for (let i = 0; i < untrackedPaths.length; i += CONCURRENCY_LIMIT) {
    const batch = untrackedPaths.slice(i, i + CONCURRENCY_LIMIT);
    const results = await Promise.all(
      batch.map((filePath) =>
        pi.exec(
          "git",
          ["diff", "--no-index", "--", "/dev/null", filePath],
          execOptions,
        ).catch(() => ({ code: 2 as number, stdout: "", stderr: "", killed: false }))
      ),
    );
    for (const result of results) {
      if (result.code !== 0 && result.code !== 1) continue;
      const normalizedSection = normalizeDiff(result.stdout);
      if (normalizedSection) {
        appendedSections.push(normalizedSection.trimEnd());
      }
    }
  }

  if (appendedSections.length === 0) {
    return baseDiff;
  }

  const sections = [baseDiff?.trimEnd(), ...appendedSections].filter(Boolean);
  return sections.length > 0 ? sections.join("\n") + "\n" : null;
}

/**
 * Gather diff text for a revision range.
 *
 * Behavior:
 * 1) Validate the range string
 * 2) Try jj (`jj diff -r <range> --git`)
 * 3) If jj fails, fall back to git
 * 4) When reviewing the working copy (`@`), append missing untracked-file diffs
 */
export async function gatherRangeDiff(
  pi: {
    exec(
      command: string,
      args?: string[],
      options?: { timeout?: number; cwd?: string },
    ): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
  },
  ctx: { cwd?: string },
  range: string,
): Promise<RangeDiffResult> {
  if (!validateRange(range)) {
    return {
      diff: null,
      source: null,
      error: `Invalid range "${sanitizeForDisplay(range)}": contains disallowed characters.`,
    };
  }

  const execOptions = {
    timeout: 10000,
    cwd: ctx.cwd,
  };

  const jjArgs = ["diff", "-r", range, "--git"];
  const gitArgs = getGitArgsForRange(range);

  const failResult = { code: 1, stdout: "", stderr: "", killed: false };
  const [jjResult, gitResult] = await Promise.all([
    pi.exec("jj", jjArgs, execOptions).catch(() => failResult),
    pi.exec("git", gitArgs, execOptions).catch(() => failResult),
  ]);

  if (jjResult.code === 0) {
    const baseDiff = normalizeDiff(jjResult.stdout);
    const diff = rangeIncludesWorkingCopy(range)
      ? await appendMissingUntrackedDiffs(pi, execOptions, baseDiff)
      : baseDiff;
    return { diff, source: "jj" };
  }

  if (gitResult.code === 0) {
    const baseDiff = normalizeDiff(gitResult.stdout);
    const diff = rangeIncludesWorkingCopy(range)
      ? await appendMissingUntrackedDiffs(pi, execOptions, baseDiff)
      : baseDiff;
    return { diff, source: "git" };
  }

  const jjSummary = summarizeCommandFailure(`jj ${jjArgs.join(" ")}`, jjResult);
  const gitSummary = summarizeCommandFailure(`git ${gitArgs.join(" ")}`, gitResult);

  return {
    diff: null,
    source: null,
    error:
      `Could not gather diff for range "${sanitizeForDisplay(range)}".\n` +
      `${jjSummary}\n` +
      `${gitSummary}`,
  };
}
