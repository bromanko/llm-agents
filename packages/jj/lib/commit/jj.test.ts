import test from "node:test";
import assert from "node:assert/strict";
import { parseHunks, JjError } from "./jj.ts";

// ---------------------------------------------------------------------------
// parseHunks — pure function, no jj binary needed
// ---------------------------------------------------------------------------

test("parseHunks: extracts hunks from a git-format diff", () => {
  const diff = `diff --git a/src/main.ts b/src/main.ts
index abc1234..def5678 100644
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,4 @@
 import { foo } from "./foo";
+import { bar } from "./bar";
 
 export function main() {
@@ -10,6 +11,8 @@
   const x = 1;
+  const y = 2;
+  const z = 3;
   return x;
 }`;

  const hunks = parseHunks(diff);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0].index, 0);
  assert.ok(hunks[0].header.startsWith("@@ -1,3 +1,4 @@"));
  assert.ok(hunks[0].content.includes('+import { bar } from "./bar"'));
  assert.equal(hunks[1].index, 1);
  assert.ok(hunks[1].header.startsWith("@@ -10,6 +11,8 @@"));
  assert.ok(hunks[1].content.includes("+  const y = 2;"));
});

test("parseHunks: returns empty array for diff with no hunks", () => {
  const diff = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29`;

  const hunks = parseHunks(diff);
  assert.equal(hunks.length, 0);
});

test("parseHunks: handles single hunk", () => {
  const diff = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,3 @@
 line1
+line2
 line3`;

  const hunks = parseHunks(diff);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].index, 0);
  assert.ok(hunks[0].content.includes("+line2"));
});

test("parseHunks: returns empty array for empty string", () => {
  assert.deepStrictEqual(parseHunks(""), []);
});

// ---------------------------------------------------------------------------
// JjError
// ---------------------------------------------------------------------------

test("JjError: has command and stderr properties", () => {
  const err = new JjError("jj diff --git", "fatal: not a jj repo");
  assert.equal(err.command, "jj diff --git");
  assert.equal(err.stderr, "fatal: not a jj repo");
  assert.ok(err.message.includes("jj diff --git"));
  assert.ok(err.message.includes("fatal: not a jj repo"));
  assert.equal(err.name, "JjError");
});

// ---------------------------------------------------------------------------
// ControlledJj integration-style tests (with real jj binary)
// These tests create a temporary jj repo and exercise actual commands.
// They are skipped if jj is not available.
// ---------------------------------------------------------------------------

import { ControlledJj } from "./jj.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

function jjAvailable(): boolean {
  try {
    execFileSync("jj", ["version"], { encoding: "utf-8", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function createTempJjRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-commit-test-"));
  execFileSync("jj", ["git", "init", "--colocate"], { cwd: dir, timeout: 10000 });
  // Configure required identity
  execFileSync("jj", ["config", "set", "--repo", "user.name", "Test User"], { cwd: dir, timeout: 5000 });
  execFileSync("jj", ["config", "set", "--repo", "user.email", "test@example.com"], { cwd: dir, timeout: 5000 });
  return dir;
}

const HAS_JJ = jjAvailable();

test("ControlledJj.getChangedFiles: returns modified files", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "world\n");

    const jj = new ControlledJj(dir);
    const files = await jj.getChangedFiles();
    assert.ok(files.includes("a.txt"));
    assert.ok(files.includes("b.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getDiffGit: returns git-format diff", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");

    const jj = new ControlledJj(dir);
    const diff = await jj.getDiffGit();
    assert.ok(diff.includes("diff --git"));
    assert.ok(diff.includes("a.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getDiffGit: scoped to specific files", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "world\n");

    const jj = new ControlledJj(dir);
    const diff = await jj.getDiffGit(["a.txt"]);
    assert.ok(diff.includes("a.txt"));
    assert.ok(!diff.includes("b.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getStat: returns stat summary", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");

    const jj = new ControlledJj(dir);
    const stat = await jj.getStat();
    assert.ok(stat.includes("a.txt"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getHunks: extracts hunks for a file", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "line1\n");

    const jj = new ControlledJj(dir);
    const hunks = await jj.getHunks("a.txt");
    assert.ok(hunks.length >= 1);
    assert.ok(hunks[0].header.includes("@@"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getRecentCommits: returns commit summaries", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("jj", ["commit", "-m", "initial commit"], { cwd: dir, timeout: 5000 });

    const jj = new ControlledJj(dir);
    const commits = await jj.getRecentCommits(5);
    assert.ok(commits.some((c) => c.includes("initial commit")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.commit: creates a commit with message", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");

    const jj = new ControlledJj(dir);
    await jj.commit("test commit");

    const commits = await jj.getRecentCommits(5);
    assert.ok(commits.some((c) => c.includes("test commit")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.commit: commits only specified files", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "world\n");

    const jj = new ControlledJj(dir);
    await jj.commit("partial commit", ["a.txt"]);

    // After committing only a.txt, b.txt should still be in working copy
    const remaining = await jj.getChangedFiles();
    assert.ok(remaining.includes("b.txt"), "b.txt should remain uncommitted");
    assert.ok(!remaining.includes("a.txt"), "a.txt should be committed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.setBookmark + pushBookmark: error on no remote", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("jj", ["commit", "-m", "initial"], { cwd: dir, timeout: 5000 });

    const jj = new ControlledJj(dir);
    // setBookmark should succeed locally
    await jj.setBookmark("main", "@-");

    // pushBookmark should fail (no remote configured)
    await assert.rejects(() => jj.pushBookmark("main"), JjError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
