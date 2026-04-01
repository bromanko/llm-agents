import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { buildSkipGlobArgs, DEFAULT_GREP_LIMIT } from "../lib/constants.ts";
import { getCwd } from "../lib/execution-context.ts";
import { paginate, normalizeOffset } from "../lib/pagination.ts";
import { validatePath, validatePaths } from "../lib/path-suggest.ts";
import { executeRg } from "../lib/rg.ts";
import { formatResultEnvelope } from "../lib/result-envelope.ts";
import type {
  GrepToolParams,
  MultiPathValidationResult,
  PathValidationResult,
  RgExecutor,
  SearchToolDetails,
  SinglePathValidator,
} from "../lib/types.ts";

const parameters = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Search pattern." },
    anyOf: {
      type: "array",
      items: { type: "string" },
      description: "Literal OR search terms. Exactly one of pattern or anyOf must be provided.",
    },
    path: {
      oneOf: [
        { type: "string", description: "Path to search within, relative to the working directory." },
        { type: "array", items: { type: "string" }, maxItems: 20, description: "Multiple paths to search within." },
      ],
      description: "Path(s) to search within, relative to the working directory.",
    },
    glob: { type: "string", description: "Optional ripgrep glob filter." },
    type: { type: "string", description: "Optional ripgrep file type alias, e.g. ts, py, json." },
    ignoreCase: { type: "boolean", description: "Ignore case when searching." },
    literal: { type: "boolean", description: "Treat pattern as literal text." },
    regex: { type: "boolean", description: "Treat pattern as a regular expression." },
    context: { type: "number", description: "Show N lines of context around each match." },
    limit: { type: "number", description: "Maximum number of result lines to return." },
    offset: { type: "number", description: "Result offset for pagination." },
    outputMode: {
      type: "string",
      enum: ["content", "files_with_matches", "count"],
      description: "Return content matches, matching files, or per-file counts.",
    },
    hidden: { type: "boolean", description: "Include hidden files." },
    respectIgnore: { type: "boolean", description: "Respect ignore files such as .gitignore (default true)." },
  },
  additionalProperties: false,
} as const;

export function buildPathError(requestedPath: string, suggestions: string[]): string {
  if (suggestions.length === 0) {
    return `Error: Path not found: ${requestedPath}`;
  }

  return `Error: Path not found: ${requestedPath}. Did you mean: ${suggestions.join(", ")}`;
}

function shouldUseLiteral(params: GrepToolParams): boolean {
  if (params.anyOf) return true;
  if (params.regex === true) return false;
  if (params.literal === false) return false;
  return true;
}

function validateInputs(params: GrepToolParams): string | null {
  if (Array.isArray(params.anyOf) && params.anyOf.length === 0) {
    return "anyOf must not be empty when provided.";
  }

  const hasPattern = typeof params.pattern === "string" && params.pattern.length > 0;
  const hasAnyOf = Array.isArray(params.anyOf) && params.anyOf.length > 0;

  if (hasPattern === hasAnyOf) {
    return "Exactly one of pattern or anyOf must be provided.";
  }

  return null;
}

function normalizeContext(context: number | undefined): number | undefined {
  if (typeof context !== "number" || !Number.isFinite(context)) {
    return undefined;
  }

  return Math.max(0, Math.floor(context));
}

function buildGrepArgs(params: GrepToolParams, scopes: string[]): string[] {
  const args = ["--color", "never"];
  const outputMode = params.outputMode ?? "content";
  const context = normalizeContext(params.context);

  if (outputMode === "content") {
    args.push("--no-heading", "-n", "-H");
    if (context !== undefined) {
      args.push("-C", String(context));
    }
  } else if (outputMode === "files_with_matches") {
    args.push("-l");
  } else if (outputMode === "count") {
    args.push("-c");
  }

  if (params.ignoreCase) args.push("-i");
  if (params.hidden) args.push("--hidden");
  if (params.respectIgnore === false) args.push("--no-ignore");

  args.push(...buildSkipGlobArgs());

  if (params.glob) args.push("--glob", params.glob);
  if (params.type) args.push("--type", params.type);
  if (shouldUseLiteral(params)) args.push("-F");

  if (Array.isArray(params.anyOf) && params.anyOf.length > 0) {
    for (const term of params.anyOf) {
      args.push("-e", term);
    }
  } else if (params.pattern) {
    args.push("-e", params.pattern);
  }

  args.push(...scopes);
  return args;
}

