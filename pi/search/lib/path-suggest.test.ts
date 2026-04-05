import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validatePath, validatePaths } from "./path-suggest.ts";
import type { PathValidationResult, SinglePathValidator } from "./types.ts";

let baseDir = "";

test.before(async () => {
  baseDir = await mkdtemp(path.join(tmpdir(), "pi-search-path-"));
});

test.after(async () => {
  if (baseDir) {
    await rm(baseDir, { recursive: true, force: true });
  }
});

async function makeWorkspace(name: string): Promise<string> {
  const workspace = path.join(baseDir, name);
  await mkdir(workspace, { recursive: true });
  return workspace;
}

test("accepts a valid existing directory path unchanged", async () => {
  const workspace = await makeWorkspace("valid-existing-path");
  await mkdir(path.join(workspace, "src"), { recursive: true });

  const result = await validatePath("src", workspace);
  assert.deepEqual(result, { valid: true, resolved: "src", kind: "directory" });
});

test("accepts default scope inputs as the workspace root directory", async () => {
  const workspace = await makeWorkspace("default-scope");

  await assert.doesNotReject(async () => {
    assert.deepEqual(await validatePath(undefined, workspace), { valid: true, resolved: ".", kind: "directory" });
    assert.deepEqual(await validatePath("", workspace), { valid: true, resolved: ".", kind: "directory" });
    assert.deepEqual(await validatePath(".", workspace), { valid: true, resolved: ".", kind: "directory" });
  });
});

test("accepts valid file paths and reports file kind", async () => {
  const workspace = await makeWorkspace("valid-file-path");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "index.ts"), "export const value = 1;\n");

  const result = await validatePath("src/index.ts", workspace);
  assert.deepEqual(result, { valid: true, resolved: "src/index.ts", kind: "file" });
});

test("normalizes Windows-style separators in valid input", async () => {
  const workspace = await makeWorkspace("windows-separators");
  await mkdir(path.join(workspace, "src", "components"), { recursive: true });

  const result = await validatePath("src\\components", workspace);
  assert.deepEqual(result, { valid: true, resolved: "src/components", kind: "directory" });
});

test("returns suggestion when basename matches a single directory", async () => {
  const workspace = await makeWorkspace("single-basename-match");
  await mkdir(path.join(workspace, "src", "components"), { recursive: true });

  const result = await validatePath("components", workspace);
  assert.deepEqual(result, { valid: false, suggestions: ["src/components"] });
});

test("returns typo-based suggestions for close path matches", async () => {
  const workspace = await makeWorkspace("typo-suggestions");
  await mkdir(path.join(workspace, "src", "components"), { recursive: true });

  const result = await validatePath("componnts", workspace);
  assert.deepEqual(result, { valid: false, suggestions: ["src/components"] });
});

test("ranks exact basename matches ahead of prefix matches", async () => {
  const workspace = await makeWorkspace("ranking-order");
  await mkdir(path.join(workspace, "src", "components"), { recursive: true });
  await mkdir(path.join(workspace, "components-lib"), { recursive: true });

  const result = await validatePath("components", workspace);
  assert.deepEqual(result, { valid: false, suggestions: ["src/components", "components-lib"] });
});

test("suggests file paths and normalizes returned separators", async () => {
  const workspace = await makeWorkspace("file-suggestions");
  await mkdir(path.join(workspace, "src"), { recursive: true });
  await writeFile(path.join(workspace, "src", "config.ts"), "export {};\n");

  const result = await validatePath("src\\config", workspace);
  assert.deepEqual(result, { valid: false, suggestions: ["src/config.ts"] });
});

test("returns no suggestions when nothing matches", async () => {
  const workspace = await makeWorkspace("no-suggestions");

  const result = await validatePath("nonexistent", workspace);
  assert.deepEqual(result, { valid: false, suggestions: [] });
});

