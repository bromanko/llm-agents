import test from "node:test";
import assert from "node:assert/strict";
import { parseCommandArgs } from "./command-args.ts";

test("empty args defaults to last 7 days with no breakdown", () => {
  const result = parseCommandArgs("");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "last 7 days",
    breakdown: undefined,
  });
});

test("--help returns help: true", () => {
  const result = parseCommandArgs("--help");
  assert.equal(result.help, true);
});

test("help returns help: true", () => {
  const result = parseCommandArgs("help");
  assert.equal(result.help, true);
});

test("parses 'last 7 days by project'", () => {
  const result = parseCommandArgs("last 7 days by project");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "last 7 days",
    breakdown: "project",
  });
});

test("parses 'this month by day'", () => {
  const result = parseCommandArgs("this month by day");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "this month",
    breakdown: "day",
  });
});

test("parses 'all time by model'", () => {
  const result = parseCommandArgs("all time by model");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "all time",
    breakdown: "model",
  });
});

test("parses 'all time' without breakdown", () => {
  const result = parseCommandArgs("all time");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "all time",
    breakdown: undefined,
  });
});

test("parses explicit date range", () => {
  const result = parseCommandArgs("2026-04-01..2026-04-06");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "2026-04-01..2026-04-06",
    breakdown: undefined,
  });
});

test("parses explicit date range with breakdown", () => {
  const result = parseCommandArgs("2026-04-01..2026-04-06 by day");
  assert.deepStrictEqual(result, {
    help: false,
    rangeExpression: "2026-04-01..2026-04-06",
    breakdown: "day",
  });
});

test("invalid breakdown returns error", () => {
  assert.throws(
    () => parseCommandArgs("today by provider"),
    /unknown breakdown/i,
  );
});

test("handles leading/trailing whitespace", () => {
  const result = parseCommandArgs("  today  ");
  assert.equal(result.rangeExpression, "today");
});

test("handles mixed case breakdown", () => {
  const result = parseCommandArgs("today BY Day");
  assert.equal(result.breakdown, "day");
  assert.equal(result.rangeExpression, "today");
});

test("handles extra whitespace around breakdown", () => {
  const result = parseCommandArgs("  last 7 days   by   project  ");
  assert.equal(result.rangeExpression, "last 7 days");
  assert.equal(result.breakdown, "project");
});
