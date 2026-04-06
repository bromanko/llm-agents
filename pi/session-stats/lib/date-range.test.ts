import test from "node:test";
import assert from "node:assert/strict";
import { resolveDateRange } from "./date-range.ts";

// Use a fixed "now" for deterministic tests: 2026-04-06 at 15:30 local time.
// Construct using local components so the test works in any timezone.
const now = new Date(2026, 3, 6, 15, 30, 0, 0); // month is 0-indexed

test("'today' resolves to start-of-day through start-of-next-day", () => {
  const range = resolveDateRange("today", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 3); // April
  assert.equal(start.getDate(), 6);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(end.getDate(), 7);
  assert.equal(end.getHours(), 0);
  assert.equal(range.label, "today");
});

test("'yesterday' resolves to previous day", () => {
  const range = resolveDateRange("yesterday", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  assert.equal(start.getDate(), 5);
  assert.equal(end.getDate(), 6);
  assert.equal(range.label, "yesterday");
});

test("'last 7 days' covers 7 calendar days ending at end of today", () => {
  const range = resolveDateRange("last 7 days", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  assert.equal(start.getMonth(), 2); // March
  assert.equal(start.getDate(), 31);
  assert.equal(start.getHours(), 0);
  assert.equal(end.getMonth(), 3); // April
  assert.equal(end.getDate(), 7);
  assert.equal(end.getHours(), 0);
});

test("'last 30 days' covers 30 calendar days ending at end of today", () => {
  const range = resolveDateRange("last 30 days", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  // Start is March 8 (April 7 minus 30 days)
  assert.equal(start.getMonth(), 2); // March
  assert.equal(start.getDate(), 8);
  assert.equal(start.getHours(), 0);
  assert.equal(end.getMonth(), 3); // April
  assert.equal(end.getDate(), 7);
  assert.equal(end.getHours(), 0);
});

test("'this week' starts on Monday of the current week", () => {
  const range = resolveDateRange("this week", now);
  const start = new Date(range.startMs);
  assert.equal(start.getDay(), 1); // Monday
  assert.equal(start.getHours(), 0);
});

test("'last week' covers the previous Monday-through-Sunday", () => {
  const range = resolveDateRange("last week", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  assert.equal(start.getDay(), 1); // Monday
  assert.equal(start.getHours(), 0);
  assert.equal(end.getDay(), 1); // Next Monday (exclusive)
  assert.equal(end.getHours(), 0);
  // Exactly 7 calendar days apart
  const startDate = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const diffDays = Math.round(
    (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  assert.equal(diffDays, 7);
});

test("'this month' starts on first of the month", () => {
  const range = resolveDateRange("this month", now);
  const start = new Date(range.startMs);
  assert.equal(start.getDate(), 1);
  assert.equal(start.getMonth(), 3); // April
});

test("'last month' covers the previous calendar month", () => {
  const range = resolveDateRange("last month", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  assert.equal(start.getMonth(), 2); // March
  assert.equal(start.getDate(), 1);
  assert.equal(end.getMonth(), 3); // April
  assert.equal(end.getDate(), 1);
});

test("'all time' uses very old start and far-future end", () => {
  const range = resolveDateRange("all time", now);
  assert.ok(range.startMs < new Date(2000, 0, 1).getTime());
  assert.ok(range.endMsExclusive > now.getTime());
  assert.equal(range.label, "all time");
});

test("explicit 'YYYY-MM-DD..YYYY-MM-DD' parses correctly", () => {
  const range = resolveDateRange("2026-04-01..2026-04-06", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 3);
  assert.equal(start.getDate(), 1);
  // End is exclusive: start of day after the end date
  assert.equal(end.getDate(), 7);
  assert.match(range.label, /2026-04-01/);
});

test("reversed explicit range throws", () => {
  assert.throws(
    () => resolveDateRange("2026-04-06..2026-04-01", now),
    /start date.*after.*end date/i,
  );
});

test("unknown range expression throws", () => {
  assert.throws(
    () => resolveDateRange("last fortnight", now),
    /unknown range/i,
  );
});

test("'last 1 day' works (singular)", () => {
  const range = resolveDateRange("last 1 day", now);
  const start = new Date(range.startMs);
  const end = new Date(range.endMsExclusive);
  // "last 1 day" means from start-of-today through end-of-today
  // (tomorrow minus 1 day = today, end = tomorrow)
  assert.equal(start.getMonth(), 3); // April
  assert.equal(start.getDate(), 6);
  assert.equal(end.getDate(), 7);
  assert.equal(range.label, "last 1 days");
});
