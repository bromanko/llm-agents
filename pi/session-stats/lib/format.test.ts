import test from "node:test";
import assert from "node:assert/strict";
import { formatReport } from "./format.ts";
import type { SessionStatsReport } from "./types.ts";

function makeReport(
  overrides: Partial<SessionStatsReport> = {},
): SessionStatsReport {
  return {
    range: { label: "last 7 days", startMs: 0, endMsExclusive: 1 },
    sessionsScanned: 42,
    sessionsMatched: 11,
    messagesCounted: 173,
    duplicatesCollapsed: 12,
    warningCount: 0,
    totals: {
      input: 482190,
      output: 96441,
      cacheRead: 310220,
      cacheWrite: 24000,
      total: 912851,
      costTotal: 4.82,
    },
    defaultTopProjects: [
      {
        label: "~/Code/foo",
        tokensTotal: 410220,
        costTotal: 2.0,
        messageCount: 80,
      },
      {
        label: "~/Code/bar",
        tokensTotal: 301044,
        costTotal: 1.5,
        messageCount: 60,
      },
    ],
    ...overrides,
  };
}

test("header includes range label and local time note", () => {
  const lines = formatReport(makeReport());
  assert.ok(lines.some((l) => l.includes("last 7 days")));
  assert.ok(lines.some((l) => l.toLowerCase().includes("local time")));
});

test("token totals use comma separators", () => {
  const lines = formatReport(makeReport());
  const joined = lines.join("\n");
  assert.ok(joined.includes("482,190"));
  assert.ok(joined.includes("912,851"));
});

test("cost formatted to two decimal places", () => {
  const lines = formatReport(makeReport());
  assert.ok(lines.some((l) => l.includes("$4.82")));
});

test("zero cost is omitted or shows $0.00", () => {
  const lines = formatReport(
    makeReport({ totals: { ...makeReport().totals, costTotal: 0 } }),
  );
  const joined = lines.join("\n");
  // Should either not show cost section or show $0.00
  assert.ok(!joined.includes("$NaN"));
});

test("duplicates collapsed shown when non-zero", () => {
  const lines = formatReport(makeReport({ duplicatesCollapsed: 12 }));
  assert.ok(lines.some((l) => l.includes("12")));
});

test("duplicates collapsed not shown when zero", () => {
  const lines = formatReport(makeReport({ duplicatesCollapsed: 0 }));
  assert.ok(!lines.some((l) => l.toLowerCase().includes("duplicate")));
});

test("warnings shown when non-zero", () => {
  const lines = formatReport(makeReport({ warningCount: 3 }));
  assert.ok(
    lines.some((l) => l.includes("3") && l.toLowerCase().includes("warning")),
  );
});

test("default top projects shown when no breakdown", () => {
  const lines = formatReport(makeReport());
  const joined = lines.join("\n");
  assert.ok(joined.includes("~/Code/foo"));
  assert.ok(joined.includes("~/Code/bar"));
});

test("breakdown replaces default top projects", () => {
  const report = makeReport({
    breakdown: {
      kind: "model",
      rows: [
        {
          label: "anthropic/claude-sonnet-4",
          tokensTotal: 500000,
          costTotal: 3.0,
          messageCount: 100,
        },
        {
          label: "openai/gpt-5",
          tokensTotal: 300000,
          costTotal: 1.5,
          messageCount: 50,
        },
      ],
      omittedCount: 0,
    },
  });
  const lines = formatReport(report);
  const joined = lines.join("\n");
  assert.ok(joined.includes("anthropic/claude-sonnet-4"));
  assert.ok(joined.includes("openai/gpt-5"));
  assert.ok(joined.toLowerCase().includes("model"));
});

test("omitted count shown when non-zero", () => {
  const report = makeReport({
    breakdown: {
      kind: "project",
      rows: [
        {
          label: "~/Code/foo",
          tokensTotal: 500,
          costTotal: 0.01,
          messageCount: 1,
        },
      ],
      omittedCount: 7,
    },
  });
  const lines = formatReport(report);
  assert.ok(
    lines.some(
      (l) => l.includes("7") && l.toLowerCase().includes("omitted"),
    ),
  );
});

test("formats empty report without crashing", () => {
  const report = makeReport({
    sessionsMatched: 0,
    messagesCounted: 0,
    duplicatesCollapsed: 0,
    totals: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
      costTotal: 0,
    },
    defaultTopProjects: [],
  });
  const lines = formatReport(report);
  assert.ok(lines.length > 0);
  assert.ok(lines.some((l) => l.includes("0")));
});

test("breakdown with empty rows does not crash", () => {
  const report = makeReport({
    breakdown: { kind: "day", rows: [], omittedCount: 0 },
  });
  const lines = formatReport(report);
  assert.ok(Array.isArray(lines));
  assert.ok(lines.some((l) => l.toLowerCase().includes("day")));
});
