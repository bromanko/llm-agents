import test from "node:test";
import assert from "node:assert/strict";

import { generateFallbackProposal } from "./fallback.ts";
import { SUMMARY_MAX_CHARS } from "./validation.ts";

test("generateFallbackProposal: uses singular grammar for two files", () => {
  const proposal = generateFallbackProposal(["src/a.ts", "src/b.ts"]);

  assert.ok(proposal.summary.includes("and 1 other"));
  assert.ok(!proposal.summary.includes("and 1 others"));
});

test("generateFallbackProposal: uses plural grammar for more than two files", () => {
  const proposal = generateFallbackProposal(["src/a.ts", "src/b.ts", "src/c.ts"]);

  assert.ok(proposal.summary.includes("and 2 others"));
});

test("generateFallbackProposal: summary stays within 72 chars for long single filename", () => {
  const longName = `${"very-long-file-name-".repeat(8)}component.ts`;
  const proposal = generateFallbackProposal([`src/${longName}`]);

  assert.ok(proposal.summary.startsWith("refactored "));
  assert.ok(proposal.summary.length <= SUMMARY_MAX_CHARS);
});

test("generateFallbackProposal: summary stays within 72 chars and preserves multi-file suffix", () => {
  const longName = `${"very-long-file-name-".repeat(8)}component.ts`;
  const proposal = generateFallbackProposal([`src/${longName}`, "src/other.ts"]);

  assert.ok(proposal.summary.length <= SUMMARY_MAX_CHARS);
  assert.ok(proposal.summary.includes(" and 1 other"));
});

test("generateFallbackProposal: details include at most first three basenames", () => {
  const proposal = generateFallbackProposal([
    "src/a.ts",
    "src/b.ts",
    "src/c.ts",
    "src/d.ts",
  ]);

  assert.deepStrictEqual(proposal.details.map((d) => d.text), [
    "Updated a.ts",
    "Updated b.ts",
    "Updated c.ts",
  ]);
});
