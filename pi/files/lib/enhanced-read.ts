import { accessSync, constants, createReadStream } from "node:fs";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import * as os from "node:os";
import { isAbsolute, resolve as resolvePath, extname } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NARROW_NO_BREAK_SPACE = "\u202F";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);

export interface EnhancedReadParams {
  path: string;
  offset?: number;
  limit?: number;
  endLine?: number;
  tail?: number;
  aroundLine?: number;
  context?: number;
}

export interface NormalizedReadRequest {
  path: string;
  offset: number;
  limit?: number;
  rangeLabel: string;
}

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  firstLineExceedsLimit: boolean;
  maxLines: number;
  maxBytes: number;
}

export interface EnhancedReadDeps {
  stat(path: string): Promise<{ size: number; mtimeMs: number; isDirectory?: () => boolean }>;
  access(path: string): Promise<void>;
}

export interface EnhancedReadResult {
  content: Array<{ type: "text"; text: string }>;
  details?: {
    truncation?: TruncationResult;
  };
}

const defaultDeps: EnhancedReadDeps = {
  stat: (path) => fsStat(path),
  access: (path) => fsAccess(path, constants.R_OK),
};

interface ParsedRangeRequest {
  kind: "range";
  path: string;
  offset: number;
  limit?: number;
}

interface ParsedTailRequest {
  kind: "tail";
  path: string;
  tail: number;
}

interface ParsedAroundRequest {
  kind: "around";
  path: string;
  aroundLine: number;
  context: number;
}

type ParsedReadRequest = ParsedRangeRequest | ParsedTailRequest | ParsedAroundRequest;

function normalizeUnicodeSpaces(value: string): string {
  return value.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function expandPathLikePi(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));

  if (normalized === "~") {
    return os.homedir();
  }

  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }

  return normalized;
}

function tryMacOSScreenshotPath(filePath: string): string {
  return filePath.replace(/ (AM|PM)\./g, `${NARROW_NO_BREAK_SPACE}$1.`);
}

function tryNFDVariant(filePath: string): string {
  return filePath.normalize("NFD");
}

