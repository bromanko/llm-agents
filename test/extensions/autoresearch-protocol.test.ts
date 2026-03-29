import test from "node:test";
import assert from "node:assert/strict";

import { buildProtocol } from "../../pi/autoresearch/extensions/protocol.ts";

test("buildProtocol includes injected config values and critical invariants without a guard", () => {
  const protocol = buildProtocol({
    goal: "Increase coverage",
    scope: ["src/**/*.ts", "test/**/*.ts"],
    metric: "Coverage %",
    direction: "higher",
    verify: "npm test -- --coverage",
    maxIterations: undefined,
  });

  assert.match(protocol, /Your goal: \*\*Increase coverage\*\*/);
  assert.match(protocol, /\*\*Scope:\*\* src\/\*\*\/\*\.ts, test\/\*\*\/\*\.ts/);
  assert.match(protocol, /\*\*Metric:\*\* Coverage % \(higher is better\)/);
  assert.match(protocol, /\*\*Verify command:\*\* `npm test -- --coverage`/);
  assert.match(protocol, /This is an UNBOUNDED run/);
  assert.doesNotMatch(protocol, /## Guard \(Regression Check\)/);
  assert.match(protocol, /You MUST call the `autoresearch_log` tool after every iteration/);
  assert.match(protocol, /Your FIRST run must establish the baseline/);
  assert.match(protocol, /The extension automatically continues the loop after you log/);
  assert.match(protocol, /Do NOT ask the user if you should continue/);
});

test("buildProtocol includes guard instructions and bounded-run guidance when configured", () => {
  const protocol = buildProtocol({
    goal: "Reduce bundle size",
    scope: ["src/**/*.ts"],
    metric: "Bundle size KB",
    direction: "lower",
    verify: "npm run size",
    guard: "npm test",
    maxIterations: 7,
  });

  assert.match(protocol, /\*\*Guard command:\*\* `npm test`/);
  assert.match(protocol, /## Guard \(Regression Check\)/);
  assert.match(protocol, /After verifying the metric, run the guard command:/);
  assert.match(protocol, /Only run guard if the metric improved/);
  assert.match(protocol, /This is a BOUNDED run: 7 iterations/);
  assert.match(protocol, /IF metric improved AND guard passed/);
  assert.match(protocol, /ELIF metric improved AND guard failed:/);
  assert.match(protocol, /git revert HEAD --no-edit/);
  assert.match(protocol, /status: one of "baseline", "keep", "keep \(reworked\)", "discard", "crash", "no-op", "hook-blocked"/);
});