test("caps suggestions at three entries", async () => {
  const workspace = await makeWorkspace("caps-at-three");
  await mkdir(path.join(workspace, "a", "utils"), { recursive: true });
  await mkdir(path.join(workspace, "b", "utils"), { recursive: true });
  await mkdir(path.join(workspace, "c", "utils"), { recursive: true });
  await mkdir(path.join(workspace, "d", "utils"), { recursive: true });

  const result = await validatePath("utils", workspace);
  assert.equal(result.valid, false);
  assert.equal(result.suggestions.length, 3);
});

test("paths outside the working tree root are rejected when they do not exist", async () => {
  const workspace = await makeWorkspace("reject-outside-nonexistent");

  const result = await validatePath("../../definitely-nonexistent-path", workspace);
  assert.deepEqual(result, { valid: false, suggestions: [] });
});

test("paths outside the working tree root are accepted when they exist", async () => {
  const outerDir = await makeWorkspace("outer-dir");
  const workspace = await makeWorkspace("inner-workspace");

  const result = await validatePath(outerDir, workspace);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.kind, "directory");
    // Resolved path should be the absolute path since it's outside root
    assert.equal(result.resolved, outerDir.replace(/[\\/]+/g, "/"));
  }
});

test("external relative typos suggest sibling paths outside the working tree root", async () => {
  const parentDir = await makeWorkspace("outer-parent");
  const workspace = path.join(parentDir, "inner-workspace");
  await mkdir(workspace, { recursive: true });
  await mkdir(path.join(parentDir, "project-real"), { recursive: true });

  const result = await validatePath("../projct-real", workspace);
  assert.deepEqual(result, { valid: false, suggestions: ["../project-real"] });
});

test("absolute paths outside root resolve to absolute in resolved field", async () => {
  const workspace = await makeWorkspace("abs-outside-root");
  const outerDir = await makeWorkspace("abs-outer");
  await writeFile(path.join(outerDir, "hello.txt"), "hi");

  const result = await validatePath(path.join(outerDir, "hello.txt"), workspace);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.kind, "file");
    assert.ok(path.isAbsolute(result.resolved.replace(/\//g, path.sep)));
  }
});

test("absolute path typos suggest sibling absolute paths", async () => {
  const workspace = await makeWorkspace("abs-suggest-workspace");
  const outerDir = await makeWorkspace("abs-suggest-parent");
  await mkdir(path.join(outerDir, "target-dir"), { recursive: true });

  const result = await validatePath(path.join(outerDir, "targt-dir"), workspace);
  assert.deepEqual(result, {
    valid: false,
    suggestions: [path.join(outerDir, "target-dir").replace(/[\\/]+/g, "/")],
  });
});

test("tilde path expands to home directory", async () => {
  const workspace = await makeWorkspace("tilde-expand");
  // ~ should resolve to the home directory which always exists
  const result = await validatePath("~", workspace);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.kind, "directory");
  }
});

// --- validatePaths tests ---

test("validatePaths: undefined input resolves to cwd", async () => {
  const workspace = await makeWorkspace("vpaths-undefined");
  const result = await validatePaths(undefined, workspace);
  assert.deepEqual(result, { valid: true, resolved: ["."] });
});

test("validatePaths: single string resolves to one entry", async () => {
  const workspace = await makeWorkspace("vpaths-single");
  await mkdir(path.join(workspace, "src"));
  const result = await validatePaths("src", workspace);
  assert.deepEqual(result, { valid: true, resolved: ["src"] });
});

test("validatePaths: array of strings resolves all entries", async () => {
  const workspace = await makeWorkspace("vpaths-array");
  await mkdir(path.join(workspace, "src"));
  await mkdir(path.join(workspace, "lib"));
  const result = await validatePaths(["src", "lib"], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["src", "lib"] });
});

test("validatePaths: empty array resolves to cwd", async () => {
  const workspace = await makeWorkspace("vpaths-empty-array");
  const result = await validatePaths([], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["."] });
});

test("validatePaths: first invalid path short-circuits", async () => {
  const workspace = await makeWorkspace("vpaths-invalid");
  await mkdir(path.join(workspace, "src"));
  const result = await validatePaths(["src", "nonexistent"], workspace);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.failedPath, "nonexistent");
  }
});

