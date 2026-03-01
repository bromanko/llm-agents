import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSummary,
  validateScope,
  validateTypeConsistency,
  validateSplitPlan,
  capDetails,
  detectDependencyCycle,
  computeDependencyOrder,
  SUMMARY_MAX_CHARS,
  MAX_DETAIL_ITEMS,
} from "./validation.ts";
import type { SplitCommitPlan, SplitCommitGroup, ConventionalDetail } from "./types.ts";

// ---------------------------------------------------------------------------
// validateSummary
// ---------------------------------------------------------------------------

test("validateSummary: accepts valid past-tense summary", () => {
  const result = validateSummary("added new commit pipeline");
  assert.equal(result.errors.length, 0);
});

test("validateSummary: rejects empty summary", () => {
  const result = validateSummary("");
  assert.ok(result.errors.some((e) => e.includes("empty")));
});

test("validateSummary: rejects summary exceeding max chars", () => {
  const long = "refactored " + "a".repeat(SUMMARY_MAX_CHARS);
  const result = validateSummary(long);
  assert.ok(result.errors.some((e) => e.includes("exceeds")));
});

test("validateSummary: rejects summary not starting with past-tense verb", () => {
  const result = validateSummary("add new feature for users");
  assert.ok(result.errors.some((e) => e.includes("past-tense")));
});

test("validateSummary: recognizes -ed suffix as past tense", () => {
  const result = validateSummary("implemented core module");
  assert.equal(result.errors.length, 0);
});

test("validateSummary: warns on filler words", () => {
  const result = validateSummary("added comprehensive test suite");
  assert.ok(result.warnings.some((w) => w.includes("comprehensive")));
});

test("validateSummary: warns on meta phrases", () => {
  const result = validateSummary("updated code in this commit to fix bug");
  assert.ok(result.warnings.some((w) => w.includes("this commit")));
});

test("validateSummary: warns on trailing period", () => {
  const result = validateSummary("fixed the bug.");
  assert.ok(result.warnings.some((w) => w.includes("period")));
});

// ---------------------------------------------------------------------------
// validateScope
// ---------------------------------------------------------------------------

test("validateScope: accepts null scope", () => {
  const result = validateScope(null);
  assert.equal(result.errors.length, 0);
});

test("validateScope: accepts empty string", () => {
  const result = validateScope("");
  assert.equal(result.errors.length, 0);
});

test("validateScope: accepts valid lowercase scope", () => {
  const result = validateScope("commit");
  assert.equal(result.errors.length, 0);
});

test("validateScope: accepts two-segment scope", () => {
  const result = validateScope("jj/commit");
  assert.equal(result.errors.length, 0);
});

test("validateScope: accepts scope with hyphens and underscores", () => {
  const result = validateScope("jj-commit_v2");
  assert.equal(result.errors.length, 0);
});

test("validateScope: rejects uppercase scope", () => {
  const result = validateScope("Commit");
  assert.ok(result.errors.length > 0);
});

test("validateScope: rejects scope with spaces", () => {
  const result = validateScope("jj commit");
  assert.ok(result.errors.length > 0);
});

// ---------------------------------------------------------------------------
// validateTypeConsistency
// ---------------------------------------------------------------------------

test("validateTypeConsistency: docs type requires doc files", () => {
  const result = validateTypeConsistency("docs", ["src/main.ts"]);
  assert.ok(result.errors.some((e) => e.includes("documentation")));
});

test("validateTypeConsistency: docs type passes with md files", () => {
  const result = validateTypeConsistency("docs", ["README.md"]);
  assert.equal(result.errors.length, 0);
});

test("validateTypeConsistency: test type requires test files", () => {
  const result = validateTypeConsistency("test", ["src/main.ts"]);
  assert.ok(result.errors.some((e) => e.includes("test")));
});

test("validateTypeConsistency: test type passes with test files", () => {
  const result = validateTypeConsistency("test", ["src/main.test.ts"]);
  assert.equal(result.errors.length, 0);
});

test("validateTypeConsistency: feat type always passes", () => {
  const result = validateTypeConsistency("feat", ["src/main.ts"]);
  assert.equal(result.errors.length, 0);
});

// ---------------------------------------------------------------------------
// capDetails
// ---------------------------------------------------------------------------

test("capDetails: keeps details under limit", () => {
  const details: ConventionalDetail[] = Array.from({ length: 4 }, (_, i) => ({
    text: `Detail ${i}`,
    userVisible: false,
  }));
  const result = capDetails(details);
  assert.equal(result.details.length, 4);
  assert.equal(result.warnings.length, 0);
});

test("capDetails: caps to MAX_DETAIL_ITEMS with priority scoring", () => {
  const details: ConventionalDetail[] = Array.from({ length: 10 }, (_, i) => ({
    text: `Generic detail ${i}`,
    userVisible: false,
  }));
  // Add a security detail to ensure it survives scoring
  details[7] = { text: "Fixed security vulnerability in auth", userVisible: true };

  const result = capDetails(details);
  assert.equal(result.details.length, MAX_DETAIL_ITEMS);
  assert.ok(result.warnings.some((w) => w.includes("Capped")));
  // The security detail should survive
  assert.ok(result.details.some((d) => d.text.includes("security")));
});

// ---------------------------------------------------------------------------
// validateSplitPlan
// ---------------------------------------------------------------------------

