import { stat as fsStat } from "node:fs/promises";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  executeEnhancedTextRead,
  isImagePath,
  resolveReadPathLikePi,
  type EnhancedReadParams,
  type EnhancedReadResult,
} from "../lib/enhanced-read.ts";

export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; data: string; mimeType: string };
export type ReadContentPart = TextPart | ImagePart;

export type ImageReadResult = {
  content: ReadContentPart[];
  details?: unknown;
};

export interface ToolContext {
  cwd?: string;
}

export interface ImageReadFallback {
  execute: (
    toolCallId: string,
    params: { path: string; offset?: number; limit?: number },
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ToolContext,
  ) => Promise<ImageReadResult>;
}

const parameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "Path to the file to read (relative or absolute)" },
    offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
    limit: { type: "number", description: "Maximum number of lines to read" },
    endLine: { type: "number", description: "Inclusive ending line number for bounded reads" },
    tail: { type: "number", description: "Read the last N lines of a text file" },
    aroundLine: { type: "number", description: "Center a text read around a specific line number" },
    context: { type: "number", description: "Number of surrounding context lines to include with aroundLine" },
  },
  required: ["path"],
  additionalProperties: false,
} as const;

export interface ReadToolDeps {
  createImageReadFallback?: (cwd: string, options?: { autoResizeImages?: boolean }) => Promise<ImageReadFallback>;
  executeTextRead?: (
    cwd: string,
    params: EnhancedReadParams,
  ) => Promise<EnhancedReadResult>;
  resolvePath?: (path: string, cwd: string) => string;
  statPath?: (path: string) => Promise<{ size: number }>;
}

export interface EnhancedReadToolDefinition {
  name: "read";
  label: string;
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
  parameters: typeof parameters;
  execute: (
    toolCallId: string,
    params: EnhancedReadParams,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ToolContext,
  ) => Promise<EnhancedReadResult | ImageReadResult>;
}

function errorResult(text: string): EnhancedReadResult {
  return {
    content: [{ type: "text", text }],
  };
}

const IMAGE_OMITTED_TEXT = "[Image omitted: could not be resized below the inline image size limit.]";
const MAX_INLINE_IMAGE_RETRY_FILE_BYTES = 3 * 1024 * 1024;

async function createDefaultImageReadFallback(cwd: string, options?: { autoResizeImages?: boolean }) {
  const module = await import("@mariozechner/pi-coding-agent");
  return module.createReadToolDefinition(cwd, options);
}

function shouldRetryImageWithoutResize(result: ImageReadResult): boolean {
  const firstTextPart = result.content.find((part): part is TextPart => part.type === "text");
  return firstTextPart?.text.includes(IMAGE_OMITTED_TEXT) ?? false;
}

function hasExtendedTextTargeting(params: EnhancedReadParams): boolean {
  return params.endLine !== undefined || params.tail !== undefined || params.aroundLine !== undefined || params.context !== undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createEnhancedReadToolDefinition(deps: ReadToolDeps = {}): EnhancedReadToolDefinition {
  const executeTextRead = deps.executeTextRead ?? executeEnhancedTextRead;
  const resolvePath = deps.resolvePath ?? resolveReadPathLikePi;
  const createImageReadFallback = deps.createImageReadFallback ?? createDefaultImageReadFallback;
  const statPath = deps.statPath ?? fsStat;
  const fallbackCache = new Map<string, Promise<ImageReadFallback>>();

  function getFallback(cwd: string, autoResizeImages?: boolean): Promise<ImageReadFallback> {
    const key = `${cwd}:${autoResizeImages ?? "default"}`;
    let cached = fallbackCache.get(key);

    if (!cached) {
      cached = createImageReadFallback(
        cwd,
        autoResizeImages === undefined ? undefined : { autoResizeImages },
      );
      fallbackCache.set(key, cached);
      cached.catch(() => fallbackCache.delete(key));
    }

    return cached;
  }

  return {
    name: "read",
    label: "read",
    description:
      "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). " +
      "For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). " +
      "Use offset/limit, endLine, tail, or aroundLine for targeted reads.",
    promptSnippet: "Read file contents with line targeting (offset/limit, endLine, tail, aroundLine)",
    promptGuidelines: [
      "Use read instead of bash cat, head, tail, or sed for file content inspection whenever the structured tool can answer the question.",
      "Prefer endLine, tail, and aroundLine over bash head, tail, or sed when you need line-targeted reads.",
    ],
    parameters,

    async execute(
      toolCallId: string,
      params: EnhancedReadParams,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: ToolContext,
    ) {
      const cwd = ctx?.cwd ?? process.cwd();

      try {
        const absolutePath = resolvePath(params.path, cwd);

        if (isImagePath(absolutePath)) {
          if (hasExtendedTextTargeting(params)) {
            return errorResult("endLine, tail, aroundLine, and context are only supported for text files");
          }

          const fallback = await getFallback(cwd);
          const fallbackResult = await fallback.execute(
            toolCallId,
            { path: absolutePath, offset: params.offset, limit: params.limit },
            signal,
            onUpdate,
            ctx,
          );

          if (shouldRetryImageWithoutResize(fallbackResult)) {
            const fileInfo = await statPath(absolutePath);
            if (fileInfo.size <= MAX_INLINE_IMAGE_RETRY_FILE_BYTES) {
              const unresizedFallback = await getFallback(cwd, false);
              return await unresizedFallback.execute(
                toolCallId,
                { path: absolutePath, offset: params.offset, limit: params.limit },
                signal,
                onUpdate,
                ctx,
              );
            }
          }

          return fallbackResult;
        }

        return await executeTextRead(cwd, params);
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        const message = error instanceof Error ? error.message : `Error reading ${params.path}`;
        return errorResult(message);
      }
    },
  };
}

export default function registerReadExtension(pi: ExtensionAPI): void {
  pi.registerTool(createEnhancedReadToolDefinition());
}