function tryCurlyQuoteVariant(filePath: string): string {
  return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
  try {
    accessSync(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveReadPathLikePi(filePath: string, cwd: string): string {
  const expanded = expandPathLikePi(filePath);
  const resolved = isAbsolute(expanded) ? expanded : resolvePath(cwd, expanded);

  if (fileExists(resolved)) {
    return resolved;
  }

  const amPmVariant = tryMacOSScreenshotPath(resolved);
  if (amPmVariant !== resolved && fileExists(amPmVariant)) {
    return amPmVariant;
  }

  const nfdVariant = tryNFDVariant(resolved);
  if (nfdVariant !== resolved && fileExists(nfdVariant)) {
    return nfdVariant;
  }

  const curlyVariant = tryCurlyQuoteVariant(resolved);
  if (curlyVariant !== resolved && fileExists(curlyVariant)) {
    return curlyVariant;
  }

  const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
  if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
    return nfdCurlyVariant;
  }

  return resolved;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function validationError(message: string): never {
  throw new Error(message);
}

function validatePositiveInteger(name: string, value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    validationError(`${name} must be a positive integer`);
  }
  return value;
}

function formatRangeLabel(offset: number, limit: number | undefined, mode: "range" | "tail" = "range"): string {
  if (mode === "tail" && limit !== undefined) {
    return `last ${limit} lines`;
  }

  if (limit === undefined) {
    return `lines ${offset}+`;
  }

  const endLine = offset + limit - 1;
  return `lines ${offset}-${endLine}`;
}

function parseReadRequest(params: EnhancedReadParams): ParsedReadRequest {
  const offset = validatePositiveInteger("offset", params.offset);
  const limit = validatePositiveInteger("limit", params.limit);
  const endLine = validatePositiveInteger("endLine", params.endLine);
  const tail = validatePositiveInteger("tail", params.tail);
  const aroundLine = validatePositiveInteger("aroundLine", params.aroundLine);
  const context = params.context === undefined ? undefined : validatePositiveInteger("context", params.context);

  if (params.context !== undefined && aroundLine === undefined) {
    validationError("context requires aroundLine");
  }

  if (aroundLine !== undefined && (offset !== undefined || limit !== undefined || endLine !== undefined || tail !== undefined)) {
    validationError("aroundLine cannot be combined with offset, limit, endLine, or tail");
  }

  if (tail !== undefined && (offset !== undefined || limit !== undefined || endLine !== undefined || aroundLine !== undefined)) {
    validationError("tail cannot be combined with offset, limit, endLine, or aroundLine");
  }

  if (limit !== undefined && endLine !== undefined) {
    validationError("limit cannot be combined with endLine");
  }

  if (tail !== undefined) {
    return {
      kind: "tail",
      path: params.path,
      tail,
    };
  }

  if (aroundLine !== undefined) {
    return {
      kind: "around",
      path: params.path,
      aroundLine,
      context: context ?? 0,
    };
  }

  const actualOffset = offset ?? 1;
  if (endLine !== undefined && endLine < actualOffset) {
    validationError("endLine must be greater than or equal to offset");
  }

  return {
    kind: "range",
    path: params.path,
    offset: actualOffset,
    limit: endLine !== undefined ? endLine - actualOffset + 1 : limit,
  };
}

export function normalizeReadRequest(
  params: EnhancedReadParams,
  totalLines: number,
): NormalizedReadRequest {
  const parsed = parseReadRequest(params);

  if (parsed.kind === "tail") {
    const actualLimit = Math.min(parsed.tail, totalLines);
    const actualOffset = Math.max(1, totalLines - actualLimit + 1);
    return {
      path: parsed.path,
      offset: actualOffset,
      limit: actualLimit,
      rangeLabel: formatRangeLabel(actualOffset, actualLimit, "tail"),
    };
  }

  if (parsed.kind === "around") {
    const start = Math.max(1, parsed.aroundLine - parsed.context);
    const end = Math.min(totalLines, parsed.aroundLine + parsed.context);
    return {
      path: parsed.path,
      offset: start,
      limit: end - start + 1,
      rangeLabel: formatRangeLabel(start, end - start + 1),
    };
  }

  return {
    path: parsed.path,
    offset: parsed.offset,
    limit: parsed.limit,
    rangeLabel: formatRangeLabel(parsed.offset, parsed.limit),
  };
}

function createAbortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

async function* streamFileLines(filePath: string, signal?: AbortSignal): AsyncGenerator<string> {
  if (signal?.aborted) {
    throw createAbortError();
  }

  const stream = createReadStream(filePath);
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let sawBytes = false;
  let endedWithNewline = false;
  const onAbort = () => stream.destroy(createAbortError());

  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const chunk of stream) {
      if (signal?.aborted) {
        throw createAbortError();
      }

      const decodedChunk = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (decodedChunk.length === 0) {
        continue;
      }

      sawBytes = true;
      buffered += decodedChunk;
      endedWithNewline = decodedChunk.endsWith("\n");

      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        yield buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }

      if (buffered.length > 0) {
        endedWithNewline = false;
      }
    }

    const decodedRemainder = decoder.end();
    if (decodedRemainder.length > 0) {
      sawBytes = true;
      buffered += decodedRemainder;
      endedWithNewline = decodedRemainder.endsWith("\n");

      let newlineIndex = buffered.indexOf("\n");
      while (newlineIndex !== -1) {
        yield buffered.slice(0, newlineIndex);
        buffered = buffered.slice(newlineIndex + 1);
        newlineIndex = buffered.indexOf("\n");
      }

      if (buffered.length > 0) {
        endedWithNewline = false;
      }
    }

    if (!sawBytes) {
      yield "";
      return;
    }

    if (buffered.length > 0 || endedWithNewline) {
      yield buffered;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stream.destroy();
  }
}

class RollingLineBuffer {
  private readonly lines: string[] = [];
  private start = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(line: string): void {
    if (this.capacity <= 0) {
      return;
    }

    if (this.lines.length < this.capacity) {
      this.lines.push(line);
      return;
    }

    this.lines[this.start] = line;
    this.start = (this.start + 1) % this.capacity;
  }

  toArray(): string[] {
    if (this.start === 0) {
      return [...this.lines];
    }

    return Array.from({ length: this.lines.length }, (_, index) => {
      const actualIndex = (this.start + index) % this.lines.length;
      return this.lines[actualIndex] ?? "";
    });
  }
}

class SelectedContentAccumulator {
  private readonly outputLines: string[] = [];
  private firstLine: string | undefined;
  private truncatedBy: "lines" | "bytes" | null = null;
  private firstLineExceedsLimit = false;
  private outputBytes = 0;
  private totalBytes = 0;
  private totalLines = 0;

  addLine(line: string): void {
    const lineIndex = this.totalLines;
    const lineBytes = Buffer.byteLength(line, "utf-8");
    const addedBytes = lineBytes + (lineIndex > 0 ? 1 : 0);

    this.totalLines += 1;
    this.totalBytes += addedBytes;

    if (this.firstLine === undefined) {
      this.firstLine = line;
      if (lineBytes > DEFAULT_MAX_BYTES) {
        this.firstLineExceedsLimit = true;
        this.truncatedBy = "bytes";
        return;
      }
    }

    if (this.firstLineExceedsLimit) {
      return;
    }

    if (this.outputLines.length >= DEFAULT_MAX_LINES) {
      this.truncatedBy ??= "lines";
      return;
    }

    if (this.outputBytes + addedBytes > DEFAULT_MAX_BYTES) {
      this.truncatedBy = "bytes";
      return;
    }

    this.outputLines.push(line);
    this.outputBytes += addedBytes;
  }

