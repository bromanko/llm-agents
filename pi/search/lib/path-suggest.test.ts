import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validatePath } from "./path-suggest.ts";

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

test("does not suggest paths outside the working tree root", async () => {
  const workspace = await makeWorkspace("reject-outside-root");

  const result = await validatePath("../../etc", workspace);
  assert.deepEqual(result, { valid: false, suggestions: [] });
});
