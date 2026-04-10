import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScopedAbsorbRevset,
  ControlledJj,
  JjError,
  parseHunks,
  parseWorkspaceListOutput,
  runJj,
} from "./jj.ts";

function assertDefined<T>(val: T | null | undefined, message?: string): asserts val is T {
  assert.ok(val !== null && val !== undefined, message ?? "expected value to be defined");
}

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

test("parseWorkspaceListOutput: parses two workspaces", () => {
  const raw = "default\x1fabc123def456abc123def456abc123def456abcd\n" +
    "feature\x1f9876543210abcdef9876543210abcdef98765432\n";
  const result = parseWorkspaceListOutput(raw);

  assert.equal(result.length, 2);
  assert.deepStrictEqual(result[0], {
    name: "default",
    targetCommitId: "abc123def456abc123def456abc123def456abcd",
  });
  assert.deepStrictEqual(result[1], {
    name: "feature",
    targetCommitId: "9876543210abcdef9876543210abcdef98765432",
  });
});

test("parseWorkspaceListOutput: parses single workspace", () => {
  const raw = "default\x1fabc123def456abc123def456abc123def456abcd\n";
  const result = parseWorkspaceListOutput(raw);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, "default");
});

test("parseWorkspaceListOutput: returns empty array for empty output", () => {
  assert.deepStrictEqual(parseWorkspaceListOutput(""), []);
  assert.deepStrictEqual(parseWorkspaceListOutput("\n"), []);
  assert.deepStrictEqual(parseWorkspaceListOutput("\n\n"), []);
});

test("parseWorkspaceListOutput: handles trailing newlines and blank lines", () => {
  const raw = "default\x1fabc123\n\n\nfeature\x1fdef456\n\n";
  const result = parseWorkspaceListOutput(raw);

  assert.equal(result.length, 2);
});

test("parseWorkspaceListOutput: skips malformed lines", () => {
  const raw = "default\x1fabc123\ngarbage-no-separator\nfeature\x1fdef456\n";
  const result = parseWorkspaceListOutput(raw);

  assert.equal(result.length, 2);
  assert.equal(result[0].name, "default");
  assert.equal(result[1].name, "feature");
});

test("buildScopedAbsorbRevset: returns null when no other targets", () => {
  assert.equal(buildScopedAbsorbRevset([]), null);
});

test("buildScopedAbsorbRevset: single other target", () => {
  const result = buildScopedAbsorbRevset(["abc123def456abc123def456abc123def456abcd"]);

  assert.equal(
    result,
    'mutable() & ancestors(@) & ~(ancestors("abc123def456abc123def456abc123def456abcd"))',
  );
});

test("buildScopedAbsorbRevset: multiple other targets", () => {
  const result = buildScopedAbsorbRevset(["aaa111", "bbb222", "ccc333"]);

  assert.equal(
    result,
    'mutable() & ancestors(@) & ~(ancestors("aaa111" | "bbb222" | "ccc333"))',
  );
});

test("buildScopedAbsorbRevset: only expects hex commit IDs (documents assumption)", () => {
  // If someone passes a malformed ID, the output is used as-is —
  // document this so a future validator can be added.
  const result = buildScopedAbsorbRevset(['foo"bar']);
  assert.equal(result, 'mutable() & ancestors(@) & ~(ancestors("foo"bar"))');
  // ^ This would break jj's parser. A future fix should validate inputs.
});