function parseCountLine(line: string): number {
  const delimiterIndex = line.lastIndexOf(":");
  if (delimiterIndex < 0) return 0;

  const countText = line.slice(delimiterIndex + 1);
  const count = Number.parseInt(countText, 10);
  return Number.isFinite(count) ? count : 0;
}

function sumCountModeMatches(lines: string[]): number {
  return lines.reduce((total, line) => total + parseCountLine(line), 0);
}

function buildCountModeSummary(
  items: string[],
  totalCount: number,
  totalMatchCount: number,
  offset: number,
  nextOffset: number | undefined,
  truncated: boolean,
): string {
  if (totalCount === 0) {
    return "0 results.";
  }

  if (items.length === 0 && offset > 0) {
    return `No count rows on this page. Offset=${offset} is past the end of ${totalCount} files with matches (${totalMatchCount} total matches).`;
  }

  if (truncated && nextOffset != null) {
    const start = offset + 1;
    const end = offset + items.length;
    return `Showing ${start}–${end} of ${totalCount} files with match counts (${totalMatchCount} total matches). Use offset=${nextOffset} to continue.`;
  }

  return `${totalCount} files with matches (${totalMatchCount} total matches).`;
}

function createDetails(mode: string, scope: string, items: string[], totalCount: number, offset: number, nextOffset: number | undefined, truncated: boolean, totalMatchCount?: number): SearchToolDetails {
  return {
    mode,
    scope,
    items,
    totalCount,
    returnedCount: items.length,
    truncated,
    nextOffset,
    offset,
    totalMatchCount,
  };
}

export type MultiPathValidator = (
  pathInput: string | string[] | undefined,
  root: string,
  singleValidator?: SinglePathValidator,
) => Promise<MultiPathValidationResult>;

export interface GrepToolDeps {
  rgExecutor?: RgExecutor;
  pathValidator?: SinglePathValidator;
  multiPathValidator?: MultiPathValidator;
}

export function createGrepToolDefinition(deps: GrepToolDeps = {}) {
  const rgExecutor = deps.rgExecutor ?? executeRg;
  const singlePathValidator = deps.pathValidator ?? validatePath;
  const multiPathValidator = deps.multiPathValidator ?? validatePaths;

  return {
    name: "grep",
    label: "Grep",
    description: "Search file contents with literal-first matching, pagination, and path recovery.",
    parameters,

    async execute(
      _toolCallId: string,
      params: GrepToolParams,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: unknown,
    ) {
      const inputError = validateInputs(params);
      if (inputError) {
        return {
          content: [{ type: "text" as const, text: `Error: ${inputError}` }],
          details: { isError: true, error: inputError },
        };
      }

      const cwd = getCwd(ctx);
      const validation = await multiPathValidator(params.path, cwd, singlePathValidator);
      if (!validation.valid) {
        const requestedPath = validation.failedPath;
        return {
          content: [{ type: "text" as const, text: buildPathError(requestedPath, validation.suggestions) }],
          details: { isError: true, error: `Path not found: ${requestedPath}`, suggestions: validation.suggestions },
        };
      }

      const scopes = validation.resolved;
      const scope = scopes.join(", ");
      const args = buildGrepArgs(params, scopes);
      const rgResult = await rgExecutor(args, cwd);

      if (rgResult.error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${rgResult.error}` }],
          details: { isError: true, error: rgResult.error, scope },
        };
      }

      const offset = normalizeOffset(params.offset);
      const page = paginate(rgResult.lines, {
        limit: params.limit,
        offset,
        defaultLimit: DEFAULT_GREP_LIMIT,
      });
      const outputMode = params.outputMode ?? "content";
      const mode = `grep ${outputMode}`;
      const totalMatchCount = outputMode === "count" ? sumCountModeMatches(rgResult.lines) : undefined;
      const summaryLine = outputMode === "count"
        ? buildCountModeSummary(page.items, page.totalCount, totalMatchCount ?? 0, offset, page.nextOffset, page.truncated)
        : undefined;
      const text = formatResultEnvelope({
        mode,
        scope,
        items: page.items,
        totalCount: page.totalCount,
        truncated: page.truncated,
        nextOffset: page.nextOffset,
        offset,
        summaryLine,
      });

      return {
        content: [{ type: "text" as const, text }],
        details: createDetails(mode, scope, page.items, page.totalCount, offset, page.nextOffset, page.truncated, totalMatchCount),
      };
    },
  };
}

export default function registerGrepExtension(pi: ExtensionAPI): void {
  pi.registerTool(createGrepToolDefinition());
}
