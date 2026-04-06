import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import registerGrepExtension, { buildPathError, createGrepToolDefinition, type GrepToolDeps, type MultiPathValidator } from "../extensions/grep.ts";
import { DEFAULT_GREP_LIMIT } from "../lib/constants.ts";
import type { GrepToolParams, MultiPathValidationResult, PathValidationResult, RgExecutor, RgResult, SinglePathValidator } from "../lib/types.ts";

type GrepTool = ReturnType<typeof createGrepToolDefinition>;
type GrepResult = Awaited<ReturnType<GrepTool["execute"]>>;

function createMockPi(): Pick<ExtensionAPI, "registerTool"> & { getTools(): GrepTool[] } {
  const tools: GrepTool[] = [];
  return {
    registerTool(tool: GrepTool) {
      tools.push(tool);
    },
    getTools() {
      return tools;
    },
  };
}

function setupExtension(deps: GrepToolDeps = {}): GrepTool {
  const pi = createMockPi();

  if (Object.keys(deps).length === 0) {
    registerGrepExtension(pi as ExtensionAPI);
  } else {
    pi.registerTool(createGrepToolDefinition(deps));
  }

  const [tool] = pi.getTools();
  assert.ok(tool);
  return tool;
}

function getText(result: Pick<GrepResult, "content">): string {
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

function asGrepParams(params: Partial<GrepToolParams>): GrepToolParams {
  return params as GrepToolParams;
}

function executeGrep(tool: GrepTool, params: GrepToolParams): Promise<GrepResult> {
  return tool.execute("call", params, undefined, undefined, { cwd: process.cwd() });
}

test("registers a tool named grep", () => {
  const tool = setupExtension();
  assert.equal(tool.name, "grep");
});

test("schema exposes all built-in-compatible fields", () => {
  const tool = createGrepToolDefinition();
  const properties = tool.parameters.properties;

  assert.ok(properties.pattern);
  assert.ok(properties.path);
  assert.ok(properties.glob);
  assert.ok(properties.ignoreCase);
  assert.ok(properties.literal);
  assert.ok(properties.context);
  assert.ok(properties.limit);
});

test("schema exposes P0 extension fields and prompt guidance", () => {
  const tool = createGrepToolDefinition();
  const properties = tool.parameters.properties;

  assert.ok(properties.anyOf);
  assert.ok(properties.offset);
  assert.ok(properties.outputMode);
  assert.ok(properties.type);
  assert.ok(properties.hidden);
  assert.ok(properties.respectIgnore);
  assert.ok(properties.regex);
  assert.equal(tool.promptSnippet, "Search file contents with pagination and path-aware scoping.");
  assert.deepEqual(tool.promptGuidelines, [
    "Use grep instead of bash grep or rg for content searches whenever the structured tool can answer the question.",
    "Prefer outputMode, glob, type, context, limit, and offset over shell pipes when shaping search output.",
  ]);
});

test("rejects call with both pattern and anyOf", async () => {
  const tool = createGrepToolDefinition();
  const result = await executeGrep(tool, { pattern: "foo", anyOf: ["bar"] });
  assert.match(getText(result), /Exactly one of pattern or anyOf must be provided/);
});

test("rejects call with neither pattern nor anyOf", async () => {
  const tool = createGrepToolDefinition();
  const result = await executeGrep(tool, asGrepParams({}));
  assert.match(getText(result), /Exactly one of pattern or anyOf must be provided/);
});

test("rejects call with an explicitly empty anyOf array", async () => {
  const tool = createGrepToolDefinition();
  const result = await executeGrep(tool, asGrepParams({ anyOf: [] }));
  assert.equal(getText(result), "Error: anyOf must not be empty when provided.");
  assert.deepEqual(result.details, {
    isError: true,
    error: "anyOf must not be empty when provided.",
  });
});

test("default search mode is literal when pattern is used", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { pattern: "foo.bar" });

  assert.ok(capture.getArgs().includes("-F"));
});

test("regex: true suppresses literal mode", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { pattern: "foo.*bar", regex: true });

  assert.equal(capture.getArgs().includes("-F"), false);
});

test("literal: false suppresses literal mode for backward compat", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { pattern: "foo.*bar", literal: false });

  assert.equal(capture.getArgs().includes("-F"), false);
});

