import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { isJjRepo } from "./utils.ts";

test("returns true when directory contains .jj", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-repo-root-"));

  try {
    fs.mkdirSync(path.join(tempDir, ".jj"));
    assert.equal(isJjRepo(tempDir), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("returns true for nested directories when parent contains .jj", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-repo-nested-"));

  try {
    fs.mkdirSync(path.join(tempDir, ".jj"));
    const deepDir = path.join(tempDir, "sub", "deep");
    fs.mkdirSync(deepDir, { recursive: true });

    assert.equal(isJjRepo(deepDir), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("returns false when no .jj directory exists", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-repo-missing-"));

  try {
    assert.equal(isJjRepo(tempDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("returns false for a nonexistent path", () => {
  // randomUUID() uses a cryptographically secure source, making the path
  // unguessable and non-predictable within the same process.  path.join with
  // os.tmpdir() keeps the prefix platform-correct (e.g. /var/folders/… on
  // macOS instead of hardcoded /tmp).
  const nonExistentPath = path.join(os.tmpdir(), `nonexistent-${randomUUID()}`);

  assert.equal(isJjRepo(nonExistentPath), false);
});

test("returns true when .jj is a symlink to a directory", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-symlink-"));
  const real = path.join(tempDir, ".jj-real");
  fs.mkdirSync(real);
  fs.symlinkSync(real, path.join(tempDir, ".jj"));
  try {
    assert.equal(isJjRepo(tempDir), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("returns false when .jj is a dangling symlink", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-dangling-"));
  // Symlink points to a target that does not exist
  fs.symlinkSync(path.join(tempDir, ".jj-nonexistent"), path.join(tempDir, ".jj"));
  try {
    assert.equal(isJjRepo(tempDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("returns false without throwing when an intermediate directory is inaccessible", () => {
  // Root bypasses Unix permission checks, so the test would be meaningless there.
  if (process.getuid && process.getuid() === 0) return;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jj-noaccess-"));
  const subDir = path.join(tempDir, "sub");
  // Place a real .jj inside subDir, then make subDir itself inaccessible.
  fs.mkdirSync(path.join(subDir, ".jj"), { recursive: true });
  fs.chmodSync(subDir, 0o000);
  try {
    // Must not throw even though existsSync hits EACCES on subDir/.jj.
    assert.doesNotThrow(() => isJjRepo(subDir));
    assert.equal(isJjRepo(subDir), false);
  } finally {
    fs.chmodSync(subDir, 0o755); // restore access so rmSync can clean up
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
