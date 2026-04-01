import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { EnhancedReadParams } from "../../pi/files/lib/enhanced-read.ts";
import readExtension, {
  createEnhancedReadToolDefinition,
  type ImageReadResult,
  type ToolContext,
} from "../../pi/files/extensions/read.ts";

type RegisteredTool = ReturnType<typeof createEnhancedReadToolDefinition>;
type ReadToolResult = Awaited<ReturnType<RegisteredTool["execute"]>>;

type FallbackParams = { path: string; offset?: number; limit?: number };

function createMockPi(): Pick<ExtensionAPI, "registerTool"> & { getTools(): RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    getTools() {
      return tools;
    },
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "enhanced-read-extension-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function getText(result: ReadToolResult): string {
  return result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

function imageTextResult(text: string): ImageReadResult {
  return { content: [{ type: "text", text }] };
}

test("registers exactly one tool named read", () => {
  const pi = createMockPi();

  readExtension(pi as ExtensionAPI);

  const tools = pi.getTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "read");
});

test("exposes the enhanced read schema and prompt guidance", () => {
  const tool = createEnhancedReadToolDefinition();
  const properties = tool.parameters.properties;

  assert.ok(properties.path);
  assert.ok(properties.offset);
  assert.ok(properties.limit);
  assert.ok(properties.endLine);
  assert.ok(properties.tail);
  assert.ok(properties.aroundLine);
  assert.ok(properties.context);
  assert.equal(tool.promptSnippet, "Read file contents with line targeting (offset/limit, endLine, tail, aroundLine)");
  assert.deepEqual(tool.promptGuidelines, [
    "Use read to examine files instead of cat or sed.",
    "Prefer endLine, tail, and aroundLine over bash head/tail/sed when you need line-targeted reads.",
  ]);
});

test("plain offset plus limit reads behave like built-in read", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), "line 1\nline 2\nline 3\nline 4", "utf8");
    const tool = createEnhancedReadToolDefinition();

    const result = await tool.execute("call-1", { path: "sample.txt", offset: 2, limit: 2 }, undefined, undefined, { cwd: tempDir });

    assert.equal(getText(result), "line 2\nline 3\n\n[1 more lines in file. Use offset=4 to continue.]");
  } finally {
    cleanup(tempDir);
  }
});

test("endLine returns the expected inclusive range", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), "line 1\nline 2\nline 3\nline 4\nline 5", "utf8");
    const tool = createEnhancedReadToolDefinition();

    const result = await tool.execute("call-2", { path: "sample.txt", offset: 2, endLine: 4 }, undefined, undefined, { cwd: tempDir });

    assert.equal(getText(result), "line 2\nline 3\nline 4\n\n[1 more lines in file. Use offset=5 to continue.]");
  } finally {
    cleanup(tempDir);
  }
});

test("tail returns the expected last-N lines", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), "line 1\nline 2\nline 3\nline 4\nline 5", "utf8");
    const tool = createEnhancedReadToolDefinition();

    const result = await tool.execute("call-3", { path: "sample.txt", tail: 2 }, undefined, undefined, { cwd: tempDir });

    assert.equal(getText(result), "line 4\nline 5");
  } finally {
    cleanup(tempDir);
  }
});

test("aroundLine plus context returns the expected centered window", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7", "utf8");
    const tool = createEnhancedReadToolDefinition();

    const result = await tool.execute("call-4", { path: "sample.txt", aroundLine: 4, context: 1 }, undefined, undefined, { cwd: tempDir });

    assert.equal(getText(result), "line 3\nline 4\nline 5\n\n[2 more lines in file. Use offset=6 to continue.]");
  } finally {
    cleanup(tempDir);
  }
});

