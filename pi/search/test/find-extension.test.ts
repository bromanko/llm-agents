import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerFindExtension, { createFindToolDefinition, depthWithinScope, normalizeMaxDepth, type FindToolDeps } from "../extensions/find.ts";
import { DEFAULT_FIND_LIMIT } from "../lib/constants.ts";
import type { FindToolParams, RgExecutor, RgResult } from "../lib/types.ts";

type FindTool = ReturnType<typeof createFindToolDefinition>;
type FindResult = Awaited<ReturnType<FindTool["execute"]>>;

function createMockPi(): Pick<ExtensionAPI, "registerTool"> & { getTools(): FindTool[] } {
  const tools: FindTool[] = [];
  return {
    registerTool(tool: FindTool) {
      tools.push(tool);
    },
    getTools() {
      return tools;
    },
  };
}

function setupExtension(deps: FindToolDeps = {}): FindTool {
  const pi = createMockPi();

  if (Object.keys(deps).length === 0) {
    registerFindExtension(pi as ExtensionAPI);
  } else {
    pi.registerTool(createFindToolDefinition(deps));
  }

  const [tool] = pi.getTools();
  assert.ok(tool);
  return tool;
}

function getText(result: Pick<FindResult, "content">): string {
  return result.content.map((part) => part.text).join("\n");
}

function createCapturingExecutor(result: RgResult = { lines: [], matched: true, error: null }): {
  executor: RgExecutor;
  getArgs(): string[];
} {
  let capturedArgs: string[] = [];
  return {
    executor: async (args) => {
      capturedArgs = args;
      return result;
    },
    getArgs() {
      return capturedArgs;
    },
  };
}

function executeFind(tool: FindTool, params: FindToolParams): Promise<FindResult> {
  return tool.execute("call", params, undefined, undefined, { cwd: process.cwd() });
}

test("registers a tool named find", () => {
  const tool = setupExtension();
  assert.equal(tool.name, "find");
});

test("schema exposes built-in-compatible fields", () => {
  const tool = createFindToolDefinition();
  const properties = tool.parameters.properties;

  assert.ok(properties.pattern);
  assert.ok(properties.path);
  assert.ok(properties.limit);
});

test("schema exposes P0 extension fields and prompt guidance", () => {
  const tool = createFindToolDefinition();
  const properties = tool.parameters.properties;

  assert.ok(properties.offset);
  assert.ok(properties.maxDepth);
  assert.ok(properties.hidden);
  assert.ok(properties.respectIgnore);
  assert.equal(tool.promptSnippet, "Find files by path or filename pattern with pagination.");
  assert.deepEqual(tool.promptGuidelines, [
    "Use find instead of bash find or ls for file discovery whenever the structured tool can answer the question.",
    "Use maxDepth for shallow listings instead of bash find -maxdepth or ls -R when the structured tool can answer the question.",
    "Prefer limit and offset over piping bash output to head, tail, or sed for pagination.",
  ]);
});

