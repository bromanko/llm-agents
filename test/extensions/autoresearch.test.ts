import test, { describe } from "node:test";
import assert from "node:assert/strict";

import { buildProtocol } from "../../pi/autoresearch/extensions/protocol.ts";
import {
  formatDelta,
  formatLoggedMetric,
  formatMetric,
  isBetter,
  parseInlineConfig,
} from "../../pi/autoresearch/extensions/utils.ts";
import type { IterationResult } from "../../pi/autoresearch/extensions/types.ts";

describe("autoresearch utils: parseInlineConfig", () => {
  test("parses complete inline config", () => {
    const config = parseInlineConfig([
      "Goal: Increase test coverage to 90%",
      "Scope: src/**/*.ts, test/**/*.ts",
      "Metric: coverage %",
      "Direction: higher",
      "Verify: npm test -- --coverage | grep 'All files' | awk '{print $4}'",
      "Guard: npm test",
      "Iterations: 25",
    ].join("\n"));

    assert.deepEqual(config, {
      goal: "Increase test coverage to 90%",
      scope: ["src/**/*.ts", "test/**/*.ts"],
      metric: "coverage %",
      direction: "higher",
      verify: "npm test -- --coverage | grep 'All files' | awk '{print $4}'",
      guard: "npm test",
      maxIterations: 25,
    });
  });

  test("returns null when required fields are missing or blank", () => {
    assert.equal(parseInlineConfig("Verify: npm test"), null);
    assert.equal(parseInlineConfig("Goal: do something"), null);
    assert.equal(parseInlineConfig("Goal:   \nVerify: npm test"), null);
    assert.equal(parseInlineConfig("Goal: Improve\nVerify:   "), null);
  });

  test("uses defaults and trims whitespace", () => {
    const config = parseInlineConfig([
      "  Goal: Improve things  ",
      "  Verify: npm test  ",
      "  Scope: src/**/*.ts,  test/**/*.ts  ,   ",
    ].join("\n"));

    if (!config) throw new Error("expected config to parse");
    assert.deepEqual(config.scope, ["src/**/*.ts", "test/**/*.ts"]);
    assert.equal(config.metric, "metric");
    assert.equal(config.direction, "higher");
    assert.equal(config.guard, undefined);
    assert.equal(config.maxIterations, undefined);
  });

  test("parses lower direction and ignores invalid iteration counts", () => {
    const lower = parseInlineConfig([
      "Goal: Reduce bundle",
      "Direction: lower",
      "Verify: npm run build | wc -c",
      "Iterations: 0",
    ].join("\n"));
    if (!lower) throw new Error("expected lower config to parse");
    assert.equal(lower.direction, "lower");
    assert.equal(lower.maxIterations, undefined);

    assert.equal(
      parseInlineConfig("Goal: Improve\nVerify: npm test\nIterations: -3")?.maxIterations,
      undefined,
    );
    assert.equal(
      parseInlineConfig("Goal: Improve\nVerify: npm test\nIterations: abc")?.maxIterations,
      undefined,
    );
  });
});

describe("autoresearch utils: formatting", () => {
  test("formatMetric formats zero and decimals", () => {
    assert.equal(formatMetric(0), "0");
    assert.equal(formatMetric(85.5), "85.500000");
    assert.equal(formatMetric(0.997), "0.997000");
  });

  test("formatDelta marks favorable movement by direction", () => {
    assert.equal(formatDelta(2.5, "higher"), "+2.500000 ✓");
    assert.equal(formatDelta(-1.5, "lower"), "-1.500000 ✓");
    assert.equal(formatDelta(-2.5, "higher"), "-2.500000");
    assert.equal(formatDelta(0, "higher"), "0.000000");
  });

  test("formatLoggedMetric suppresses crash deltas", () => {
    const kept: IterationResult = {
      iteration: 1,
      commit: "abcdef0",
      metric: 12,
      delta: 2,
      status: "keep",
      description: "kept",
    };
    const crashed: IterationResult = {
      iteration: 2,
      commit: "fedcba0",
      metric: 0,
      delta: -10,
      status: "crash",
      description: "boom",
    };

    assert.equal(formatLoggedMetric(kept, "higher"), "12.000000 (+2.000000 ✓)");
    assert.equal(formatLoggedMetric(crashed, "lower"), "crash");
  });
});

describe("autoresearch utils: isBetter", () => {
  test("higher is better: larger value wins", () => {
    assert.ok(isBetter(90, 85, "higher"));
    assert.ok(!isBetter(80, 85, "higher"));
    assert.ok(!isBetter(85, 85, "higher"));
  });

  test("lower is better: smaller value wins", () => {
    assert.ok(isBetter(80, 85, "lower"));
    assert.ok(!isBetter(90, 85, "lower"));
    assert.ok(!isBetter(85, 85, "lower"));
  });
});

describe("autoresearch: buildProtocol", () => {
  test("includes goal, scope, and loop invariants", () => {
    const protocol = buildProtocol({
      goal: "Increase test coverage to 90%",
      scope: ["src/**/*.ts"],
      metric: "coverage %",
      direction: "higher",
      verify: "npm test -- --coverage | grep 'All files' | awk '{print $4}'",
    });

    assert.ok(protocol.includes("Increase test coverage to 90%"));
    assert.ok(protocol.includes("src/**/*.ts"));
    assert.ok(protocol.includes("higher is better"));
    assert.ok(protocol.includes("npm test"));
    assert.ok(protocol.includes("autoresearch_log"));
    assert.ok(protocol.includes("UNBOUNDED"));
    assert.ok(protocol.includes("Phase 1: Review"));
    assert.ok(protocol.includes("Crash Recovery"));
  });

  test("includes bounded and guard variants", () => {
    const protocol = buildProtocol({
      goal: "test",
      scope: ["src/**/*"],
      metric: "metric",
      direction: "lower",
      verify: "echo 1",
      guard: "npm test",
      maxIterations: 10,
    });

    assert.ok(protocol.includes("BOUNDED"));
    assert.ok(protocol.includes("10"));
    assert.ok(protocol.includes("## Guard"));
    assert.ok(protocol.includes("npm test"));
  });
});
