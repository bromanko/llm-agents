import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_TIMEOUT_SECONDS = 20;

export interface FetchRequest {
  url: string;
  timeoutSeconds?: number;
  raw?: boolean;
  maxBytes?: number;
  maxLines?: number;
}

export interface FetchTruncation {
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export interface FetchResponse {
  requestUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  method: "text" | "json" | "html" | "raw" | "fallback";
  content: string;
  truncated: boolean;
  fullOutputPath?: string;
  notes: string[];
  truncation?: FetchTruncation;
}

interface TruncationResult {
  content: string;
  truncated: boolean;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    throw new Error("URL must not be empty");
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    return trimmed;
  }

  return `https://${trimmed}`;
}

function normalizeContentType(contentType: string | null): string {
  if (!contentType) return "unknown";
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function isJsonContent(contentType: string): boolean {
  return contentType === "application/json" || contentType.endsWith("+json");
}

function isHtmlContent(contentType: string): boolean {
  return contentType === "text/html" || contentType === "application/xhtml+xml";
}

function isPlainTextContent(contentType: string): boolean {
  return contentType.startsWith("text/") || contentType.includes("markdown");
}

function formatJson(text: string, maxBytes: number): string {
  // Skip pretty-printing when the raw JSON already exceeds the output limit,
  // since the expanded result (typically 2-3x larger) would be immediately truncated
  if (Buffer.byteLength(text, "utf8") > maxBytes) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_match, entity) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : _match;
    }

    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) && codePoint >= 0 && codePoint <= 0x10FFFF
        ? String.fromCodePoint(codePoint)
        : _match;
    }

    return NAMED_ENTITIES[entity] ?? _match;
  });
}

function htmlToReadableText(html: string): string {
  // Strip null bytes that can be used to bypass tag matching
  let text = html.replace(/\0/g, "");

  // Single pass: strip comments and script/style/noscript blocks
  text = text.replace(
    /<!--[\s\S]*?-->|<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );

  // Single pass: convert block boundaries to newlines and list items to "- " markers,
  // then strip all remaining tags
  text = text.replace(/<[^>]+>/g, (tag) => {
    if (/^<(br|\/p|\/div|\/section|\/article|\/h[1-6]|\/li|\/tr)>/i.test(tag)) return "\n";
    if (/^<li\b/i.test(tag)) return "\n- ";
    return " ";
  });

  text = decodeHtmlEntities(text);

  // Final safety net: strip any angle brackets that survived the regex passes,
  // preventing residual tag fragments from being interpreted as HTML
  text = text.replace(/[<>]/g, "");

  // Normalize whitespace while preserving line boundaries.
  const normalized = text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");

  return normalized;
}

function sliceUtf8(content: string, maxBytes: number): string {
  const buf = Buffer.from(content, "utf8");
  if (buf.length <= maxBytes) return content;
  // Decode the truncated buffer; Node handles broken trailing sequences gracefully
  const sliced = buf.subarray(0, maxBytes).toString("utf8");
  // Drop last char if it was corrupted by the cut (replacement char)
  return sliced.endsWith("\uFFFD") ? sliced.slice(0, -1) : sliced;
}

function truncateHead(
  content: string,
  options: { maxLines: number; maxBytes: number },
): TruncationResult {
  const totalBytes = Buffer.byteLength(content, "utf8");
  const allLines = content.split("\n");
  const totalLines = content.length === 0 ? 0 : allLines.length;

  let bytes = 0;
  let outputLineCount = 0;
  const kept: string[] = [];

  for (let i = 0; i < Math.min(allLines.length, options.maxLines); i++) {
    const lineBytes = Buffer.byteLength(allLines[i]!, "utf8") + (i > 0 ? 1 : 0); // +1 for \n
    if (bytes + lineBytes > options.maxBytes) {
      // If no lines kept yet, include a byte-limited partial first line
      if (i === 0) {
        const partial = sliceUtf8(allLines[0]!, options.maxBytes);
        if (partial.length > 0) {
          kept.push(partial);
          outputLineCount = 1;
          bytes = Buffer.byteLength(partial, "utf8");
        }
      }
      break;
    }
    bytes += lineBytes;
    kept.push(allLines[i]!);
    outputLineCount++;
  }

  const result = kept.join("\n");
  return {
    content: result,
    truncated: outputLineCount < totalLines || bytes < totalBytes,
    totalLines,
    totalBytes,
    outputLines: outputLineCount,
    outputBytes: bytes,
  };
}

let sessionTempDir: string | undefined;
let fileCounter = 0;