test("anyOf builds repeated literal -e terms", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { anyOf: ["alpha", "beta", "gamma"] });

  assert.deepEqual(
    capture.getArgs().filter((arg) => arg === "-F" || arg === "-e" || ["alpha", "beta", "gamma"].includes(arg)),
    ["-F", "-e", "alpha", "-e", "beta", "-e", "gamma"],
  );
});

test("content-mode args normalize context and include glob, case, hidden, and ignore flags", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, {
    pattern: "Foo",
    context: -3.8,
    glob: "*.ts",
    ignoreCase: true,
    hidden: true,
    respectIgnore: false,
  });

  const args = capture.getArgs();
  assert.ok(args.includes("--no-heading"));
  assert.ok(args.includes("-n"));
  assert.ok(args.includes("-H"));
  assert.equal(args[args.indexOf("-C") + 1], "0");
  assert.ok(args.includes("-i"));
  assert.ok(args.includes("--hidden"));
  assert.ok(args.includes("--no-ignore"));

  const globIndex = args.lastIndexOf("--glob");
  assert.ok(globIndex >= 0);
  assert.equal(args[globIndex + 1], "*.ts");
});

test("outputMode files_with_matches passes -l flag", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { pattern: "test", outputMode: "files_with_matches" });

  assert.ok(capture.getArgs().includes("-l"));
});

test("outputMode count passes -c flag", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { pattern: "test", outputMode: "count" });

  assert.ok(capture.getArgs().includes("-c"));
});

test("count mode summary reports total matches and exposes totalMatchCount details", async () => {
  const lines = ["a.ts:1", "path:with:colon.ts:3", "c.ts:4"];
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeGrep(tool, { pattern: "test", outputMode: "count" });
  const text = getText(result);
  assert.match(text, /3 files with matches/);
  assert.match(text, /8 total matches/);
  assert.deepEqual(result.details, {
    mode: "grep count",
    scope: ".",
    items: lines,
    totalCount: 3,
    returnedCount: 3,
    truncated: false,
    nextOffset: undefined,
    offset: 0,
    totalMatchCount: 8,
  });
});

test("count mode with nonzero offset reports pagination summary and details", async () => {
  const lines = ["a.ts:1", "b.ts:2", "c.ts:3"];
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeGrep(tool, { pattern: "test", outputMode: "count", limit: 1, offset: 1 });
  assert.equal(
    getText(result),
    "Mode: grep count | Scope: .\nb.ts:2\nShowing 2–2 of 3 files with match counts (6 total matches). Use offset=2 to continue.",
  );
  assert.deepEqual(result.details, {
    mode: "grep count",
    scope: ".",
    items: ["b.ts:2"],
    totalCount: 3,
    returnedCount: 1,
    truncated: true,
    nextOffset: 2,
    offset: 1,
    totalMatchCount: 6,
  });
});

test("count mode offset past end reports an empty page summary", async () => {
  const lines = ["a.ts:1", "b.ts:2"];
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeGrep(tool, { pattern: "test", outputMode: "count", limit: 1, offset: 10 });
  assert.equal(
    getText(result),
    "Mode: grep count | Scope: .\nNo count rows on this page. Offset=10 is past the end of 2 files with matches (3 total matches).",
  );
  assert.deepEqual(result.details, {
    mode: "grep count",
    scope: ".",
    items: [],
    totalCount: 2,
    returnedCount: 0,
    truncated: false,
    nextOffset: undefined,
    offset: 10,
    totalMatchCount: 3,
  });
});

test("invalid path returns suggestion when available", async () => {
  const tool = createGrepToolDefinition({
    multiPathValidator: async () => ({ valid: false, failedPath: "lib", suggestions: ["src/lib"] }),
  });

  const result = await executeGrep(tool, { pattern: "foo", path: "lib" });
  assert.match(getText(result), /src\/lib/);
  assert.deepEqual(result.details, {
    isError: true,
    error: "Path not found: lib",
    suggestions: ["src/lib"],
  });
});

test("invalid path without suggestions returns a plain structured error", async () => {
  const tool = createGrepToolDefinition({
    multiPathValidator: async () => ({ valid: false, failedPath: "missing", suggestions: [] }),
  });

  const result = await executeGrep(tool, { pattern: "foo", path: "missing" });
  assert.equal(getText(result), "Error: Path not found: missing");
  assert.deepEqual(result.details, {
    isError: true,
    error: "Path not found: missing",
    suggestions: [],
  });
});

test("pagination text includes next offset", async () => {
  const lines = Array.from({ length: 60 }, (_, index) => `file:${index + 1}:foo`);
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeGrep(tool, { pattern: "foo", limit: 50, offset: 0 });
  assert.match(getText(result), /offset=50/);
});