test("invalid path returns structured error details with suggestions", async () => {
  const tool = createFindToolDefinition({
    pathValidator: async () => ({ valid: false, suggestions: ["pi/search"] }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", path: "search" });
  assert.match(getText(result), /pi\/search/);
  assert.deepEqual(result.details, {
    isError: true,
    error: "Path not found: search",
    suggestions: ["pi/search"],
  });
});

test("invalid path without suggestions returns a plain structured error", async () => {
  const tool = createFindToolDefinition({
    pathValidator: async () => ({ valid: false, suggestions: [] }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", path: "missing" });
  assert.equal(getText(result), "Error: Path not found: missing");
  assert.deepEqual(result.details, {
    isError: true,
    error: "Path not found: missing",
    suggestions: [],
  });
});

test("default args include shared skip globs", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts" });

  const args = capture.getArgs();
  assert.ok(args.includes("!.git"));
  assert.ok(args.includes("!node_modules"));
  assert.ok(args.includes("!dist"));
});

test("pattern without glob metacharacters wraps in wildcards", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "config" });

  assert.ok(capture.getArgs().includes("*config*"));
});

test("pattern with glob metacharacters passes through verbatim", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.test.ts" });

  assert.ok(capture.getArgs().includes("*.test.ts"));
});

test("resolved nested scope is propagated to rg args and details", async () => {
  const capture = createCapturingExecutor({ lines: ["nested/file.ts"], matched: true, error: null });
  const tool = createFindToolDefinition({
    rgExecutor: capture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/nested", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", path: "nested" });
  assert.equal(capture.getArgs().at(-1), "src/nested");
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: "src/nested",
    items: ["nested/file.ts"],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("file scope returns matching file directly without invoking rg", async () => {
  let rgCalled = false;
  const tool = createFindToolDefinition({
    rgExecutor: async () => {
      rgCalled = true;
      return { lines: [], matched: true, error: null };
    },
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "config" });
  assert.equal(rgCalled, false);
  assert.equal(getText(result), "Mode: find files | Scope: src/config.ts\nsrc/config.ts\n1 results.");
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: "src/config.ts",
    items: ["src/config.ts"],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("maxDepth does not filter out a matching file scope", async () => {
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines: [], matched: true, error: null }),
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "config", maxDepth: 0 });
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: "src/config.ts",
    items: ["src/config.ts"],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("pagination text includes next offset", async () => {
  const lines = Array.from({ length: 30 }, (_, index) => `file-${index + 1}.ts`);
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", limit: 20, offset: 0 });
  assert.match(getText(result), /offset=20/);
});

test("respectIgnore false removes ignore behavior", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts", respectIgnore: false });

  assert.ok(capture.getArgs().includes("--no-ignore"));
});

test("hidden true includes hidden files", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts", hidden: true });

  assert.ok(capture.getArgs().includes("--hidden"));
});

test("maxDepth is forwarded to rg as --max-depth with +1 offset", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts", maxDepth: 0 });
  const args = capture.getArgs();
  const depthIndex = args.indexOf("--max-depth");
  assert.ok(depthIndex !== -1, "--max-depth flag should be present");
  assert.equal(args[depthIndex + 1], "1");
});

test("maxDepth omitted does not add --max-depth to rg args", async () => {
  const capture = createCapturingExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts" });
  assert.ok(!capture.getArgs().includes("--max-depth"));
});

