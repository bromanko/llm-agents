import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  executeEnhancedTextRead,
  normalizeReadRequest,
  resolveReadPathLikePi,
} from "./enhanced-read.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "enhanced-read-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

test("normalizeReadRequest translates offset plus endLine into inclusive limit", () => {
  const result = normalizeReadRequest({ path: "README.md", offset: 10, endLine: 20 }, 200);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 10,
    limit: 11,
    rangeLabel: "lines 10-20",
  });
});

test("normalizeReadRequest defaults endLine reads to offset 1", () => {
  const result = normalizeReadRequest({ path: "README.md", endLine: 5 }, 200);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 1,
    limit: 5,
    rangeLabel: "lines 1-5",
  });
});

test("normalizeReadRequest converts tail into the last N lines", () => {
  const result = normalizeReadRequest({ path: "README.md", tail: 3 }, 10);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 8,
    limit: 3,
    rangeLabel: "last 3 lines",
  });
});

test("normalizeReadRequest clamps tail to the file length", () => {
  const result = normalizeReadRequest({ path: "README.md", tail: 20 }, 10);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 1,
    limit: 10,
    rangeLabel: "last 10 lines",
  });
});

test("normalizeReadRequest centers reads around aroundLine", () => {
  const result = normalizeReadRequest({ path: "README.md", aroundLine: 50, context: 3 }, 100);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 47,
    limit: 7,
    rangeLabel: "lines 47-53",
  });
});

test("normalizeReadRequest clamps aroundLine windows at the start of the file", () => {
  const result = normalizeReadRequest({ path: "README.md", aroundLine: 2, context: 5 }, 100);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 1,
    limit: 7,
    rangeLabel: "lines 1-7",
  });
});

test("normalizeReadRequest clamps aroundLine windows at the end of the file", () => {
  const result = normalizeReadRequest({ path: "README.md", aroundLine: 99, context: 3 }, 100);
  assert.deepEqual(result, {
    path: "README.md",
    offset: 96,
    limit: 5,
    rangeLabel: "lines 96-100",
  });
});

test("normalizeReadRequest rejects context without aroundLine", () => {
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", context: 3 }, 100),
    /context requires aroundLine/,
  );
});

test("normalizeReadRequest rejects tail with offset, limit, or endLine", () => {
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", tail: 2, offset: 1 }, 100),
    /tail cannot be combined/,
  );
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", tail: 2, limit: 1 }, 100),
    /tail cannot be combined/,
  );
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", tail: 2, endLine: 3 }, 100),
    /tail cannot be combined/,
  );
});

test("normalizeReadRequest rejects aroundLine with offset, limit, endLine, or tail", () => {
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", aroundLine: 2, context: 1, offset: 1 }, 100),
    /aroundLine cannot be combined/,
  );
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", aroundLine: 2, context: 1, limit: 1 }, 100),
    /aroundLine cannot be combined/,
  );
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", aroundLine: 2, context: 1, endLine: 3 }, 100),
    /aroundLine cannot be combined/,
  );
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", aroundLine: 2, context: 1, tail: 1 }, 100),
    /aroundLine cannot be combined/,
  );
});

test("normalizeReadRequest rejects limit with endLine", () => {
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", limit: 3, endLine: 4 }, 100),
    /limit cannot be combined with endLine/,
  );
});

test("normalizeReadRequest rejects endLine values smaller than offset", () => {
  assert.throws(
    () => normalizeReadRequest({ path: "README.md", offset: 10, endLine: 9 }, 100),
    /endLine must be greater than or equal to offset/,
  );
});

test("normalizeReadRequest rejects non-positive or non-integer numeric arguments", () => {
  assert.throws(() => normalizeReadRequest({ path: "README.md", offset: 0 }, 100), /offset must be a positive integer/);
  assert.throws(() => normalizeReadRequest({ path: "README.md", limit: 1.5 }, 100), /limit must be a positive integer/);
  assert.throws(() => normalizeReadRequest({ path: "README.md", endLine: -1 }, 100), /endLine must be a positive integer/);
  assert.throws(() => normalizeReadRequest({ path: "README.md", tail: 0 }, 100), /tail must be a positive integer/);
  assert.throws(() => normalizeReadRequest({ path: "README.md", aroundLine: 2.2 }, 100), /aroundLine must be a positive integer/);
  assert.throws(() => normalizeReadRequest({ path: "README.md", aroundLine: 2, context: -1 }, 100), /context must be a positive integer/);
});