test("getScopedAbsorbRevset: returns scoped revset when all workspaces target same commit", async () => {
  // When all workspaces point at the same commit, absorb should still be scoped
  // to prevent divergent commits.
  class StubJj extends ControlledJj {
    override async listWorkspaceTargets() {
      return [
        { name: "default", targetCommitId: "aaa111" },
        { name: "ws2", targetCommitId: "aaa111" },
      ];
    }
    override async getCurrentWorkspaceName() {
      return "default";
    }
  }

  const jj = new StubJj("/tmp/fake");
  const result = await jj.getScopedAbsorbRevset();
  // With name-based filtering, we still get a scoped revset
  assertDefined(result, "should return a scoped revset");
  assert.ok(result.includes("aaa111"));
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

test("runJj: calls execFile with jj and prepends --color=never while preserving arg order", async () => {
  let capturedFile = "";
  let capturedArgs: string[] = [];
  let capturedCwd = "";

  const mockExecFile = ((file, args, options, callback) => {
    capturedFile = file;
    capturedArgs = [...args];
    capturedCwd = options.cwd;
    callback(null, "stdout text", "stderr text");
  }) as Parameters<typeof runJj>[2];

  const result = await runJj("/tmp/repo", ["log", "-r", "@", "--no-graph"], mockExecFile);

  assert.equal(capturedFile, "jj");
  assert.deepEqual(capturedArgs, ["--color=never", "log", "-r", "@", "--no-graph"]);
  assert.equal(capturedCwd, "/tmp/repo");
  assert.deepEqual(result, { stdout: "stdout text", stderr: "stderr text" });
});

test("runJj: keeps existing error-path behavior", async () => {
  const mockExecFile = ((_, __, ___, callback) => {
    callback(new Error("spawn failed"), "", "jj stderr");
  }) as Parameters<typeof runJj>[2];

  await assert.rejects(
    () => runJj("/tmp/repo", ["diff", "--git"], mockExecFile),
    (error: unknown) => {
      assert.ok(error instanceof JjError);
      assert.equal(error.command, "jj diff --git");
      assert.equal(error.stderr, "jj stderr");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// ControlledJj integration-style tests (with real jj binary)
// These tests create a temporary jj repo and exercise actual commands.
// They are skipped if jj is not available.
// ---------------------------------------------------------------------------

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

test("ControlledJj.listWorkspaceTargets: returns all workspaces", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  const ws2Dir = `${dir}-ws2`;

  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: dir, timeout: 5000 });
    execFileSync("jj", ["workspace", "add", ws2Dir], { cwd: dir, timeout: 10000 });

    const jj = new ControlledJj(dir);
    const targets = await jj.listWorkspaceTargets();
    const names = targets.map((target) => target.name).sort();

    assert.equal(targets.length, 2);
    assert.deepStrictEqual(names, ["default", path.basename(ws2Dir)]);
    for (const target of targets) {
      assert.match(target.targetCommitId, /^[0-9a-f]{40}$/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ws2Dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getCurrentCommitId: returns 40-char hex commit id", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();

  try {
    const jj = new ControlledJj(dir);
    const id = await jj.getCurrentCommitId();

    assert.match(id, /^[0-9a-f]{40}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getScopedAbsorbRevset: returns null for single workspace", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();

  try {
    const jj = new ControlledJj(dir);
    const revset = await jj.getScopedAbsorbRevset();

    assert.equal(revset, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj.getScopedAbsorbRevset: returns revset for multi-workspace", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  const ws2Dir = `${dir}-ws2`;

  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: dir, timeout: 5000 });
    execFileSync("jj", ["workspace", "add", ws2Dir], { cwd: dir, timeout: 10000 });

    const jj = new ControlledJj(dir);
    const revset = await jj.getScopedAbsorbRevset();

    assertDefined(revset, "should return a revset string");
    assert.ok(revset.includes("mutable()"), "revset should include mutable()");
    assert.ok(revset.includes("ancestors(@)"), "revset should include ancestors(@)");
    assert.ok(revset.includes("ancestors("), "revset should subtract other targets");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ws2Dir, { recursive: true, force: true });
  }
});

test("ControlledJj.absorb: accepts optional intoRevset", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();

  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("jj", ["commit", "-m", "base"], { cwd: dir, timeout: 5000 });
    fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");

    const jj = new ControlledJj(dir);
    const result = await jj.absorb("none()");

    assert.equal(result.changed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ControlledJj: scoped absorb only rewrites private-stack commits", { skip: !HAS_JJ }, async () => {
  const dir = createTempJjRepo();
  const ws2Dir = `${dir}-ws2`;

  try {
    fs.writeFileSync(path.join(dir, "shared.txt"), "shared content\n");
    execFileSync("jj", ["commit", "-m", "shared base"], { cwd: dir, timeout: 5000 });
    execFileSync("jj", ["workspace", "add", ws2Dir], { cwd: dir, timeout: 10000 });

    fs.writeFileSync(path.join(dir, "private.txt"), "private content\n");
    execFileSync("jj", ["commit", "-m", "default private change"], { cwd: dir, timeout: 5000 });

    fs.writeFileSync(path.join(dir, "shared.txt"), "shared MODIFIED\n");
    fs.writeFileSync(path.join(dir, "private.txt"), "private MODIFIED\n");

    const jj = new ControlledJj(dir);
    const revset = await jj.getScopedAbsorbRevset();
    assertDefined(revset, "should have a scoped revset with two workspaces");

    const result = await jj.absorb(revset);
    assert.equal(result.changed, true, "private-stack edit should be absorbed");

    const remaining = await jj.getChangedFiles();
    assert.ok(
      remaining.includes("shared.txt"),
      "shared.txt edit should remain in working copy",
    );
    assert.ok(
      !remaining.includes("private.txt"),
      "private.txt edit should be absorbed into the private ancestor",
    );

    const ws2Status = execFileSync("jj", ["--color=never", "status"], {
      cwd: ws2Dir,
      encoding: "utf-8",
      timeout: 5000,
    });
    assert.ok(
      !ws2Status.toLowerCase().includes("stale"),
      "sibling workspace should not be stale after scoped absorb",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ws2Dir, { recursive: true, force: true });
  }
});