test("omitting limit uses the default grep page size", async () => {
  const lines = Array.from({ length: DEFAULT_GREP_LIMIT + 2 }, (_, index) => `file:${index + 1}:foo`);
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines, matched: true, error: null }),
  });

  const result = await executeGrep(tool, { pattern: "foo" });
  assert.deepEqual(result.details, {
    mode: "grep content",
    scope: ".",
    items: lines.slice(0, DEFAULT_GREP_LIMIT),
    totalCount: DEFAULT_GREP_LIMIT + 2,
    returnedCount: DEFAULT_GREP_LIMIT,
    truncated: true,
    nextOffset: DEFAULT_GREP_LIMIT,
    offset: 0,
    totalMatchCount: undefined,
  });
});

test("type field passes through to rg --type", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({ rgExecutor: capture.executor });

  await executeGrep(tool, { pattern: "foo", type: "ts" });

  assert.deepEqual(capture.getArgs().filter((arg) => arg === "--type" || arg === "ts"), ["--type", "ts"]);
});

test("rg exit code 1 returns empty results not an error", async () => {
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines: [], matched: false, error: null }),
  });

  const result = await executeGrep(tool, { pattern: "nonexistent" });
  const text = getText(result);
  assert.match(text, /0 results/);
  assert.doesNotMatch(text, /Error:/);
});

test("rg execution errors surface structured error details", async () => {
  const tool = createGrepToolDefinition({
    multiPathValidator: async () => ({ valid: true, resolved: ["src"] }),
    rgExecutor: async () => ({ lines: [], matched: false, error: "regex parse error" }),
  });

  const result = await executeGrep(tool, { pattern: "foo", regex: true, path: "src" });
  assert.equal(getText(result), "Error: regex parse error");
  assert.deepEqual(result.details, {
    isError: true,
    error: "regex parse error",
    scope: "src",
  });
});

test("rg not found returns installation guidance", async () => {
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({
      lines: [],
      matched: false,
      error: "ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep",
    }),
  });

  const result = await executeGrep(tool, { pattern: "foo" });
  const text = getText(result);
  assert.match(text, /ripgrep/);
  assert.match(text, /Install it/);
});

// --- Multi-path tests ---

test("schema path field accepts a string or array via oneOf", () => {
  const tool = createGrepToolDefinition();
  const pathProp = tool.parameters.properties.path;
  assert.ok(pathProp);
  assert.ok("oneOf" in pathProp, "path property should have oneOf for string|array");
});

test("multi-path passes all resolved paths to rg", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({
    rgExecutor: capture.executor,
    multiPathValidator: async () => ({ valid: true, resolved: ["src", "lib", "tests"] }),
  });

  await executeGrep(tool, { pattern: "foo", path: ["src", "lib", "tests"] });

  const args = capture.getArgs();
  // The last 3 args should be the paths
  assert.deepEqual(args.slice(-3), ["src", "lib", "tests"]);
});

test("multi-path scope shows comma-separated paths", async () => {
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines: ["src/a.ts:1:foo", "lib/b.ts:2:foo"], matched: true, error: null }),
    multiPathValidator: async () => ({ valid: true, resolved: ["src", "lib"] }),
  });

  const result = await executeGrep(tool, { pattern: "foo", path: ["src", "lib"] });
  const text = getText(result);
  assert.match(text, /Scope: src, lib/);
});

test("multi-path with one invalid path returns error for that path", async () => {
  const tool = createGrepToolDefinition({
    multiPathValidator: async () => ({ valid: false, failedPath: "nonexistent", suggestions: ["nexistent"] }),
  });

  const result = await executeGrep(tool, { pattern: "foo", path: ["src", "nonexistent"] });
  assert.match(getText(result), /Path not found: nonexistent/);
  assert.match(getText(result), /nexistent/);
});

test("single string path still works (backward compat)", async () => {
  const capture = createCapturingExecutor();
  const tool = createGrepToolDefinition({
    rgExecutor: capture.executor,
    multiPathValidator: async () => ({ valid: true, resolved: ["src"] }),
  });

  await executeGrep(tool, { pattern: "foo", path: "src" });

  const args = capture.getArgs();
  assert.equal(args[args.length - 1], "src");
});