test("normalizes fractional limit, maxDepth, and negative offset in details", async () => {
  const lines = [
    "root.ts",
    "src/one.ts",
    "src/nested/two.ts",
    "src/nested/deeper/three.ts",
  ];
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", limit: 5.9, maxDepth: 1.9, offset: -3.2 });
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: ".",
    items: ["root.ts", "src/one.ts"],
    totalCount: 2,
    returnedCount: 2,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("maxDepth filters directory results before pagination", async () => {
  const lines = [
    "root.ts",
    "src/one.ts",
    "src/nested/two.ts",
    "src/nested/deeper/three.ts",
  ];
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", maxDepth: 1 });
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: ".",
    items: ["root.ts", "src/one.ts"],
    totalCount: 2,
    returnedCount: 2,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("maxDepth 0 at root scope returns only direct children", async () => {
  const lines = [
    "root.ts",
    "src/one.ts",
    "src/nested/two.ts",
  ];
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", maxDepth: 0 });
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: ".",
    items: ["root.ts"],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("maxDepth filtering applies before pagination offsets", async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `file-${i}.ts`)
    .concat(Array.from({ length: 5 }, (_, i) => `deep/nested/file-${i}.ts`));
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", maxDepth: 0, limit: 10, offset: 5 });
  // Only the 20 root-level files survive; paginate from offset 5
  assert.equal(result.details.totalCount, 20);
  assert.equal(result.details.offset, 5);
  assert.equal(result.details.returnedCount, 10);
  assert.equal(result.details.nextOffset, 15);
});

test("maxDepth is measured relative to a nested directory scope", async () => {
  const tool = createFindToolDefinition({
    pathValidator: async () => ({ valid: true, resolved: "src/nested", kind: "directory" }),
    rgExecutor: async () => ({
      lines: ["src/nested/two.ts", "src/nested/deeper/three.ts"],
      matched: true,
      error: null,
    }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", path: "nested", maxDepth: 0 });
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: "src/nested",
    items: ["src/nested/two.ts"],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("negative maxDepth is clamped to 0", async () => {
  const lines = [
    "root.ts",
    "src/one.ts",
    "src/nested/two.ts",
  ];
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", maxDepth: -1 });
  assert.deepEqual(result.details.items, ["root.ts"]);
  assert.equal(result.details.totalCount, 1);
});

test("maxDepth NaN is treated as undefined and returns all results", async () => {
  const lines = [
    "root.ts",
    "src/one.ts",
    "src/nested/two.ts",
  ];
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", maxDepth: NaN });
  assert.deepEqual(result.details.items, ["root.ts", "src/one.ts", "src/nested/two.ts"]);
  assert.equal(result.details.totalCount, 3);
});

test("omitting limit uses the default find page size", async () => {
  const lines = Array.from({ length: DEFAULT_FIND_LIMIT + 5 }, (_, index) => `file-${index + 1}.ts`);
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts" });
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: ".",
    items: lines.slice(0, DEFAULT_FIND_LIMIT),
    totalCount: DEFAULT_FIND_LIMIT + 5,
    returnedCount: DEFAULT_FIND_LIMIT,
    truncated: true,
    nextOffset: DEFAULT_FIND_LIMIT,
    offset: 0,
  });
});

test("offset past the end reports an empty page clearly", async () => {
  const lines = Array.from({ length: 5 }, (_, index) => `file-${index + 1}.ts`);
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", limit: 5, offset: 999 });
  const text = getText(result);
  assert.match(text, /No results on this page/);
  assert.match(text, /Offset=999/);
  assert.match(text, /5 total results/);
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: ".",
    items: [],
    totalCount: 5,
    returnedCount: 0,
    truncated: false,
    nextOffset: undefined,
    offset: 999,
  });
});

test("rg execution errors surface structured error details", async () => {
  const tool = createFindToolDefinition({
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
    rgExecutor: async () => ({ lines: [], matched: false, error: "ripgrep failed" }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", path: "src" });
  assert.equal(getText(result), "Error: ripgrep failed");
  assert.deepEqual(result.details, {
    isError: true,
    error: "ripgrep failed",
    scope: "src",
  });
});

test("rg exit code 1 returns empty results", async () => {
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines: [], matched: false, error: null }),
  });

  const result = await executeFind(tool, { pattern: "nonexistent" });
  const text = getText(result);
  assert.match(text, /0 results/);
  assert.doesNotMatch(text, /Error:/);
});

// ---------------------------------------------------------------------------
// Unit tests for normalizeMaxDepth
// ---------------------------------------------------------------------------

test("normalizeMaxDepth returns undefined for undefined", () => {
  assert.equal(normalizeMaxDepth(undefined), undefined);
});

test("normalizeMaxDepth returns undefined for NaN", () => {
  assert.equal(normalizeMaxDepth(NaN), undefined);
});

test("normalizeMaxDepth returns undefined for Infinity", () => {
  assert.equal(normalizeMaxDepth(Infinity), undefined);
  assert.equal(normalizeMaxDepth(-Infinity), undefined);
});

test("normalizeMaxDepth clamps negative values to 0", () => {
  assert.equal(normalizeMaxDepth(-1), 0);
  assert.equal(normalizeMaxDepth(-100), 0);
});

test("normalizeMaxDepth floors fractional values", () => {
  assert.equal(normalizeMaxDepth(1.9), 1);
  assert.equal(normalizeMaxDepth(0.5), 0);
});

test("normalizeMaxDepth passes through valid integers", () => {
  assert.equal(normalizeMaxDepth(0), 0);
  assert.equal(normalizeMaxDepth(3), 3);
});

// ---------------------------------------------------------------------------
// Unit tests for depthWithinScope
// ---------------------------------------------------------------------------

test("depthWithinScope: root-level file in root scope has depth 0", () => {
  assert.equal(depthWithinScope("file.ts", "."), 0);
});

test("depthWithinScope: nested files in root scope count separators", () => {
  assert.equal(depthWithinScope("src/one.ts", "."), 1);
  assert.equal(depthWithinScope("a/b/c.ts", "."), 2);
});

test("depthWithinScope: item exactly matching scope returns 0", () => {
  assert.equal(depthWithinScope("src/nested", "src/nested"), 0);
});

test("depthWithinScope: direct child of nested scope has depth 0", () => {
  assert.equal(depthWithinScope("src/nested/file.ts", "src/nested"), 0);
});

test("depthWithinScope: deeper child of nested scope counts relative depth", () => {
  assert.equal(depthWithinScope("src/nested/deeper/file.ts", "src/nested"), 1);
});

test("depthWithinScope: normalizes backslashes", () => {
  assert.equal(depthWithinScope("src\\nested\\file.ts", "src/nested"), 0);
  assert.equal(depthWithinScope("src\\nested\\deeper\\file.ts", "src/nested"), 1);
});

test("depthWithinScope: normalizes double slashes", () => {
  assert.equal(depthWithinScope("src//nested//file.ts", "src/nested"), 0);
});
