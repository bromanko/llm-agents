import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerFindExtension, {
  createFindToolDefinition,
  depthWithinScope,
  normalizeMaxDepth,
  type FindToolDeps,
} from "../extensions/find.ts";
import { DEFAULT_FIND_LIMIT } from "../lib/constants.ts";
import type {
  FdExecutor,
  FdResult,
  FindToolParams,
  RgExecutor,
  RgResult,
} from "../lib/types.ts";

type FindTool = ReturnType<typeof createFindToolDefinition>;
type FindResult = Awaited<ReturnType<FindTool["execute"]>>;
type SuccessfulFindResult = FindResult & {
  details: Exclude<FindResult["details"], { isError: true }>;
};

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

function getSuccessDetails(result: FindResult): SuccessfulFindResult["details"] {
  assert.ok(!("isError" in result.details), `Expected successful result, got: ${JSON.stringify(result.details)}`);
  return result.details;
}

function createCapturingRgExecutor(result: RgResult = { lines: [], matched: true, error: null }): {
  executor: RgExecutor;
  getArgs(): string[];
  getCallCount(): number;
} {
  let capturedArgs: string[] = [];
  let callCount = 0;
  return {
    executor: async (args) => {
      capturedArgs = args;
      callCount += 1;
      return result;
    },
    getArgs() {
      return capturedArgs;
    },
    getCallCount() {
      return callCount;
    },
  };
}

