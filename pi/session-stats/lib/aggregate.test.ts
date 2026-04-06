import test from "node:test";
import assert from "node:assert/strict";
import { aggregateUsage } from "./aggregate.ts";
import type { UsageRecord, ResolvedDateRange } from "./types.ts";

let fpCounter = 0;
function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    fingerprint: `fp-${++fpCounter}`,
    sessionFile: "session-a.jsonl",
    projectPath: "/Users/me/Code/foo",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    timestampMs: new Date(2026, 3, 5, 12, 0).getTime(),
    dayKey: "2026-04-05",
    tokens: {
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 100,
      total: 1800,
    },
    costTotal: 0.01,
    ...overrides,
  };
}

const rangeAllApril: ResolvedDateRange = {
  label: "this month",
  startMs: new Date(2026, 3, 1).getTime(),
  endMsExclusive: new Date(2026, 4, 1).getTime(),
};

test("single record inside range is counted", () => {
  const records = [makeRecord()];
  const report = aggregateUsage(records, rangeAllApril, 1);
  assert.equal(report.messagesCounted, 1);
  assert.equal(report.totals.input, 1000);
  assert.equal(report.totals.output, 200);
  assert.equal(report.totals.total, 1800);
  assert.equal(report.totals.costTotal, 0.01);
  assert.equal(report.sessionsScanned, 1);
  assert.equal(report.sessionsMatched, 1);
});

test("records outside range are excluded", () => {
  const outOfRange = makeRecord({
    timestampMs: new Date(2026, 2, 15, 12, 0).getTime(), // March
  });
  const report = aggregateUsage([outOfRange], rangeAllApril, 1);
  assert.equal(report.messagesCounted, 0);
  assert.equal(report.totals.total, 0);
});

test("duplicate fingerprints are collapsed", () => {
  const r1 = makeRecord({ fingerprint: "same-fp", sessionFile: "s1.jsonl" });
  const r2 = makeRecord({ fingerprint: "same-fp", sessionFile: "s2.jsonl" });
  const report = aggregateUsage([r1, r2], rangeAllApril, 2);
  assert.equal(report.messagesCounted, 1);
  assert.equal(report.duplicatesCollapsed, 1);
  assert.equal(report.totals.total, 1800); // counted once, not doubled
});

test("breakdown by project groups correctly", () => {
  const r1 = makeRecord({ projectPath: "/Code/foo" });
  const r2 = makeRecord({
    projectPath: "/Code/bar",
    fingerprint: "fp-other",
  });
  const report = aggregateUsage([r1, r2], rangeAllApril, 2, "project");
  assert.ok(report.breakdown);
  assert.equal(report.breakdown!.kind, "project");
  assert.equal(report.breakdown!.rows.length, 2);
  // sorted by descending total tokens
  assert.equal(report.breakdown!.rows[0].tokensTotal, 1800);
});

test("breakdown by model groups by provider/model", () => {
  const r1 = makeRecord({ provider: "anthropic", model: "claude-sonnet-4" });
  const r2 = makeRecord({
    provider: "openai",
    model: "gpt-5",
    fingerprint: "fp2",
  });
  const report = aggregateUsage([r1, r2], rangeAllApril, 2, "model");
  assert.ok(report.breakdown);
  const labels = report.breakdown!.rows.map((r) => r.label);
  assert.ok(labels.includes("anthropic/claude-sonnet-4"));
  assert.ok(labels.includes("openai/gpt-5"));
});

test("breakdown by day uses dayKey", () => {
  const r1 = makeRecord({ dayKey: "2026-04-05" });
  const r2 = makeRecord({ dayKey: "2026-04-06", fingerprint: "fp2" });
  const report = aggregateUsage([r1, r2], rangeAllApril, 1, "day");
  assert.ok(report.breakdown);
  assert.equal(report.breakdown!.rows.length, 2);
});

test("defaultTopProjects are populated without explicit breakdown", () => {
  const r1 = makeRecord({ projectPath: "/Code/foo" });
  const r2 = makeRecord({ projectPath: "/Code/bar", fingerprint: "fp2" });
  const report = aggregateUsage([r1, r2], rangeAllApril, 2);
  assert.equal(report.breakdown, undefined);
  assert.ok(report.defaultTopProjects.length > 0);
});

test("sessionsScanned reflects the count passed in", () => {
  const report = aggregateUsage([], rangeAllApril, 42);
  assert.equal(report.sessionsScanned, 42);
  assert.equal(report.sessionsMatched, 0);
});

test("record at exact start boundary is included", () => {
  const r = makeRecord({ timestampMs: rangeAllApril.startMs });
  const report = aggregateUsage([r], rangeAllApril, 1);
  assert.equal(report.messagesCounted, 1);
});

test("record at exact end boundary is excluded", () => {
  const r = makeRecord({ timestampMs: rangeAllApril.endMsExclusive });
  const report = aggregateUsage([r], rangeAllApril, 1);
  assert.equal(report.messagesCounted, 0);
});