  getFirstLine(): string {
    return this.firstLine ?? "";
  }

  toTruncationResult(): TruncationResult {
    const truncated = this.firstLineExceedsLimit || this.totalLines !== this.outputLines.length || this.totalBytes !== this.outputBytes;

    return {
      content: this.outputLines.join("\n"),
      truncated,
      truncatedBy: truncated ? this.truncatedBy : null,
      totalLines: this.totalLines,
      totalBytes: this.totalBytes,
      outputLines: this.outputLines.length,
      outputBytes: this.outputBytes,
      lastLinePartial: false,
      firstLineExceedsLimit: this.firstLineExceedsLimit,
      maxLines: DEFAULT_MAX_LINES,
      maxBytes: DEFAULT_MAX_BYTES,
    };
  }
}

function accumulateSelectedLines(lines: Iterable<string>): SelectedContentAccumulator {
  const accumulator = new SelectedContentAccumulator();
  for (const line of lines) {
    accumulator.addLine(line);
  }
  return accumulator;
}

function textResult(text: string, truncation?: TruncationResult): EnhancedReadResult {
  const result: EnhancedReadResult = {
    content: [{ type: "text", text }],
  };

  if (truncation) {
    result.details = { truncation };
  }

  return result;
}

function formatStructuredReadError(error: unknown, requestedPath: string): string {
  if (error instanceof Error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return `File not found: ${requestedPath}`;
    }
    if (nodeError.code === "EISDIR") {
      return `Cannot read ${requestedPath}: path is a directory`;
    }
    if (nodeError.code === "EACCES" || nodeError.code === "EPERM") {
      return `Permission denied: ${requestedPath}`;
    }
    return error.message;
  }

  return `Error reading ${requestedPath}`;
}

export async function executeEnhancedTextRead(
  cwd: string,
  params: EnhancedReadParams,
  deps: Partial<EnhancedReadDeps> = {},
): Promise<EnhancedReadResult> {
  const operations: EnhancedReadDeps = {
    ...defaultDeps,
    ...deps,
  };

  try {
    const absolutePath = resolveReadPathLikePi(params.path, cwd);
    const parsed = parseReadRequest(params);

    await operations.access(absolutePath);

    const stats = await operations.stat(absolutePath);
    if (typeof stats.isDirectory === "function" && stats.isDirectory()) {
      return textResult(`Cannot read ${params.path}: path is a directory`);
    }

    let totalFileLines = 0;
    let selectedLines = new SelectedContentAccumulator();
    const tailBuffer = parsed.kind === "tail" ? new RollingLineBuffer(parsed.tail) : undefined;
    const aroundStart = parsed.kind === "around" ? Math.max(1, parsed.aroundLine - parsed.context) : undefined;
    const aroundEnd = parsed.kind === "around" ? parsed.aroundLine + parsed.context : undefined;

    for await (const line of streamFileLines(absolutePath)) {
      totalFileLines += 1;

      if (parsed.kind === "tail") {
        tailBuffer?.push(line);
        continue;
      }

      if (parsed.kind === "around") {
        if (totalFileLines >= (aroundStart ?? 1) && totalFileLines <= (aroundEnd ?? 0)) {
          selectedLines.addLine(line);
        }
        continue;
      }

      if (totalFileLines < parsed.offset) {
        continue;
      }

      if (parsed.limit !== undefined && totalFileLines >= parsed.offset + parsed.limit) {
        continue;
      }

      selectedLines.addLine(line);
    }

    const normalized = normalizeReadRequest(params, totalFileLines);
    if (normalized.offset > totalFileLines) {
      return textResult(`Offset ${normalized.offset} is beyond end of file (${totalFileLines} lines total)`);
    }

    if (parsed.kind === "tail") {
      selectedLines = accumulateSelectedLines(tailBuffer?.toArray() ?? []);
    }

    const truncation = selectedLines.toTruncationResult();
    const startLineDisplay = normalized.offset;

    if (truncation.firstLineExceedsLimit) {
      const firstLineSize = formatSize(Buffer.byteLength(selectedLines.getFirstLine(), "utf-8"));
      const outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}]`;
      return textResult(outputText, truncation);
    }

    if (truncation.truncated) {
      const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
      const nextOffset = endLineDisplay + 1;
      let outputText = truncation.content;
      if (truncation.truncatedBy === "lines") {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
      }
      return textResult(outputText, truncation);
    }

    if (normalized.limit !== undefined && normalized.offset - 1 + truncation.totalLines < totalFileLines) {
      const remaining = totalFileLines - (normalized.offset - 1 + truncation.totalLines);
      const nextOffset = normalized.offset + truncation.totalLines;
      return textResult(`${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`);
    }

    return textResult(truncation.content);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return textResult(formatStructuredReadError(error, params.path));
  }
}

export function isImagePath(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase());
}