function makeSplitGroup(overrides: Partial<SplitCommitGroup>): SplitCommitGroup {
  return {
    files: [],
    type: "feat",
    scope: null,
    summary: "added feature",
    details: [],
    issueRefs: [],
    dependencies: [],
    ...overrides,
  };
}

test("validateSplitPlan: accepts valid plan covering all files", () => {
  const plan: SplitCommitPlan = {
    commits: [
      makeSplitGroup({ files: ["a.ts"], summary: "added module a" }),
      makeSplitGroup({ files: ["b.ts"], summary: "added module b" }),
    ],
    warnings: [],
    mode: "file",
  };
  const result = validateSplitPlan(plan, ["a.ts", "b.ts"]);
  assert.equal(result.errors.length, 0);
});

test("validateSplitPlan: detects missing files", () => {
  const plan: SplitCommitPlan = {
    commits: [makeSplitGroup({ files: ["a.ts"], summary: "added module a" })],
    warnings: [],
    mode: "file",
  };
  const result = validateSplitPlan(plan, ["a.ts", "b.ts"]);
  assert.ok(result.errors.some((e) => e.includes("b.ts")));
});

test("validateSplitPlan: detects duplicate files across commits", () => {
  const plan: SplitCommitPlan = {
    commits: [
      makeSplitGroup({ files: ["a.ts"], summary: "added module a" }),
      makeSplitGroup({ files: ["a.ts"], summary: "updated module a" }),
    ],
    warnings: [],
    mode: "file",
  };
  const result = validateSplitPlan(plan, ["a.ts"]);
  assert.ok(result.errors.some((e) => e.includes("multiple commits")));
});

test("validateSplitPlan: detects duplicate files within same commit", () => {
  const plan: SplitCommitPlan = {
    commits: [
      makeSplitGroup({ files: ["a.ts", "a.ts"], summary: "added module a" }),
    ],
    warnings: [],
    mode: "file",
  };
  const result = validateSplitPlan(plan, ["a.ts"]);
  assert.ok(result.errors.some((e) => e.includes("duplicate")));
});

test("validateSplitPlan: validates dependency indices", () => {
  const plan: SplitCommitPlan = {
    commits: [
      makeSplitGroup({ files: ["a.ts"], summary: "added module a", dependencies: [5] }),
    ],
    warnings: [],
    mode: "file",
  };
  const result = validateSplitPlan(plan, ["a.ts"]);
  assert.ok(result.errors.some((e) => e.includes("out of range")));
});

test("validateSplitPlan: detects self-dependency", () => {
  const plan: SplitCommitPlan = {
    commits: [
      makeSplitGroup({ files: ["a.ts"], summary: "added module a", dependencies: [0] }),
    ],
    warnings: [],
    mode: "file",
  };
  const result = validateSplitPlan(plan, ["a.ts"]);
  assert.ok(result.errors.some((e) => e.includes("depend on itself")));
});

// ---------------------------------------------------------------------------
// detectDependencyCycle
// ---------------------------------------------------------------------------

test("detectDependencyCycle: returns null for acyclic graph", () => {
  const groups: SplitCommitGroup[] = [
    makeSplitGroup({ files: ["a.ts"], dependencies: [] }),
    makeSplitGroup({ files: ["b.ts"], dependencies: [0] }),
  ];
  assert.equal(detectDependencyCycle(groups), null);
});

test("detectDependencyCycle: detects cycle", () => {
  const groups: SplitCommitGroup[] = [
    makeSplitGroup({ files: ["a.ts"], dependencies: [1] }),
    makeSplitGroup({ files: ["b.ts"], dependencies: [0] }),
  ];
  const result = detectDependencyCycle(groups);
  assert.ok(result !== null);
  assert.ok(result.includes("Circular dependency"));
});

// ---------------------------------------------------------------------------
// computeDependencyOrder
// ---------------------------------------------------------------------------

test("computeDependencyOrder: returns correct order", () => {
  const groups: SplitCommitGroup[] = [
    makeSplitGroup({ files: ["a.ts"], dependencies: [1] }),
    makeSplitGroup({ files: ["b.ts"], dependencies: [] }),
  ];
  const result = computeDependencyOrder(groups);
  assert.ok(Array.isArray(result));
  const order = result as number[];
  assert.deepStrictEqual(order, [1, 0]);
});

test("computeDependencyOrder: returns error on cycle", () => {
  const groups: SplitCommitGroup[] = [
    makeSplitGroup({ files: ["a.ts"], dependencies: [1] }),
    makeSplitGroup({ files: ["b.ts"], dependencies: [0] }),
  ];
  const result = computeDependencyOrder(groups);
  assert.ok(!Array.isArray(result));
  assert.ok((result as { error: string }).error.includes("Circular"));
});

test("computeDependencyOrder: handles independent commits", () => {
  const groups: SplitCommitGroup[] = [
    makeSplitGroup({ files: ["a.ts"], dependencies: [] }),
    makeSplitGroup({ files: ["b.ts"], dependencies: [] }),
    makeSplitGroup({ files: ["c.ts"], dependencies: [] }),
  ];
  const result = computeDependencyOrder(groups);
  assert.ok(Array.isArray(result));
  assert.equal((result as number[]).length, 3);
});
