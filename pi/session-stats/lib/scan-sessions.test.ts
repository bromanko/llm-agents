import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { scanSessionFiles } from "./scan-sessions.ts";

const SESSION_HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "test-id-1",
  timestamp: "2026-04-05T10:00:00.000Z",
  cwd: "/Users/me/Code/project-a",
});

const ASSISTANT_ENTRY = JSON.stringify({
  type: "message",
  id: "a1",
  parentId: null,
  timestamp: "2026-04-05T10:01:00.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    stopReason: "stop",
    timestamp: 1775127660000,
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 100,
      totalTokens: 1800,
      cost: {
        input: 0.003,
        output: 0.006,
        cacheRead: 0.001,
        cacheWrite: 0.0005,
        total: 0.0105,
      },
    },
    content: [{ type: "text", text: "Hello" }],
  },
});

const USER_ENTRY = JSON.stringify({
  type: "message",
  id: "u1",
  parentId: null,
  timestamp: "2026-04-05T09:59:00.000Z",
  message: { role: "user", content: "hi", timestamp: 1775127540000 },
});

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "session-stats-test-"));
}

function cleanTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeSession(
  root: string,
  subdir: string,
  filename: string,
  lines: string[],
): string {
  const dir = path.join(root, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  return filePath;
}

test("discovers and parses a single session file", async () => {
  const sessionsRoot = makeTmpDir();
  try {
    writeSession(
      sessionsRoot,
      "--Users--me--Code--project-a--",
      "session1.jsonl",
      [SESSION_HEADER, USER_ENTRY, ASSISTANT_ENTRY],
    );
    const result = await scanSessionFiles(sessionsRoot);
    assert.equal(result.filesScanned, 1);
    assert.equal(result.warningCount, 0);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].provider, "anthropic");
    assert.equal(result.records[0].projectPath, "/Users/me/Code/project-a");
  } finally {
    cleanTmpDir(sessionsRoot);
  }
});

test("discovers sessions across multiple project directories", async () => {
  const sessionsRoot = makeTmpDir();
  try {
    writeSession(
      sessionsRoot,
      "--Users--me--Code--project-a--",
      "session1.jsonl",
      [SESSION_HEADER, USER_ENTRY, ASSISTANT_ENTRY],
    );
    const header2 = JSON.stringify({
      type: "session",
      version: 3,
      id: "test-id-2",
      timestamp: "2026-04-05T11:00:00.000Z",
      cwd: "/Users/me/Code/project-b",
    });
    writeSession(
      sessionsRoot,
      "--Users--me--Code--project-b--",
      "session2.jsonl",
      [header2, ASSISTANT_ENTRY],
    );
    const result = await scanSessionFiles(sessionsRoot);
    const projects = new Set(result.records.map((r) => r.projectPath));
    assert.ok(projects.has("/Users/me/Code/project-a"));
    assert.ok(projects.has("/Users/me/Code/project-b"));
  } finally {
    cleanTmpDir(sessionsRoot);
  }
});

test("counts warnings for files that fail to parse", async () => {
  const sessionsRoot = makeTmpDir();
  try {
    writeSession(sessionsRoot, "--bad-project--", "bad.jsonl", [
      "not valid json at all",
    ]);
    const result = await scanSessionFiles(sessionsRoot);
    assert.ok(result.warningCount >= 1);
  } finally {
    cleanTmpDir(sessionsRoot);
  }
});

test("skips non-jsonl files", async () => {
  const sessionsRoot = makeTmpDir();
  try {
    const dir = path.join(sessionsRoot, "--other--");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "readme.txt"), "not a session");
    // Also write a valid session so there are some records
    writeSession(
      sessionsRoot,
      "--Users--me--Code--project-a--",
      "session1.jsonl",
      [SESSION_HEADER, USER_ENTRY, ASSISTANT_ENTRY],
    );
    const result = await scanSessionFiles(sessionsRoot);
    // readme.txt should not be counted in filesScanned
    assert.ok(!result.records.some((r) => r.sessionFile.endsWith(".txt")));
  } finally {
    cleanTmpDir(sessionsRoot);
  }
});

test("returns empty result for missing sessions root", async () => {
  const result = await scanSessionFiles(
    "/nonexistent/path/that/does/not/exist",
  );
  assert.equal(result.filesScanned, 0);
  assert.equal(result.records.length, 0);
  assert.equal(result.warningCount, 0);
});

test("calls onProgress with scanned and total counts", async () => {
  const sessionsRoot = makeTmpDir();
  try {
    writeSession(
      sessionsRoot,
      "--proj--",
      "s1.jsonl",
      [SESSION_HEADER, ASSISTANT_ENTRY],
    );
    writeSession(sessionsRoot, "--proj--", "s2.jsonl", [
      SESSION_HEADER,
      ASSISTANT_ENTRY,
    ]);
    const progress: Array<[number, number]> = [];
    await scanSessionFiles(sessionsRoot, (scanned, total) => {
      progress.push([scanned, total]);
    });
    assert.ok(progress.length > 0);
    // Last progress call should have scanned === total
    const last = progress[progress.length - 1];
    assert.equal(last[0], last[1]);
  } finally {
    cleanTmpDir(sessionsRoot);
  }
});
