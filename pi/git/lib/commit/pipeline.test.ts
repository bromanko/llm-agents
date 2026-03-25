import test from "node:test";
import assert from "node:assert/strict";

import { runCommitPipeline } from "./pipeline.ts";
import type { CommitSnapshot } from "./types.ts";

const snapshot: CommitSnapshot = {
  stat: " 1 file changed, 1 insertion(+)",
  diff: "diff --git a/src/app.ts b/src/app.ts",
  files: [
    {
      path: "src/app.ts",
      kind: "modified",
      isBinary: false,
      patch: "diff --git a/src/app.ts b/src/app.ts",
      hunks: [
        {
          index: 0,
          header: "@@ -1,1 +1,1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          content: "@@ -1,1 +1,1 @@",
        },
      ],
      splitAllowed: true,
    },
  ],
};

test("runCommitPipeline: includes debug path when model response cannot be parsed", async () => {
  const result = await runCommitPipeline({
    git: {} as any,
    cwd: "/tmp/repo",
    args: { dryRun: true, push: false },
    snapshot,
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-6-test", name: "Claude Sonnet 4.6" },
    ],
    sessionModel: undefined,
    hasApiKey: async () => true,
    runAgenticSession: async () => ({
      debugPath: "/tmp/pi-git-commit-debug/failed-response-test.txt",
    }),
  });

  assert.equal(result.committed, false);
  assert.ok(
    result.warnings.some((warning) =>
      warning.includes("Model response could not be converted into a valid commit plan.")
      && warning.includes("/tmp/pi-git-commit-debug/failed-response-test.txt")
    ),
  );
});

test("runCommitPipeline: retries with the session model when the primary model yields no plan", async () => {
  const attemptedModels: string[] = [];

  const result = await runCommitPipeline({
    git: {} as any,
    cwd: "/tmp/repo",
    args: { dryRun: true, push: false },
    snapshot,
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-6-test", name: "Claude Sonnet 4.6" },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    ],
    sessionModel: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    hasApiKey: async () => true,
    runAgenticSession: async ({ model }) => {
      attemptedModels.push(`${model.provider}/${model.id}`);
      if (model.provider === "anthropic") {
        return { debugPath: "/tmp/primary-debug.txt" };
      }
      return {
        proposal: {
          type: "fix",
          scope: "git",
          summary: "fixed commit fallback handling",
          details: [],
          issueRefs: [],
          warnings: [],
        },
      };
    },
  });

  assert.deepStrictEqual(attemptedModels, [
    "anthropic/claude-sonnet-4-6-test",
    "openai/gpt-4o",
  ]);
  assert.match(result.summary, /Generated commit message:/);
  assert.ok(
    result.warnings.some((warning) => warning.includes("retrying with session model openai/gpt-4o")),
  );
});

test("runCommitPipeline: skips incompatible session model during retry", async () => {
  const attemptedModels: string[] = [];

  const result = await runCommitPipeline({
    git: {} as any,
    cwd: "/tmp/repo",
    args: { dryRun: true, push: false },
    snapshot,
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-6-test", name: "Claude Sonnet 4.6" },
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
    ],
    sessionModel: { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
    hasApiKey: async () => true,
    runAgenticSession: async ({ model }) => {
      attemptedModels.push(`${model.provider}/${model.id}`);
      return { debugPath: "/tmp/primary-debug.txt" };
    },
  });

  // Should only attempt the primary (anthropic), not retry with openai-codex
  assert.deepStrictEqual(attemptedModels, [
    "anthropic/claude-sonnet-4-6-test",
  ]);
  assert.equal(result.committed, false);
  assert.ok(result.summary.includes("No commit proposal"));
});

test("runCommitPipeline: reports config guidance when no model is available", async () => {
  const result = await runCommitPipeline({
    git: {} as any,
    cwd: "/tmp/repo",
    args: { dryRun: true, push: false },
    snapshot,
    availableModels: [],
    sessionModel: undefined,
    hasApiKey: async () => false,
    runAgenticSession: async () => ({ proposal: undefined }),
  });

  assert.equal(result.committed, false);
  assert.match(result.summary, /No compatible git-commit model is available/);
  assert.ok(result.summary.includes("~/.pi/agent/git-commit.json"));
});