test("image-path requests delegate to the injected fallback when no extended text-only arguments are used", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "image.png"), "tiny-image", "utf8");
    const fallbackCalls: Array<{
      toolCallId: string;
      params: FallbackParams;
      autoResizeImages?: boolean;
    }> = [];
    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async (_cwd, options) => ({
        async execute(toolCallId, params) {
          fallbackCalls.push({ toolCallId, params, autoResizeImages: options?.autoResizeImages });
          return imageTextResult("delegated image read");
        },
      }),
    });

    const result = await tool.execute("call-5", { path: "image.png", offset: 1, limit: 2 }, undefined, undefined, { cwd: tempDir });

    assert.equal(getText(result), "delegated image read");
    assert.equal(fallbackCalls.length, 1);
    assert.match(fallbackCalls[0]!.params.path, /image\.png$/);
    assert.equal(fallbackCalls[0]!.autoResizeImages, undefined);
  } finally {
    cleanup(tempDir);
  }
});

test("image-path requests forward signal, onUpdate, and ctx to the fallback", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "image.png"), "tiny-image", "utf8");

    let receivedSignal: AbortSignal | undefined;
    let receivedOnUpdate: unknown;
    let receivedCtx: ToolContext | undefined;
    const controller = new AbortController();
    const onUpdate = () => undefined;
    const ctx: ToolContext = { cwd: tempDir };

    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async () => ({
        async execute(_toolCallId, _params, signal, forwardedOnUpdate, forwardedCtx) {
          receivedSignal = signal;
          receivedOnUpdate = forwardedOnUpdate;
          receivedCtx = forwardedCtx;
          return imageTextResult("delegated image read");
        },
      }),
    });

    await tool.execute("call-forwarding", { path: "image.png", offset: 2, limit: 3 }, controller.signal, onUpdate, ctx);

    assert.strictEqual(receivedSignal, controller.signal);
    assert.strictEqual(receivedOnUpdate, onUpdate);
    assert.strictEqual(receivedCtx, ctx);
  } finally {
    cleanup(tempDir);
  }
});

test("image-path requests with extended line targeting are rejected as text-only", async () => {
  const tool = createEnhancedReadToolDefinition({
    createImageReadFallback: async () => ({
      async execute() {
        return imageTextResult("unexpected fallback");
      },
    }),
  });

  const tailResult = await tool.execute("call-6", { path: "image.png", tail: 5 }, undefined, undefined, { cwd: process.cwd() });
  assert.match(getText(tailResult), /only supported for text files/);

  const endLineResult = await tool.execute("call-7", { path: "image.png", endLine: 5 }, undefined, undefined, { cwd: process.cwd() });
  assert.match(getText(endLineResult), /only supported for text files/);

  const aroundResult = await tool.execute("call-8", { path: "image.png", aroundLine: 10, context: 2 }, undefined, undefined, { cwd: process.cwd() });
  assert.match(getText(aroundResult), /only supported for text files/);
});

test("known image extensions delegate and non-image extensions stay on the text path", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.md"), "hello markdown", "utf8");
    for (const path of ["photo.png", "photo.jpg", "photo.jpeg", "photo.gif", "photo.webp"]) {
      writeFileSync(join(tempDir, path), "image-data", "utf8");
    }

    const delegated: string[] = [];
    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async () => ({
        async execute(_toolCallId, params) {
          delegated.push(params.path);
          return imageTextResult("fallback used");
        },
      }),
    });

    for (const path of ["photo.png", "photo.jpg", "photo.jpeg", "photo.gif", "photo.webp"]) {
      const result = await tool.execute("call-image", { path }, undefined, undefined, { cwd: tempDir });
      assert.equal(getText(result), "fallback used");
    }

    const textResult = await tool.execute("call-text", { path: "sample.md" }, undefined, undefined, { cwd: tempDir });

    assert.equal(delegated.length, 5);
    assert.equal(getText(textResult), "hello markdown");
  } finally {
    cleanup(tempDir);
  }
});