function getSessionTempDir(): string {
  if (!sessionTempDir) {
    sessionTempDir = mkdtempSync(join(tmpdir(), "pi-fetch-"));
    process.on("exit", () => cleanupTempFiles());
  }
  return sessionTempDir;
}

/**
 * Remove the session temp directory and all files within it.
 * Safe to call multiple times or when no temp files have been created.
 */
export function cleanupTempFiles(): void {
  if (!sessionTempDir) return;
  try {
    rmSync(sessionTempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; ignore errors (e.g., already removed)
  }
  sessionTempDir = undefined;
  fileCounter = 0;
}

function writeTruncatedOutputFile(content: string): string {
  const dir = getSessionTempDir();
  const outputPath = join(dir, `output-${++fileCounter}.txt`);
  writeFileSync(outputPath, content, "utf-8");
  return outputPath;
}

function transformContent(
  content: string,
  contentType: string,
  options: { raw: boolean; maxBytes: number },
): {
  method: FetchResponse["method"];
  content: string;
} {
  if (options.raw) return { method: "raw", content };
  if (isJsonContent(contentType)) return { method: "json", content: formatJson(content, options.maxBytes) };
  if (isHtmlContent(contentType)) return { method: "html", content: htmlToReadableText(content) };
  if (isPlainTextContent(contentType)) return { method: "text", content };
  return { method: "fallback", content };
}

const BODY_READ_MULTIPLIER = 5;
const MIN_BODY_READ_BYTES = 256 * 1024;
const MAX_BODY_READ_BYTES = 10 * 1024 * 1024;

async function readBodyWithLimit(
  response: Response,
  limitBytes: number,
): Promise<{ text: string; bodyTruncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { text: "", bodyTruncated: false };

  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      receivedBytes += value.byteLength;
      if (receivedBytes >= limitBytes) {
        const text = Buffer.concat(chunks).subarray(0, limitBytes).toString("utf8");
        return {
          text: text.endsWith("\uFFFD") ? text.slice(0, -1) : text,
          bodyTruncated: true,
        };
      }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), bodyTruncated: false };
  } finally {
    reader.cancel().catch(() => {});
  }
}

function validateHttpUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only HTTP(S) URLs are supported. Received protocol: ${parsed.protocol}`);
  }
  return parsed;
}

export async function fetchUrl(request: FetchRequest): Promise<FetchResponse> {
  const requestUrl = normalizeUrl(request.url);
  const parsedUrl = validateHttpUrl(requestUrl);

  const timeoutSeconds = request.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const timeoutMessage = `Request timed out after ${timeoutSeconds}s`;
  const timeoutMs = Math.max(1, Math.floor(timeoutSeconds * 1000));

  const TIMEOUT_SENTINEL = Symbol("timeout");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(TIMEOUT_SENTINEL);
  }, timeoutMs);

  try {
    const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
    const maxLines = request.maxLines ?? DEFAULT_MAX_LINES;
    const readLimit = Math.min(
      Math.max(maxBytes * BODY_READ_MULTIPLIER, MIN_BODY_READ_BYTES),
      MAX_BODY_READ_BYTES,
    );

    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      redirect: "follow",
    });

    const { text: body, bodyTruncated } = await readBodyWithLimit(response, readLimit);
    const contentType = normalizeContentType(response.headers.get("content-type"));
    const transformed = transformContent(body, contentType, { raw: request.raw ?? false, maxBytes });

    const notes: string[] = [];
    let fullOutputPath: string | undefined;

    // Write full transformed content to disk before truncating to limit peak memory
    const truncation = truncateHead(transformed.content, { maxLines, maxBytes });

    if (truncation.truncated) {
      fullOutputPath = writeTruncatedOutputFile(transformed.content);
      notes.push(
        `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines` +
          ` (${truncation.outputBytes} of ${truncation.totalBytes} bytes). Full output saved to: ${fullOutputPath}]`,
      );
    }

    if (bodyTruncated) {
      notes.push(
        `[Response body exceeded ${readLimit} byte read limit; saved output may be incomplete.]`,
      );
    }

    return {
      requestUrl,
      finalUrl: response.url || requestUrl,
      status: response.status,
      contentType,
      method: transformed.method,
      content: truncation.content,
      truncated: truncation.truncated,
      fullOutputPath,
      notes,
      truncation: {
        totalLines: truncation.totalLines,
        totalBytes: truncation.totalBytes,
        outputLines: truncation.outputLines,
        outputBytes: truncation.outputBytes,
      },
    };
  } catch (error) {
    if (controller.signal.reason === TIMEOUT_SENTINEL) {
      throw new Error(timeoutMessage);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Fetch failed: ${String(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
}