test("multi-path details include comma-separated scope", async () => {
  const tool = createGrepToolDefinition({
    rgExecutor: async () => ({ lines: ["a.ts:1:foo"], matched: true, error: null }),
    multiPathValidator: async () => ({ valid: true, resolved: ["dir1", "dir2"] }),
  });

  const result = await executeGrep(tool, { pattern: "foo", path: ["dir1", "dir2"] });
  assert.equal(result.details?.scope, "dir1, dir2");
});

// Finding 7: integration test — real validatePaths wired with mock pathValidator
test("multiPathValidator receives singlePathValidator from deps", async () => {
  const singleCalls: string[] = [];
  const tool = createGrepToolDefinition({
    pathValidator: async (p, _root) => {
      singleCalls.push(p ?? ".");
      return { valid: true, resolved: p ?? ".", kind: "directory" as const };
    },
    rgExecutor: async () => ({ lines: [], matched: false, error: null }),
  });

  await executeGrep(tool, { pattern: "foo", path: ["a", "b"] });
  assert.deepEqual(singleCalls, ["a", "b"]);
});

// Finding 12: direct unit tests for buildPathError
test("buildPathError with no suggestions", () => {
  assert.equal(buildPathError("foo/bar", []), "Error: Path not found: foo/bar");
});

test("buildPathError with suggestions", () => {
  assert.equal(
    buildPathError("foo/bar", ["foo/baz", "foo/bat"]),
    "Error: Path not found: foo/bar. Did you mean: foo/baz, foo/bat",
  );
});

// Finding 13: verify singlePathValidator is forwarded as third arg to multiPathValidator
test("multiPathValidator receives the configured singlePathValidator", async () => {
  let receivedValidator: unknown;
  const mySingle: SinglePathValidator = async () => ({ valid: true, resolved: "x", kind: "file" });
  const myMulti: MultiPathValidator = async (_input, _root, single) => {
    receivedValidator = single;
    return { valid: true, resolved: ["."] };
  };

  const tool = createGrepToolDefinition({
    pathValidator: mySingle,
    multiPathValidator: myMulti,
    rgExecutor: async () => ({ lines: [], matched: false, error: null }),
  });

  await executeGrep(tool, { pattern: "foo" });
  assert.equal(receivedValidator, mySingle);
});

// --- renderCall tests ---

function renderText(tool: GrepTool, params: GrepToolParams): string {
  const component = tool.renderCall!(params);
  return component.render(200).join("\n");
}

test("renderCall shows pattern with slashes", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { pattern: "foo" });
  assert.match(text, /grep \/foo\/ in \./);
});

test("renderCall shows anyOf terms quoted and pipe-separated", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { anyOf: ["alpha", "beta"] });
  assert.match(text, /grep "alpha" \| "beta" in \./);
});

test("renderCall shows string path", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { pattern: "foo", path: "src/lib" });
  assert.match(text, /in src\/lib/);
});

test("renderCall shows array path as comma-separated list", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { pattern: "foo", path: ["src", "lib"] });
  assert.match(text, /in src, lib/);
});

test("renderCall shows limit and outputMode", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { pattern: "foo", limit: 50, outputMode: "files_with_matches" });
  assert.match(text, /limit 50/);
  assert.match(text, /\[files_with_matches\]/);
});

test("renderCall shows glob and type", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { pattern: "foo", glob: "*.ts", type: "py" });
  assert.match(text, /\(\*\.ts\)/);
  assert.match(text, /type:py/);
});

test("renderCall does not show outputMode when content (default)", () => {
  const tool = createGrepToolDefinition();
  const text = renderText(tool, { pattern: "foo", outputMode: "content" });
  assert.doesNotMatch(text, /\[content\]/);
});

test("renderCall truncates header to given width", () => {
  const tool = createGrepToolDefinition();
  const longPath = "/nix/store/" + "a".repeat(200) + "/lib/node_modules/@mariozechner/pi-coding-agent";
  const component = tool.renderCall!({ pattern: "foo", path: longPath });
  const lines = component.render(80);
  assert.equal(lines.length, 1);
  assert.ok(lines[0].length <= 80, `Expected line length <= 80, got ${lines[0].length}`);
  assert.ok(lines[0].endsWith("\u2026"), "Truncated line should end with ellipsis");
});

test("renderCall does not truncate header that fits within width", () => {
  const tool = createGrepToolDefinition();
  const component = tool.renderCall!({ pattern: "foo" });
  const lines = component.render(200);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], "grep /foo/ in .");
  assert.doesNotMatch(lines[0], /\u2026/);
});