test("small image omission retries once with autoResizeImages disabled", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "image.png"), "small-image-data", "utf8");

    const fallbackModes: Array<boolean | undefined> = [];
    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async (_cwd, options) => ({
        async execute() {
          fallbackModes.push(options?.autoResizeImages);
          if (options?.autoResizeImages === false) {
            return {
              content: [
                { type: "text", text: "Read image file [image/png]" },
                { type: "image", data: "abc123", mimeType: "image/png" },
              ],
            };
          }

          return imageTextResult(
            "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
          );
        },
      }),
    });

    const result = await tool.execute("call-retry", { path: "image.png" }, undefined, undefined, { cwd: tempDir });

    assert.deepEqual(fallbackModes, [undefined, false]);
    assert.deepEqual(result.content.map((part) => part.type), ["text", "image"]);
    assert.equal(result.content[1]?.type, "image");
    if (result.content[1]?.type === "image") {
      assert.equal(result.content[1].mimeType, "image/png");
    }
  } finally {
    cleanup(tempDir);
  }
});

test("size-check failures during image retry return a structured error result", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "image.png"), "small-image-data", "utf8");

    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async () => ({
        async execute() {
          return imageTextResult(
            "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
          );
        },
      }),
      statPath: async () => {
        throw new Error("size check failed");
      },
    });

    const result = await tool.execute("call-retry-stat-error", { path: "image.png" }, undefined, undefined, { cwd: tempDir });

    assert.equal(getText(result), "size check failed");
  } finally {
    cleanup(tempDir);
  }
});

test("unresized image retry failures return a structured error result", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "image.png"), "small-image-data", "utf8");

    const fallbackModes: Array<boolean | undefined> = [];
    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async (_cwd, options) => ({
        async execute() {
          fallbackModes.push(options?.autoResizeImages);
          if (options?.autoResizeImages === false) {
            throw new Error("unresized retry failed");
          }
          return imageTextResult(
            "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
          );
        },
      }),
    });

    const result = await tool.execute("call-retry-fallback-error", { path: "image.png" }, undefined, undefined, { cwd: tempDir });

    assert.deepEqual(fallbackModes, [undefined, false]);
    assert.equal(getText(result), "unresized retry failed");
  } finally {
    cleanup(tempDir);
  }
});

test("large image omission does not retry without resize", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "large.png"), "x".repeat(3 * 1024 * 1024 + 1), "utf8");

    const fallbackModes: Array<boolean | undefined> = [];
    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async (_cwd, options) => ({
        async execute() {
          fallbackModes.push(options?.autoResizeImages);
          return imageTextResult(
            "Read image file [image/png]\n[Image omitted: could not be resized below the inline image size limit.]",
          );
        },
      }),
    });

    const result = await tool.execute("call-large", { path: "large.png" }, undefined, undefined, { cwd: tempDir });

    assert.deepEqual(fallbackModes, [undefined]);
    assert.match(getText(result), /Image omitted/);
  } finally {
    cleanup(tempDir);
  }
});

test("abort errors from delegated image reads are rethrown", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "image.png"), "tiny-image", "utf8");
    const tool = createEnhancedReadToolDefinition({
      createImageReadFallback: async () => ({
        async execute() {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        },
      }),
    });

    await assert.rejects(
      () => tool.execute("call-abort", { path: "image.png" }, new AbortController().signal, undefined, { cwd: tempDir }),
      (error: unknown) => error instanceof Error && error.name === "AbortError",
    );
  } finally {
    cleanup(tempDir);
  }
});

test("file-not-found returns a structured error result", async () => {
  const tool = createEnhancedReadToolDefinition();
  const result = await tool.execute("call-9", { path: "missing.txt" }, undefined, undefined, { cwd: process.cwd() });
  assert.match(getText(result), /File not found: missing\.txt/);
});

test("unexpected text executor errors are caught and returned as structured results", async () => {
  const tool = createEnhancedReadToolDefinition({
    executeTextRead: async (_cwd: string, _params: EnhancedReadParams) => {
      throw new Error("boom from text executor");
    },
  });

  const result = await tool.execute("call-10", { path: "sample.txt" }, undefined, undefined, { cwd: process.cwd() });
  assert.equal(getText(result), "boom from text executor");
});

test("abort errors from the text executor are rethrown", async () => {
  const tool = createEnhancedReadToolDefinition({
    executeTextRead: async (_cwd: string, _params: EnhancedReadParams) => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });

  await assert.rejects(
    () => tool.execute("call-11", { path: "sample.txt" }, undefined, undefined, { cwd: process.cwd() }),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});
