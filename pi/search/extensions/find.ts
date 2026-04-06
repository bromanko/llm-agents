import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
  buildSkipGlobArgs,
  DEFAULT_FIND_LIMIT,
  DEFAULT_SKIP_NAMES,
  hasGlobMetacharacters,
} from "../lib/constants.ts";
import { getCwd } from "../lib/execution-context.ts";
import { executeFd } from "../lib/fd.ts";
import { normalizeOffset, paginate } from "../lib/pagination.ts";
import { normalizeSeparators, validatePath } from "../lib/path-suggest.ts";
import { executeRg } from "../lib/rg.ts";
import { formatResultEnvelope } from "../lib/result-envelope.ts";
import type {
  FdExecutor,
  FindToolParams,
  PathValidationResult,
  RgExecutor,
  SearchToolDetails,
} from "../lib/types.ts";

const parameters = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Filename, directory-name, or path pattern to match." },
    path: { type: "string", description: "Path to search within, relative to the working directory, ~-relative, or absolute." },
    kind: { type: "string", enum: ["file", "directory", "any"], description: "Whether to return files, directories, or both kinds of paths." },
    maxDepth: { type: "number", description: "Maximum directory depth to descend from the search path. 0 limits results to direct children." },
    limit: { type: "number", description: "Maximum number of paths to return." },
    offset: { type: "number", description: "Result offset for pagination." },
    hidden: { type: "boolean", description: "Include hidden files and directories." },
    respectIgnore: { type: "boolean", description: "Respect ignore files such as .gitignore (default true)." },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

type ValidPathValidationResult = Extract<PathValidationResult, { valid: true }>;
type FindKind = NonNullable<FindToolParams["kind"]>;

function buildPathError(requestedPath: string, validation: Extract<PathValidationResult, { valid: false }>): string {
  if (validation.suggestions.length === 0) {
    return `Error: Path not found: ${requestedPath}`;
  }

  return `Error: Path not found: ${requestedPath}. Did you mean: ${validation.suggestions.join(", ")}`;
}

function normalizePattern(pattern: string): string {
  return hasGlobMetacharacters(pattern) ? pattern : `*${pattern}*`;
}

/**
 * Create a reusable matcher that precomputes the normalized pattern and
 * match-mode once per request, avoiding repeated string work in hot loops.
 */
function createEntryMatcher(pattern: string): (itemPath: string) => boolean {
  const normalizedPattern = normalizePattern(pattern);
  const matchFullPath = normalizedPattern.includes("/");

  return (itemPath: string) => {
    let normalizedItemPath = normalizeSeparators(itemPath);
    // Strip leading "./" so fd/rg root-scope paths match slash-containing patterns.
    if (normalizedItemPath.startsWith("./")) {
      normalizedItemPath = normalizedItemPath.slice(2);
    }
    const candidate = matchFullPath
      ? normalizedItemPath
      : path.posix.basename(normalizedItemPath);

    return path.posix.matchesGlob(candidate, normalizedPattern);
  };
}

