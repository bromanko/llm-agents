import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { buildSkipGlobArgs, DEFAULT_FIND_LIMIT, hasGlobMetacharacters } from "../lib/constants.ts";
import { getCwd } from "../lib/execution-context.ts";
import { normalizeOffset, paginate } from "../lib/pagination.ts";
import { normalizeSeparators, validatePath } from "../lib/path-suggest.ts";
import { executeRg } from "../lib/rg.ts";
import { formatResultEnvelope } from "../lib/result-envelope.ts";
import type {
  FindToolParams,
  PathValidationResult,
  RgExecutor,
  SearchToolDetails,
} from "../lib/types.ts";

const parameters = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Filename glob or plain substring to match." },
    path: { type: "string", description: "Path to search within, relative to the working directory, ~-relative, or absolute." },
    maxDepth: { type: "number", description: "Maximum directory depth to descend from the search path. 0 limits results to direct children." },
    limit: { type: "number", description: "Maximum number of file paths to return." },
    offset: { type: "number", description: "Result offset for pagination." },
    hidden: { type: "boolean", description: "Include hidden files." },
    respectIgnore: { type: "boolean", description: "Respect ignore files such as .gitignore (default true)." },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

function buildPathError(requestedPath: string, validation: Extract<PathValidationResult, { valid: false }>): string {
  if (validation.suggestions.length === 0) {
    return `Error: Path not found: ${requestedPath}`;
  }

  return `Error: Path not found: ${requestedPath}. Did you mean: ${validation.suggestions.join(", ")}`;
}

function normalizePattern(pattern: string): string {
  return hasGlobMetacharacters(pattern) ? pattern : `*${pattern}*`;
}

function buildFindArgs(params: FindToolParams, scope: Extract<PathValidationResult, { valid: true }>): string[] {
  const args = ["--files"];

  if (params.hidden) args.push("--hidden");
  if (params.respectIgnore === false) args.push("--no-ignore");

  // Push --max-depth to rg so it can prune directory traversal early.
  // rg counts traversal levels (0 = don't descend), while our maxDepth
  // counts file depth within the scope (0 = direct children), so add 1.
  const normalizedDepth = normalizeMaxDepth(params.maxDepth);
  if (normalizedDepth !== undefined) {
    args.push("--max-depth", String(normalizedDepth + 1));
  }

  args.push(...buildSkipGlobArgs());
  args.push("--glob", normalizePattern(params.pattern));
  if (scope.kind === "directory") {
    args.push(scope.resolved);
  }

  return args;
}

function fileTargetMatchesPattern(pattern: string, filePath: string): boolean {
  const normalizedPattern = normalizePattern(pattern);
  const normalizedFilePath = normalizeSeparators(filePath);
  const candidate = normalizedPattern.includes("/")
    ? normalizedFilePath
    : path.posix.basename(normalizedFilePath);

  return path.posix.matchesGlob(candidate, normalizedPattern);
}

export function normalizeMaxDepth(maxDepth: number | undefined): number | undefined {
  if (maxDepth === undefined || !Number.isFinite(maxDepth)) {
    return undefined;
  }
  return Math.max(0, Math.floor(maxDepth));
}

export function depthWithinScope(item: string, scope: string): number {
  const normalizedItem = normalizeSeparators(item);
  const normalizedScope = normalizeSeparators(scope);

  const relative = normalizedScope === "."
    ? normalizedItem
    : normalizedItem === normalizedScope
      ? ""
      : normalizedItem.startsWith(`${normalizedScope}/`)
        ? normalizedItem.slice(normalizedScope.length + 1)
        : normalizedItem;

  if (relative === "") return 0;
  return relative.split("/").length - 1;
}

function applyMaxDepth(items: string[], scope: string, maxDepth: number | undefined): string[] {
  const normalizedMaxDepth = normalizeMaxDepth(maxDepth);
  if (normalizedMaxDepth === undefined) {
    return items;
  }

  return items.filter((item) => depthWithinScope(item, scope) <= normalizedMaxDepth);
}

