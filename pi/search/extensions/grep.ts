import os from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildSkipGlobArgs,
  DEFAULT_GREP_LIMIT,
  GREP_MAX_COLUMNS,
  MAX_GREP_LIMIT,
  MAX_GREP_OUTPUT_CHARS,
  MAX_GREP_RESULT_LINE_CHARS,
} from "../lib/constants.ts";
import { getCwd } from "../lib/execution-context.ts";
import { paginate, normalizeOffset } from "../lib/pagination.ts";
import { validatePath, validatePaths } from "../lib/path-suggest.ts";
import { executeRg } from "../lib/rg.ts";
import { formatResultEnvelope } from "../lib/result-envelope.ts";
import { truncateToWidth } from "../lib/truncate.ts";
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
        { type: "string", description: "Path to search within, relative to the working directory, ~-relative, or absolute." },
        { type: "array", items: { type: "string" }, maxItems: 20, description: "Multiple paths to search within; each may be relative to the working directory, ~-relative, or absolute." },
      ],
      description: "Path(s) to search within, relative to the working directory, ~-relative, or absolute.",
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
    args.push("--no-heading", "-n", "-H", "--max-columns", String(GREP_MAX_COLUMNS), "--max-columns-preview");
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

interface SafeGrepPage {
  items: string[];
  totalCount: number;
  truncated: boolean;
  nextOffset: number | undefined;
  lineTruncatedCount: number;
  budgetTruncated: boolean;
  omittedForBudget: number;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

function truncateLineToChars(line: string, maxChars = MAX_GREP_RESULT_LINE_CHARS): { text: string; truncated: boolean } {
  if (line.length <= maxChars) return { text: line, truncated: false };
  if (maxChars <= 1) return { text: "…".slice(0, Math.max(0, maxChars)), truncated: true };

  let omitted = line.length - maxChars;
  let suffix = `… [truncated ${omitted} ${pluralize(omitted, "char")}]`;
  let keepChars = maxChars - suffix.length;

  if (keepChars < 1) {
    return { text: `${line.slice(0, maxChars - 1)}…`, truncated: true };
  }

  omitted = line.length - keepChars;
  suffix = `… [truncated ${omitted} ${pluralize(omitted, "char")}]`;
  keepChars = maxChars - suffix.length;

  if (keepChars < 1) {
    return { text: `${line.slice(0, maxChars - 1)}…`, truncated: true };
  }

  return { text: `${line.slice(0, keepChars)}${suffix}`, truncated: true };
}

function applyGrepOutputSafety(items: string[], totalCount: number, offset: number): SafeGrepPage {
  const safeItems: string[] = [];
  let lineTruncatedCount = 0;
  let budgetTruncated = false;
  let omittedForBudget = 0;
  let usedChars = 0;

  for (let index = 0; index < items.length; index += 1) {
    const bounded = truncateLineToChars(items[index]);
    const separatorChars = safeItems.length === 0 ? 0 : 1;
    const nextUsedChars = usedChars + separatorChars + bounded.text.length;
    if (nextUsedChars > MAX_GREP_OUTPUT_CHARS) {
      budgetTruncated = true;
      omittedForBudget = items.length - index;
      break;
    }

    if (bounded.truncated) lineTruncatedCount += 1;
    safeItems.push(bounded.text);
    usedChars = nextUsedChars;
  }

  const nextOffset = offset + safeItems.length < totalCount ? offset + safeItems.length : undefined;

  return {
    items: safeItems,
    totalCount,
    truncated: nextOffset !== undefined,
    nextOffset,
    lineTruncatedCount,
    budgetTruncated,
    omittedForBudget,
  };
}

function buildStandardSummary(items: string[], totalCount: number, offset: number, nextOffset: number | undefined, truncated: boolean): string {
  if (totalCount === 0) {
    return "0 results.";
  }

  if (items.length === 0 && offset > 0) {
    return `No results on this page. Offset=${offset} is past the end of ${totalCount} total results.`;
  }

  if (truncated && nextOffset != null) {
    const start = offset + 1;
    const end = offset + items.length;
    return `Showing ${start}–${end} of ${totalCount} results. Use offset=${nextOffset} to continue.`;
  }

  return `${totalCount} results.`;
}

function buildSafetyNotes(page: SafeGrepPage): string[] {
  const notes: string[] = [];

  if (page.lineTruncatedCount > 0) {
    notes.push(`Output safety: truncated ${page.lineTruncatedCount} long result ${pluralize(page.lineTruncatedCount, "line")} to ${MAX_GREP_RESULT_LINE_CHARS} characters.`);
  }

  if (page.budgetTruncated) {
    const continuation = page.nextOffset != null ? ` Use offset=${page.nextOffset} to continue.` : "";
    notes.push(`Output safety: omitted ${page.omittedForBudget} result ${pluralize(page.omittedForBudget, "line")} from this page after ${MAX_GREP_OUTPUT_CHARS} characters.${continuation}`);
  }

  return notes;
}

function addSafetyNotes(summaryLine: string, page: SafeGrepPage): string {
  const notes = buildSafetyNotes(page);
  return notes.length === 0 ? summaryLine : [...notes, summaryLine].join("\n");
}

function shortenPath(p: string): string {
  const home = os.homedir();
  if (p.startsWith(home)) {
    return `~${p.slice(home.length)}`;
  }
  return p;
}

interface ToolComponent {
  render(width: number): string[];
  invalidate(): void;
}

function renderAsSimpleComponent(text: string): ToolComponent {
  return {
    render(width: number): string[] {
      return text.split("\n").map((line) => truncateToWidth(line, width));
    },
    invalidate() { },
  };
}

function formatGrepCallHeader(args: GrepToolParams): string {
  // Pattern display: prefer pattern, fall back to anyOf terms
  let patternDisplay: string;
  if (typeof args.pattern === "string") {
    patternDisplay = `/${args.pattern}/`;
  } else if (Array.isArray(args.anyOf) && args.anyOf.length > 0) {
    patternDisplay = args.anyOf.map((t) => `"${t}"`).join(" | ");
  } else {
    patternDisplay = "//";
  }

  // Path display: handle string, array, or missing
  let pathDisplay: string;
  if (typeof args.path === "string") {
    pathDisplay = shortenPath(args.path || ".");
  } else if (Array.isArray(args.path) && args.path.length > 0) {
    pathDisplay = args.path.map((p) => shortenPath(p)).join(", ");
  } else {
    pathDisplay = ".";
  }

  let header = `grep ${patternDisplay} in ${pathDisplay}`;
  if (args.glob) header += ` (${args.glob})`;
  if (args.type) header += ` type:${args.type}`;
  if (args.limit !== undefined) header += ` limit ${args.limit}`;
  if (args.outputMode && args.outputMode !== "content") header += ` [${args.outputMode}]`;
  return header;
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
    promptSnippet: "Search file contents with pagination and path-aware scoping.",
    promptGuidelines: [
      "Use grep instead of bash grep or rg for content searches whenever the structured tool can answer the question.",
      "Prefer outputMode, glob, type, context, limit, and offset over shell pipes when shaping search output.",
    ],
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
        maxLimit: MAX_GREP_LIMIT,
      });
      const safePage = applyGrepOutputSafety(page.items, page.totalCount, offset);
      const outputMode = params.outputMode ?? "content";
      const mode = `grep ${outputMode}`;
      const totalMatchCount = outputMode === "count" ? sumCountModeMatches(rgResult.lines) : undefined;
      const summaryLine = outputMode === "count"
        ? addSafetyNotes(buildCountModeSummary(safePage.items, safePage.totalCount, totalMatchCount ?? 0, offset, safePage.nextOffset, safePage.truncated), safePage)
        : buildSafetyNotes(safePage).length > 0
          ? addSafetyNotes(buildStandardSummary(safePage.items, safePage.totalCount, offset, safePage.nextOffset, safePage.truncated), safePage)
          : undefined;
      const text = formatResultEnvelope({
        mode,
        scope,
        items: safePage.items,
        totalCount: safePage.totalCount,
        truncated: safePage.truncated,
        nextOffset: safePage.nextOffset,
        offset,
        summaryLine,
      });

      return {
        content: [{ type: "text" as const, text }],
        details: createDetails(mode, scope, safePage.items, safePage.totalCount, offset, safePage.nextOffset, safePage.truncated, totalMatchCount),
      };
    },

    renderCall(args: GrepToolParams) {
      return renderAsSimpleComponent(formatGrepCallHeader(args));
    },
  };
}

export default function registerGrepExtension(pi: ExtensionAPI): void {
  pi.registerTool(createGrepToolDefinition());
}