function buildFindArgs(params: FindToolParams, scope: ValidPathValidationResult): string[] {
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

function buildFdArgs(params: FindToolParams, scope: ValidPathValidationResult, fdPattern?: string): string[] {
  const kind = params.kind ?? "file";
  const args: string[] = [];

  // When a pattern is delegated to fd, use --glob mode since our patterns
  // are globs (e.g. *foo*), not regexes. The match-all "." fallback is a
  // valid regex so it doesn't need --glob.
  if (fdPattern != null) {
    args.push("--glob", fdPattern);
  } else {
    args.push(".");
  }

  if (kind === "directory") {
    args.push("--type", "d");
  } else {
    args.push("--type", "f", "--type", "d");
  }

  const normalizedDepth = normalizeMaxDepth(params.maxDepth);
  if (normalizedDepth !== undefined) {
    args.push("--max-depth", String(normalizedDepth + 1));
  }

  if (params.hidden) args.push("--hidden");
  if (params.respectIgnore === false) args.push("--no-ignore");

  for (const name of DEFAULT_SKIP_NAMES) {
    args.push("--exclude", name);
  }

  args.push(scope.resolved);
  return args;
}

function modeForKind(kind: FindKind): string {
  switch (kind) {
    case "directory":
      return "find directories";
    case "any":
      return "find paths";
    case "file":
    default:
      return "find files";
  }
}

export function normalizeMaxDepth(maxDepth: number | undefined): number | undefined {
  if (maxDepth === undefined || !Number.isFinite(maxDepth)) {
    return undefined;
  }
  return Math.max(0, Math.floor(maxDepth));
}

export function depthWithinScope(item: string, scope: string): number {
  let normalizedItem = normalizeSeparators(item);
  const normalizedScope = normalizeSeparators(scope);

  // Strip leading "./" so items returned by fd/rg for root scope
  // (e.g. "./claude") are treated the same as bare names ("claude").
  if (normalizedItem.startsWith("./")) {
    normalizedItem = normalizedItem.slice(2);
  }

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

function buildSuccessResult(mode: string, scope: string, items: string[], params: FindToolParams) {
  const offset = normalizeOffset(params.offset);
  const page = paginate(items, {
    limit: params.limit,
    offset,
    defaultLimit: DEFAULT_FIND_LIMIT,
  });
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

export interface FindToolDeps {
  rgExecutor?: RgExecutor;
  fdExecutor?: FdExecutor;
  pathValidator?: (requestedPath: string | undefined, root: string) => Promise<PathValidationResult>;
}

export function createFindToolDefinition(deps: FindToolDeps = {}) {
  const rgExecutor = deps.rgExecutor ?? executeRg;
  const fdExecutor = deps.fdExecutor ?? executeFd;
  const pathValidator = deps.pathValidator ?? validatePath;

  return {
    name: "find",
    label: "Find",
    description: "Find files and directories with pagination, ignore controls, and path recovery. Directory and mixed-mode search require fd.",
    promptSnippet: "Find files and directories by path or name pattern with pagination.",
    promptGuidelines: [
      "Use find instead of bash find or ls for file or directory discovery whenever the structured tool can answer the question.",
      "Use kind: \"directory\" instead of bash find -type d, ls, or ls -R when the structured tool can answer the question.",
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

      const kind = params.kind ?? "file";
      const scope = validation.resolved;
      const mode = modeForKind(kind);
      const maxDepth = normalizeMaxDepth(params.maxDepth);

      // Strip leading "./" from the pattern so it matches item paths
      // consistently — both fd/rg and our own matcher strip "./" from
      // result paths, and rg --glob also rejects "./" prefixed patterns.
      const pattern = params.pattern.startsWith("./")
        ? params.pattern.slice(2)
        : params.pattern;

      if (validation.kind === "file") {
        const matchesEntry = createEntryMatcher(pattern);
        const fileItems = kind === "directory"
          ? []
          : (matchesEntry(scope) ? [scope] : []);

        return buildSuccessResult(mode, scope, applyMaxDepth(fileItems, scope, maxDepth), params);
      }

      if (kind === "file") {
        const args = buildFindArgs({ ...params, pattern }, validation);
        const rgResult = await rgExecutor(args, cwd);

        if (rgResult.error) {
          return {
            content: [{ type: "text" as const, text: `Error: ${rgResult.error}` }],
            details: { isError: true, error: rgResult.error, scope },
          };
        }

        return buildSuccessResult(mode, scope, applyMaxDepth(rgResult.lines, scope, maxDepth), params);
      }

      // Delegate basename-only patterns to fd for early filtering; fall back
      // to client-side matching only for slash-containing path patterns.
      const normalized = normalizePattern(pattern);
      const canDelegateToFd = !normalized.includes("/");
      const fdArgs = canDelegateToFd
        ? buildFdArgs(params, validation, normalized)
        : buildFdArgs(params, validation);

      const fdResult = await fdExecutor(fdArgs, cwd);
      if (fdResult.error) {
        return {
          content: [{ type: "text" as const, text: `Error: ${fdResult.error}` }],
          details: { isError: true, error: fdResult.error, scope },
        };
      }

      const matchedLines = canDelegateToFd
        ? fdResult.lines
        : fdResult.lines.filter(createEntryMatcher(pattern));
      const filteredLines = applyMaxDepth(matchedLines, scope, maxDepth);

      return buildSuccessResult(mode, scope, filteredLines, params);
    },
  };
}

export default function registerFindExtension(pi: ExtensionAPI): void {
  pi.registerTool(createFindToolDefinition());
}