function createDetails(mode: string, scope: string, items: string[], totalCount: number, offset: number, nextOffset: number | undefined, truncated: boolean): SearchToolDetails {
  return {
    mode,
    scope,
    items,
    totalCount,
    returnedCount: items.length,
    truncated,
    nextOffset,
    offset,
  };
}

export interface FindToolDeps {
  rgExecutor?: RgExecutor;
  pathValidator?: (requestedPath: string | undefined, root: string) => Promise<PathValidationResult>;
}

export function createFindToolDefinition(deps: FindToolDeps = {}) {
  const rgExecutor = deps.rgExecutor ?? executeRg;
  const pathValidator = deps.pathValidator ?? validatePath;

  return {
    name: "find",
    label: "Find",
    description: "Find files with pagination, ignore controls, and path recovery.",
    promptSnippet: "Find files by path or filename pattern with pagination.",
    promptGuidelines: [
      "Use find instead of bash find or ls for file discovery whenever the structured tool can answer the question.",
      "Use maxDepth for shallow listings instead of bash find -maxdepth or ls -R when the structured tool can answer the question.",
      "Prefer limit and offset over piping bash output to head, tail, or sed for pagination.",
    ],
    parameters,

    async execute(
      _toolCallId: string,
      params: FindToolParams,
      _signal?: AbortSignal,
      _onUpdate?: unknown,
      ctx?: unknown,
    ) {
      const cwd = getCwd(ctx);
      const validation = await pathValidator(params.path, cwd);
      if (!validation.valid) {
        const requestedPath = params.path ?? ".";
        return {
          content: [{ type: "text" as const, text: buildPathError(requestedPath, validation) }],
          details: { isError: true, error: `Path not found: ${requestedPath}`, suggestions: validation.suggestions },
        };
      }

      const scope = validation.resolved;
      const offset = normalizeOffset(params.offset);
      const allItems = validation.kind === "file"
        ? (fileTargetMatchesPattern(params.pattern, scope) ? [scope] : [])
        : null;
      const maxDepth = normalizeMaxDepth(params.maxDepth);

      if (allItems === null) {
        const args = buildFindArgs(params, validation);
        const rgResult = await rgExecutor(args, cwd);

        if (rgResult.error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rgResult.error}` }],
            details: { isError: true, error: rgResult.error, scope },
          };
        }

        // Client-side depth filter as a safety net — rg already limits traversal
        // via --max-depth, but we re-check here to guarantee correctness.
        const filteredLines = applyMaxDepth(rgResult.lines, scope, maxDepth);
        const page = paginate(filteredLines, {
          limit: params.limit,
          offset,
          defaultLimit: DEFAULT_FIND_LIMIT,
        });
        const mode = "find files";
        const text = formatResultEnvelope({
          mode,
          scope,
          items: page.items,
          totalCount: page.totalCount,
          truncated: page.truncated,
          nextOffset: page.nextOffset,
          offset,
        });

        return {
          content: [{ type: "text" as const, text }],
          details: createDetails(mode, scope, page.items, page.totalCount, offset, page.nextOffset, page.truncated),
        };
      }

      const filteredItems = applyMaxDepth(allItems, scope, maxDepth);
      const page = paginate(filteredItems, {
        limit: params.limit,
        offset,
        defaultLimit: DEFAULT_FIND_LIMIT,
      });
      const mode = "find files";
      const text = formatResultEnvelope({
        mode,
        scope,
        items: page.items,
        totalCount: page.totalCount,
        truncated: page.truncated,
        nextOffset: page.nextOffset,
        offset,
      });

      return {
        content: [{ type: "text" as const, text }],
        details: createDetails(mode, scope, page.items, page.totalCount, offset, page.nextOffset, page.truncated),
      };
    },
  };
}

export default function registerFindExtension(pi: ExtensionAPI): void {
  pi.registerTool(createFindToolDefinition());
}
