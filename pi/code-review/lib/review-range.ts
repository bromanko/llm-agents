export type FixLevel = "high" | "medium" | "low" | "all";

export interface ReviewOptions {
  range: string;
  fixLevel?: FixLevel;
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
  "Usage: /review <language> [types...] [-r|--revisions <range>] [--fix <high|medium|low|all>]";

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

    if (token === "--fix") {
      const value = tokens[i + 1];
      if (!value || value.startsWith("-")) {
        return {
          ...result,
          error: `Missing value for --fix. ${REVIEW_USAGE}`,
        };
      }

      const fixLevel = normalizeFixLevel(value);
      if (!fixLevel) {
        return {
          ...result,
          error: `Invalid --fix level "${sanitizeForDisplay(value)}". Expected one of: high, medium, low, all.`,
        };
      }

      result.options.fixLevel = fixLevel;
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

function getGitArgsForRange(range: string): string[] {
  if (range === "@") {
    return ["diff", "HEAD"];
  }

  if (range.includes("..")) {
    return ["diff", range];
  }

  return ["show", "--format=", "--patch", range];
}

/**
 * Gather diff text for a revision range.
 *
 * Behavior:
 * 1) Validate the range string
 * 2) Try jj (`jj diff -r <range> --git`)
 * 3) If jj fails, fall back to git
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
    const diff = jjResult.stdout.trim().length > 0 ? jjResult.stdout : null;
    return { diff, source: "jj" };
  }

  if (gitResult.code === 0) {
    const diff = gitResult.stdout.trim().length > 0 ? gitResult.stdout : null;
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
