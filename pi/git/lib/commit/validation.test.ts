import test from "node:test";
import assert from "node:assert/strict";

import { validateSplitPlan } from "./validation.ts";
import type { CommitSnapshot, SplitCommitPlan } from "./types.ts";

const snapshot: CommitSnapshot = {
  stat: "",
  diff: "",
  files: [
    {
      path: "src/app.ts",
      kind: "modified",
      isBinary: false,
      patch: "",
      splitAllowed: true,
      hunks: [
        { index: 0, header: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: "@@ -1,1 +1,1 @@" },
        { index: 1, header: "@@ -5,1 +5,1 @@", oldStart: 5, oldLines: 1, newStart: 5, newLines: 1, content: "@@ -5,1 +5,1 @@" },
      ],
    },
    {
      path: "README.md",
      kind: "added",
      isBinary: false,
      patch: "",
      splitAllowed: false,
      hunks: [],
    },
  ],
};

test("validateSplitPlan: accepts complete hunk coverage with whole-file additions", () => {
  const plan: SplitCommitPlan = {
    warnings: [],
    commits: [
      {
        changes: [{ path: "src/app.ts", hunks: { type: "indices", indices: [1] } }],
        type: "fix",
        scope: "app",
        summary: "fixed first app hunk",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
      {
        changes: [
          { path: "src/app.ts", hunks: { type: "indices", indices: [2] } },
          { path: "README.md", hunks: { type: "all" } },
        ],
        type: "docs",
        scope: null,
        summary: "added release notes",
        details: [],
        issueRefs: [],
        dependencies: [0],
      },
    ],
  };

  const result = validateSplitPlan(plan, snapshot);
  assert.deepStrictEqual(result.errors, []);
});

test("validateSplitPlan: rejects overlapping or incomplete hunk coverage", () => {
  const plan: SplitCommitPlan = {
    warnings: [],
    commits: [
      {
        changes: [{ path: "src/app.ts", hunks: { type: "indices", indices: [1] } }],
        type: "fix",
        scope: "app",
        summary: "fixed first app hunk",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
      {
        changes: [{ path: "src/app.ts", hunks: { type: "indices", indices: [1] } }],
        type: "fix",
        scope: "app",
        summary: "fixed second app hunk",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
    ],
  };

  const result = validateSplitPlan(plan, snapshot);
  assert.ok(result.errors.some((error) => /appears in multiple commits/i.test(error)));
  assert.ok(result.errors.some((error) => /README.md/i.test(error)));
});
