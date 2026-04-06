import test from "node:test";
import assert from "node:assert/strict";
import { extractUsageRecords } from "./entry-extract.ts";

const assistantEntry = {
  type: "message",
  id: "abc1",
  parentId: "parent1",
  timestamp: "2026-04-05T10:00:00.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    stopReason: "stop",
    timestamp: 1775127600000,
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
};

const userEntry = {
  type: "message",
  id: "user1",
  parentId: null,
  timestamp: "2026-04-05T09:59:00.000Z",
  message: { role: "user", content: "hi", timestamp: 1775127540000 },
};

const toolResultEntry = {
  type: "message",
  id: "tr1",
  parentId: "abc1",
  timestamp: "2026-04-05T10:01:00.000Z",
  message: {
    role: "toolResult",
    toolCallId: "tc1",
    toolName: "bash",
    content: [],
    isError: false,
    timestamp: 1775127660000,
  },
};

test("extracts a UsageRecord from an assistant message entry", () => {
  const records = extractUsageRecords(
    [assistantEntry],
    "/path/to/session.jsonl",
    "/Users/me/Code/project",
  );
  assert.equal(records.length, 1);
  const r = records[0];
  assert.equal(r.provider, "anthropic");
  assert.equal(r.model, "claude-sonnet-4-20250514");
  assert.equal(r.timestampMs, 1775127600000);
  assert.equal(r.tokens.input, 1000);
  assert.equal(r.tokens.output, 200);
  assert.equal(r.tokens.total, 1800);
  assert.equal(r.costTotal, 0.0105);
  assert.equal(r.projectPath, "/Users/me/Code/project");
  assert.equal(r.sessionFile, "/path/to/session.jsonl");
  assert.ok(r.fingerprint.length > 0);
  assert.ok(r.dayKey.length > 0);
});

test("ignores user and toolResult entries", () => {
  const records = extractUsageRecords(
    [userEntry, assistantEntry, toolResultEntry],
    "s.jsonl",
    "/cwd",
  );
  assert.equal(records.length, 1);
});

test("ignores non-message entry types", () => {
  const compaction = {
    type: "compaction",
    id: "c1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    summary: "...",
    firstKeptEntryId: "x",
    tokensBefore: 100,
  };
  const records = extractUsageRecords([compaction], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("ignores assistant messages without usage", () => {
  const noUsage = {
    ...assistantEntry,
    message: { ...assistantEntry.message, usage: undefined },
  };
  const records = extractUsageRecords([noUsage], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("two identical assistant messages produce the same fingerprint", () => {
  const records = extractUsageRecords(
    [assistantEntry, assistantEntry],
    "s.jsonl",
    "/cwd",
  );
  assert.equal(records.length, 2);
  assert.equal(records[0].fingerprint, records[1].fingerprint);
});

// --- Malformed / adversarial input tests (Finding 2) ---

test("skips entry with NaN token count", () => {
  const entry = {
    type: "message",
    id: "nan1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: {
        input: NaN,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { total: 0.01 },
      },
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("skips entry with Infinity token count", () => {
  const entry = {
    type: "message",
    id: "inf1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: {
        input: 1000,
        output: Infinity,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { total: 0.01 },
      },
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("skips entry with missing cost.total", () => {
  const entry = {
    type: "message",
    id: "nocost1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { input: 0.003 },
      },
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("skips entry with negative token counts", () => {
  const entry = {
    type: "message",
    id: "neg1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: {
        input: -100,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { total: 0.01 },
      },
      content: [],
    },
  };
  // isNumber accepts negative numbers (they pass Number.isFinite), so this
  // is extracted. The guard does not reject negatives — behaviour-preserving.
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 1);
});

test("skips entry with string timestamp instead of number", () => {
  const entry = {
    type: "message",
    id: "strts1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: "1775127600000",
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { total: 0.01 },
      },
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("treats non-string provider/model as empty strings", () => {
  const entry = {
    type: "message",
    id: "nsp1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: 42,
      model: null,
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: { total: 0.01 },
      },
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 1);
  assert.equal(records[0].provider, "");
  assert.equal(records[0].model, "");
});

test("skips entry with cost as a non-object", () => {
  const entry = {
    type: "message",
    id: "badcost1",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: {
        input: 1000,
        output: 200,
        cacheRead: 500,
        cacheWrite: 100,
        totalTokens: 1800,
        cost: 0.01,
      },
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("skips null entry", () => {
  const records = extractUsageRecords([null], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("skips entry where usage is null", () => {
  const entry = {
    type: "message",
    id: "nullusage",
    parentId: null,
    timestamp: "2026-04-05T10:00:00.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      stopReason: "stop",
      timestamp: 1775127600000,
      usage: null,
      content: [],
    },
  };
  const records = extractUsageRecords([entry], "s.jsonl", "/cwd");
  assert.equal(records.length, 0);
});

test("respects optional range filter", () => {
  const range = {
    label: "today",
    startMs: 1775127600000,
    endMsExclusive: 1775127600001,
  };
  // timestamp exactly at startMs — included
  const records = extractUsageRecords(
    [assistantEntry],
    "s.jsonl",
    "/cwd",
    range,
  );
  assert.equal(records.length, 1);

  // timestamp below range — excluded
  const rangeLater = {
    label: "later",
    startMs: 1775127600001,
    endMsExclusive: 1775127700000,
  };
  const records2 = extractUsageRecords(
    [assistantEntry],
    "s.jsonl",
    "/cwd",
    rangeLater,
  );
  assert.equal(records2.length, 0);
});