// Finding 2: integration test — real validatePath with undefined and []
test("validatePaths: undefined input resolves via real validatePath", async () => {
  const workspace = await makeWorkspace("vpaths-undefined-integration");
  const result = await validatePaths(undefined, workspace);
  assert.deepEqual(result, { valid: true, resolved: ["."] });
});

test("validatePaths: empty array resolves via real validatePath", async () => {
  const workspace = await makeWorkspace("vpaths-empty-integration");
  const result = await validatePaths([], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["."] });
});

// Finding 3: first element is invalid
test("validatePaths: first element invalid short-circuits immediately", async () => {
  const workspace = await makeWorkspace("vpaths-first-invalid");
  await mkdir(path.join(workspace, "src"));
  const result = await validatePaths(["nonexistent", "src"], workspace);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.failedPath, "nonexistent");
  }
});

// Finding 4: mock singleValidator to verify per-path calls
test("validatePaths: calls singleValidator for each path with correct args", async () => {
  const calls: Array<[string | undefined, string]> = [];
  const fakeSingle: SinglePathValidator = async (p, root) => {
    calls.push([p, root]);
    return { valid: true, resolved: p ?? ".", kind: "directory" as const };
  };

  const result = await validatePaths(["a", "b", "c"], "/root", fakeSingle);

  assert.equal(result.valid, true);
  assert.deepEqual(calls, [
    ["a", "/root"],
    ["b", "/root"],
    ["c", "/root"],
  ]);
  if (result.valid) {
    assert.deepEqual(result.resolved, ["a", "b", "c"]);
  }
});

// Finding 5: empty string handling
test("validatePaths: empty string input resolves to cwd", async () => {
  const workspace = await makeWorkspace("vpaths-empty-string");
  const result = await validatePaths("", workspace);
  assert.deepEqual(result, { valid: true, resolved: ["."] });
});

test("validatePaths: empty strings in array are filtered out", async () => {
  const workspace = await makeWorkspace("vpaths-empty-string-array");
  await mkdir(path.join(workspace, "src"));
  const result = await validatePaths(["src", ""], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["src"] });
});

test("validatePaths: array of only empty strings resolves to cwd", async () => {
  const workspace = await makeWorkspace("vpaths-all-empty-strings");
  const result = await validatePaths(["", ""], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["."] });
});

// Finding 8: upper bound on paths
test("validatePaths: rejects more than 20 paths", async () => {
  const workspace = await makeWorkspace("vpaths-too-many");
  const paths = Array.from({ length: 21 }, (_, i) => `dir${i}`);
  const result = await validatePaths(paths, workspace);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.failedPath, "<21 paths>");
    assert.deepEqual(result.suggestions, []);
  }
});

// Finding 9: single-element array
test("validatePaths: single-element array resolves to one entry", async () => {
  const workspace = await makeWorkspace("vpaths-single-array");
  await mkdir(path.join(workspace, "src"));
  const result = await validatePaths(["src"], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["src"] });
});

// Finding 10: duplicate paths
test("validatePaths: duplicate paths are preserved (no dedup)", async () => {
  const workspace = await makeWorkspace("vpaths-dupes");
  await mkdir(path.join(workspace, "src"));
  const result = await validatePaths(["src", "src"], workspace);
  assert.deepEqual(result, { valid: true, resolved: ["src", "src"] });
});

// Finding 11: concurrent validation still reports first failure in input order
test("validatePaths: reports first failure in input order with concurrent validation", async () => {
  const calls: string[] = [];
  const fakeSingle: SinglePathValidator = async (p, _root) => {
    calls.push(p ?? ".");
    if (p === "bad") return { valid: false, suggestions: ["good"] };
    return { valid: true, resolved: p ?? ".", kind: "directory" as const };
  };

  const result = await validatePaths(["ok", "bad", "also-ok"], "/root", fakeSingle);

  // All validators are called concurrently
  assert.equal(calls.length, 3);
  // But the first failure in input order is reported
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.equal(result.failedPath, "bad");
    assert.deepEqual(result.suggestions, ["good"]);
  }
});