test("resolveReadPathLikePi expands home-relative paths", () => {
  const resolved = resolveReadPathLikePi("~/file.txt", process.cwd());
  assert.equal(resolved, join(process.env.HOME ?? "", "file.txt"));
});

test("resolveReadPathLikePi strips a leading @ for relative paths", () => {
  const cwd = "/tmp/read-cwd";
  assert.equal(resolveReadPathLikePi("@relative/file.txt", cwd), join(cwd, "relative/file.txt"));
});

test("resolveReadPathLikePi resolves plain relative paths against cwd", () => {
  const cwd = "/tmp/read-cwd";
  assert.equal(resolveReadPathLikePi("relative/file.txt", cwd), join(cwd, "relative/file.txt"));
});

test("resolveReadPathLikePi returns an NFD-variant path on macOS when the direct path is missing", { skip: process.platform !== "darwin" }, () => {
  const tempDir = makeTempDir();
  try {
    const composedName = "café.txt";
    const decomposedName = "cafe\u0301.txt";
    const composedPath = join(tempDir, composedName);
    writeFileSync(composedPath, "hello", "utf8");

    const resolved = resolveReadPathLikePi(decomposedName, tempDir);
    assert.equal(resolved, composedPath.normalize("NFD"));
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead returns a structured offset-beyond-EOF error", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), makeLines(3), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt", offset: 10 });
    assert.equal(getText(result), "Offset 10 is beyond end of file (3 lines total)");
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead appends a built-in style user-limit continuation notice", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), makeLines(10), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt", offset: 2, limit: 3 });
    assert.equal(
      getText(result),
      "line 2\nline 3\nline 4\n\n[6 more lines in file. Use offset=5 to continue.]",
    );
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead truncates by line limit with a continuation notice", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), makeLines(DEFAULT_MAX_LINES + 5), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt" });
    const text = getText(result);
    assert.match(text, /\[Showing lines 1-2000 of 2005\. Use offset=2001 to continue\.\]$/);
    assert.equal(result.details?.truncation?.truncatedBy, "lines");
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead truncates by byte limit with a continuation notice", async () => {
  const tempDir = makeTempDir();
  try {
    const longLine = "x".repeat(600);
    writeFileSync(join(tempDir, "sample.txt"), Array.from({ length: 100 }, () => longLine).join("\n"), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt" });
    const text = getText(result);
    assert.match(text, /50\.0KB limit/);
    assert.equal(result.details?.truncation?.truncatedBy, "bytes");
    assert.ok((result.details?.truncation?.outputLines ?? 100) < 100);
    assert.ok((result.details?.truncation?.outputBytes ?? 0) <= DEFAULT_MAX_BYTES);
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead returns a structured file-not-found error", async () => {
  const result = await executeEnhancedTextRead(process.cwd(), { path: "definitely-missing-file.txt" });
  assert.match(getText(result), /File not found: definitely-missing-file\.txt/);
});

test("executeEnhancedTextRead returns a structured directory error", async () => {
  const tempDir = makeTempDir();
  try {
    const result = await executeEnhancedTextRead(tempDir, { path: "." });
    assert.match(getText(result), /path is a directory/);
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead returns a structured permission error", { skip: process.platform === "win32" }, async () => {
  const tempDir = makeTempDir();
  const filePath = join(tempDir, "private.txt");
  try {
    writeFileSync(filePath, "secret", "utf8");
    chmodSync(filePath, 0o000);
    const result = await executeEnhancedTextRead(tempDir, { path: "private.txt" });
    assert.match(getText(result), /Permission denied: private\.txt/);
  } finally {
    chmodSync(filePath, 0o644);
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead supports endLine targeting", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), makeLines(6), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt", offset: 2, endLine: 4 });
    assert.equal(
      getText(result),
      "line 2\nline 3\nline 4\n\n[2 more lines in file. Use offset=5 to continue.]",
    );
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead supports tail targeting", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), makeLines(6), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt", tail: 3 });
    assert.equal(getText(result), "line 4\nline 5\nline 6");
  } finally {
    cleanup(tempDir);
  }
});

test("executeEnhancedTextRead supports aroundLine targeting", async () => {
  const tempDir = makeTempDir();
  try {
    writeFileSync(join(tempDir, "sample.txt"), makeLines(10), "utf8");
    const result = await executeEnhancedTextRead(tempDir, { path: "sample.txt", aroundLine: 5, context: 1 });
    assert.equal(
      getText(result),
      "line 4\nline 5\nline 6\n\n[4 more lines in file. Use offset=7 to continue.]",
    );
  } finally {
    cleanup(tempDir);
  }
});