function createCapturingFdExecutor(result: FdResult = { lines: [], error: null }): {
  executor: FdExecutor;
  getArgs(): string[];
  getCallCount(): number;
} {
  let capturedArgs: string[] = [];
  let callCount = 0;
  return {
    executor: async (args) => {
      capturedArgs = args;
      callCount += 1;
      return result;
    },
    getArgs() {
      return capturedArgs;
    },
    getCallCount() {
      return callCount;
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

test("schema exposes directory-aware kind filtering and prompt guidance", () => {
  const tool = createFindToolDefinition();
  const properties = tool.parameters.properties;
  const kindProperty = properties.kind as { readonly enum: readonly string[] };

  assert.ok(properties.offset);
  assert.ok(properties.maxDepth);
  assert.ok(properties.hidden);
  assert.ok(properties.respectIgnore);
  assert.ok(properties.kind);
  assert.deepEqual(kindProperty.enum, ["file", "directory", "any"]);
  assert.equal(tool.promptSnippet, "Find files and directories by path or name pattern with pagination.");
  assert.deepEqual(tool.promptGuidelines, [
    "Use find instead of bash find or ls for file or directory discovery whenever the structured tool can answer the question.",
    "Use kind: \"directory\" instead of bash find -type d, ls, or ls -R when the structured tool can answer the question.",
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

test("default file args include shared skip globs", async () => {
  const capture = createCapturingRgExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts" });

  const args = capture.getArgs();
  assert.ok(args.includes("!.git"));
  assert.ok(args.includes("!node_modules"));
  assert.ok(args.includes("!dist"));
});

test("pattern without glob metacharacters wraps in wildcards for file mode", async () => {
  const capture = createCapturingRgExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "config" });

  assert.ok(capture.getArgs().includes("*config*"));
});

test("pattern with glob metacharacters passes through verbatim in file mode", async () => {
  const capture = createCapturingRgExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.test.ts" });

  assert.ok(capture.getArgs().includes("*.test.ts"));
});

test("resolved nested scope is propagated to rg args and details", async () => {
  const capture = createCapturingRgExecutor({ lines: ["nested/file.ts"], matched: true, error: null });
  const tool = createFindToolDefinition({
    rgExecutor: capture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/nested", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", path: "nested" });
  const args = capture.getArgs();
  assert.equal(args[args.length - 1], "src/nested");
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
  let fdCalled = false;
  const tool = createFindToolDefinition({
    rgExecutor: async () => {
      rgCalled = true;
      return { lines: [], matched: true, error: null };
    },
    fdExecutor: async () => {
      fdCalled = true;
      return { lines: [], error: null };
    },
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "config" });
  assert.equal(rgCalled, false);
  assert.equal(fdCalled, false);
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

test("kind omitted and file kind still use rg instead of fd", async () => {
  const rgCapture = createCapturingRgExecutor({ lines: ["src/file.ts"], matched: true, error: null });
  const fdCapture = createCapturingFdExecutor({ lines: ["src/dir"], error: null });
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  await executeFind(tool, { pattern: "*.ts", path: "src" });
  await executeFind(tool, { pattern: "*.ts", path: "src", kind: "file" });

  assert.equal(rgCapture.getCallCount(), 2);
  assert.equal(fdCapture.getCallCount(), 0);
});

test("directory kind returns only directories with the directory mode string", async () => {
  const fdCapture = createCapturingFdExecutor({
    lines: ["src/components", "src/utils"],
    error: null,
  });
  const tool = createFindToolDefinition({
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "directory", path: "src" });
  assert.equal(fdCapture.getCallCount(), 1);
  assert.equal(getText(result), "Mode: find directories | Scope: src\nsrc/components\nsrc/utils\n2 results.");
  assert.deepEqual(result.details, {
    mode: "find directories",
    scope: "src",
    items: ["src/components", "src/utils"],
    totalCount: 2,
    returnedCount: 2,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("any kind returns mixed files and directories with the path mode string", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["src/components", "src/index.ts", "src/utils.ts"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "any", path: "src" });
  assert.deepEqual(result.details, {
    mode: "find paths",
    scope: "src",
    items: ["src/components", "src/index.ts", "src/utils.ts"],
    totalCount: 3,
    returnedCount: 3,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("directory kind with a file scope returns zero results without invoking executors", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "config", kind: "directory", path: "src/config.ts" });
  assert.equal(rgCapture.getCallCount(), 0);
  assert.equal(fdCapture.getCallCount(), 0);
  assert.deepEqual(result.details, {
    mode: "find directories",
    scope: "src/config.ts",
    items: [],
    totalCount: 0,
    returnedCount: 0,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("any kind with a file scope returns the file when the shared matcher matches", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "src/config", kind: "any", path: "src/config.ts" });
  assert.equal(rgCapture.getCallCount(), 0);
  assert.equal(fdCapture.getCallCount(), 0);
  assert.deepEqual(result.details, {
    mode: "find paths",
    scope: "src/config.ts",
    items: ["src/config.ts"],
    totalCount: 1,
    returnedCount: 1,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

// ---------------------------------------------------------------------------
// Finding 3: file-scope pattern mismatch returns zero results
// ---------------------------------------------------------------------------

test("file scope with non-matching pattern returns zero results in default file mode", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "package" });
  assert.equal(rgCapture.getCallCount(), 0);
  assert.equal(fdCapture.getCallCount(), 0);
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: "src/config.ts",
    items: [],
    totalCount: 0,
    returnedCount: 0,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("file scope with non-matching pattern returns zero results with explicit kind file", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "package", kind: "file" });
  assert.equal(rgCapture.getCallCount(), 0);
  assert.equal(fdCapture.getCallCount(), 0);
  assert.deepEqual(result.details, {
    mode: "find files",
    scope: "src/config.ts",
    items: [],
    totalCount: 0,
    returnedCount: 0,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("file scope with non-matching pattern returns zero results for kind any", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src/config.ts", kind: "file" }),
  });

  const result = await executeFind(tool, { pattern: "package", kind: "any" });
  assert.equal(rgCapture.getCallCount(), 0);
  assert.equal(fdCapture.getCallCount(), 0);
  assert.deepEqual(result.details, {
    mode: "find paths",
    scope: "src/config.ts",
    items: [],
    totalCount: 0,
    returnedCount: 0,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
  });
});

test("slash-containing patterns in directory mode match against full paths", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["components", "src/components", "src/other/components"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "src/components", kind: "directory" });
  assert.deepEqual(getSuccessDetails(result).items, ["src/components"]);
});

test("slash-containing patterns in any mode preserve full-path matching semantics", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["src/lib/fd.ts", "src/lib", "src/other/lib/fd.ts"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "src/lib/*.ts", kind: "any", path: "src" });
  assert.deepEqual(getSuccessDetails(result).items, ["src/lib/fd.ts"]);
});

test("patterns starting with ./ are normalized before matching", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["src/lib", "src/extensions", "src/test"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  const withPrefix = await executeFind(tool, { pattern: "./src/lib", kind: "directory", path: "src" });
  const withoutPrefix = await executeFind(tool, { pattern: "src/lib", kind: "directory", path: "src" });
  assert.deepEqual(getSuccessDetails(withPrefix).items, ["src/lib"]);
  assert.deepEqual(getSuccessDetails(withPrefix).items, getSuccessDetails(withoutPrefix).items);
});

test("any kind behaves as a mixed-mode union rather than a directory-only variant", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      // fd already filtered by basename pattern *components*; only matching entries returned
      lines: ["src/components", "src/components.ts"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "components", kind: "any", path: "src" });
  assert.deepEqual(getSuccessDetails(result).items, ["src/components", "src/components.ts"]);
});

test("directory kind forwards maxDepth, hidden, no-ignore, and excludes to fd", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  await executeFind(tool, {
    pattern: "*",
    kind: "directory",
    path: "src",
    maxDepth: 0,
    hidden: true,
    respectIgnore: false,
  });

  const args = fdCapture.getArgs();
  assert.equal(rgCapture.getCallCount(), 0);
  // When the pattern is a basename-only glob, fd receives --glob <pattern>
  // instead of the match-all regex "."
  assert.equal(args[0], "--glob");
  assert.equal(args[1], "*");
  assert.ok(args.includes("--type"));
  assert.ok(args.includes("d"));
  // Ensure only --type d (not --type f) for directory mode
  const typeIndices = args.reduce<number[]>((acc, v, i) => (v === "--type" ? [...acc, i] : acc), []);
  assert.equal(typeIndices.length, 1, "expected exactly one --type flag for directory mode");
  assert.equal(args[typeIndices[0] + 1], "d");
  assert.ok(args.includes("--max-depth"));
  assert.ok(args.includes("1"));
  assert.ok(args.includes("--hidden"));
  assert.ok(args.includes("--no-ignore"));
  assert.ok(args.includes("--exclude"));
  assert.ok(args.includes(".git"));
  assert.equal(args[args.length - 1], "src");
});

// ---------------------------------------------------------------------------
// Finding 4: kind "any" fd argument verification
// ---------------------------------------------------------------------------

test("any kind forwards both --type f and --type d to fd alongside shared flags", async () => {
  const rgCapture = createCapturingRgExecutor();
  const fdCapture = createCapturingFdExecutor();
  const tool = createFindToolDefinition({
    rgExecutor: rgCapture.executor,
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  await executeFind(tool, {
    pattern: "*",
    kind: "any",
    path: "src",
    maxDepth: 2,
    hidden: true,
    respectIgnore: false,
  });

  const args = fdCapture.getArgs();
  assert.equal(rgCapture.getCallCount(), 0);
  assert.equal(fdCapture.getCallCount(), 1);

  // Both type flags must be present for mixed-mode
  const typeIndices = args.reduce<number[]>((acc, v, i) => (v === "--type" ? [...acc, i] : acc), []);
  assert.equal(typeIndices.length, 2, "expected two --type flags");
  const types = typeIndices.map((i) => args[i + 1]);
  assert.ok(types.includes("f"), "expected --type f");
  assert.ok(types.includes("d"), "expected --type d");

  // Delegated pattern uses --glob mode
  assert.ok(args.includes("--glob"), "expected --glob for delegated pattern");
  assert.ok(args.includes("*"), "expected glob pattern *");

  assert.ok(args.includes("--max-depth"));
  assert.ok(args.includes("3")); // maxDepth 2 + 1 offset
  assert.ok(args.includes("--hidden"));
  assert.ok(args.includes("--no-ignore"));
  assert.ok(args.includes("--exclude"));
  assert.equal(args[args.length - 1], "src");
});

test("fd execution errors surface structured error details", async () => {
  const tool = createFindToolDefinition({
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
    fdExecutor: async () => ({ lines: [], error: "fd failed" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "directory", path: "src" });
  assert.equal(getText(result), "Error: fd failed");
  assert.deepEqual(result.details, {
    isError: true,
    error: "fd failed",
    scope: "src",
  });
});

test("pagination text includes next offset in directory mode", async () => {
  const lines = Array.from({ length: 30 }, (_, index) => `dir-${index + 1}`);
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({ lines, error: null }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "dir", kind: "directory", limit: 20, offset: 0 });
  assert.match(getText(result), /offset=20/);
  assert.equal(getSuccessDetails(result).mode, "find directories");
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

test("pagination text includes next offset in file mode", async () => {
  const lines = Array.from({ length: 30 }, (_, index) => `file-${index + 1}.ts`);
  const tool = createFindToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeFind(tool, { pattern: "*.ts", limit: 20, offset: 0 });
  assert.match(getText(result), /offset=20/);
});

test("respectIgnore false removes ignore behavior in file mode", async () => {
  const capture = createCapturingRgExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts", respectIgnore: false });

  assert.ok(capture.getArgs().includes("--no-ignore"));
});

test("hidden true includes hidden files in file mode", async () => {
  const capture = createCapturingRgExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts", hidden: true });

  assert.ok(capture.getArgs().includes("--hidden"));
});

test("maxDepth is forwarded to rg as --max-depth with +1 offset", async () => {
  const capture = createCapturingRgExecutor();
  const tool = createFindToolDefinition({ rgExecutor: capture.executor });

  await executeFind(tool, { pattern: "*.ts", maxDepth: 0 });
  const args = capture.getArgs();
  const depthIndex = args.indexOf("--max-depth");
  assert.ok(depthIndex !== -1, "--max-depth flag should be present");
  assert.equal(args[depthIndex + 1], "1");
});

test("maxDepth omitted does not add --max-depth to rg args", async () => {
  const capture = createCapturingRgExecutor();
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

test("maxDepth filters file results before pagination", async () => {
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

test("maxDepth 0 at root scope returns only direct file children", async () => {
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
  const details = getSuccessDetails(result);
  assert.equal(details.totalCount, 20);
  assert.equal(details.offset, 5);
  assert.equal(details.returnedCount, 10);
  assert.equal(details.nextOffset, 15);
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
  const details = getSuccessDetails(result);
  assert.deepEqual(details.items, ["root.ts"]);
  assert.equal(details.totalCount, 1);
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
  const details = getSuccessDetails(result);
  assert.deepEqual(details.items, ["root.ts", "src/one.ts", "src/nested/two.ts"]);
  assert.equal(details.totalCount, 3);
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
  assert.equal(depthWithinScope("./file.ts", "."), 0);
});

test("depthWithinScope: nested files in root scope count separators", () => {
  assert.equal(depthWithinScope("src/one.ts", "."), 1);
  assert.equal(depthWithinScope("./src/one.ts", "."), 1);
  assert.equal(depthWithinScope("a/b/c.ts", "."), 2);
  assert.equal(depthWithinScope("./a/b/c.ts", "."), 2);
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

// ---------------------------------------------------------------------------
// Finding 5: fd-backed maxDepth filtering on directory/any results
// ---------------------------------------------------------------------------

test("directory mode maxDepth 0 at root scope returns only direct children", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["alpha", "beta", "alpha/nested", "alpha/nested/deep"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "directory", maxDepth: 0 });
  const details = getSuccessDetails(result);
  assert.deepEqual(details.items, ["alpha", "beta"]);
  assert.equal(details.totalCount, 2);
});

test("directory mode maxDepth filtering relative to a nested scope", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["src/components", "src/components/buttons", "src/components/buttons/primary"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "directory", path: "src", maxDepth: 0 });
  const details = getSuccessDetails(result);
  assert.deepEqual(details.items, ["src/components"]);
  assert.equal(details.totalCount, 1);
});

test("any mode maxDepth filters mixed files and directories", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["root.ts", "lib", "lib/index.ts", "lib/sub", "lib/sub/deep.ts"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "any", maxDepth: 1 });
  const details = getSuccessDetails(result);
  // depth 0: root.ts, lib; depth 1: lib/index.ts, lib/sub
  assert.deepEqual(details.items, ["root.ts", "lib", "lib/index.ts", "lib/sub"]);
  assert.equal(details.totalCount, 4);
});

// ---------------------------------------------------------------------------
// Finding 3: ./-prefixed fd result paths at root scope
// ---------------------------------------------------------------------------

test("fd results with ./-prefixed paths at root scope match slash-containing patterns correctly", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["./src/lib", "./src/lib/fd.ts", "./other"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "src/lib/*.ts", kind: "any" });
  assert.deepEqual(getSuccessDetails(result).items, ["./src/lib/fd.ts"]);
});

test("fd results with ./-prefixed paths respect maxDepth at root scope", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["./src", "./src/lib", "./src/lib/deep"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "directory", maxDepth: 0 });
  assert.deepEqual(getSuccessDetails(result).items, ["./src"]);
});

// ---------------------------------------------------------------------------
// Finding 4: fd invocation shape for slash-containing patterns
// ---------------------------------------------------------------------------

test("slash-containing pattern in directory mode calls fd without --glob and with type/scope flags", async () => {
  const fdCapture = createCapturingFdExecutor({ lines: ["src/components"], error: null });
  const tool = createFindToolDefinition({
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  await executeFind(tool, { pattern: "src/components", kind: "directory" });

  const args = fdCapture.getArgs();
  assert.equal(fdCapture.getCallCount(), 1);
  // Slash-containing patterns must NOT be delegated via --glob
  assert.ok(!args.includes("--glob"), "expected no --glob for slash-containing pattern");
  // Should use match-all regex "." as the fd search pattern
  assert.equal(args[0], ".");
  // Should include --type d for directory mode
  assert.ok(args.includes("--type"));
  assert.ok(args.includes("d"));
  // Scope is the last argument
  assert.equal(args[args.length - 1], ".");
});

test("slash-containing pattern in any mode calls fd without --glob and with both type flags", async () => {
  const fdCapture = createCapturingFdExecutor({ lines: ["src/lib", "src/lib/fd.ts"], error: null });
  const tool = createFindToolDefinition({
    fdExecutor: fdCapture.executor,
    pathValidator: async () => ({ valid: true, resolved: "src", kind: "directory" }),
  });

  await executeFind(tool, { pattern: "src/lib/fd", kind: "any", path: "src" });

  const args = fdCapture.getArgs();
  assert.equal(fdCapture.getCallCount(), 1);
  assert.ok(!args.includes("--glob"), "expected no --glob for slash-containing pattern");
  assert.equal(args[0], ".");
  const typeIndices = args.reduce<number[]>((acc, v, i) => (v === "--type" ? [...acc, i] : acc), []);
  assert.equal(typeIndices.length, 2, "expected two --type flags for any mode");
  const types = typeIndices.map((i) => args[i + 1]);
  assert.ok(types.includes("f"), "expected --type f");
  assert.ok(types.includes("d"), "expected --type d");
  assert.equal(args[args.length - 1], "src");
});

test("directory mode negative maxDepth is clamped to 0", async () => {
  const tool = createFindToolDefinition({
    fdExecutor: async () => ({
      lines: ["alpha", "alpha/nested"],
      error: null,
    }),
    pathValidator: async () => ({ valid: true, resolved: ".", kind: "directory" }),
  });

  const result = await executeFind(tool, { pattern: "*", kind: "directory", maxDepth: -5 });
  const details = getSuccessDetails(result);
  assert.deepEqual(details.items, ["alpha"]);
  assert.equal(details.totalCount, 1);
});
