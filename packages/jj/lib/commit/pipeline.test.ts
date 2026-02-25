import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runCommitPipeline, pushWithBookmark } from "./pipeline.ts";
import type { PipelineContext, AgenticSessionInput, AgenticSessionResult } from "./pipeline.ts";
import type { ModelCandidate } from "./model-resolver.ts";
import type { CommitProposal, SplitCommitPlan } from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers: mock ControlledJj
// ---------------------------------------------------------------------------

interface MockJjOptions {
  changedFiles?: string[];
  diff?: string;
  stat?: string;
  absorbResult?: { changed: boolean; output: string };
  commitLog?: string[][];
  bookmarkCalls?: string[][];
  pushCalls?: string[];
}

function createMockJj(opts: MockJjOptions = {}) {
  const commitLog: string[][] = opts.commitLog ?? [];
  const bookmarkCalls: string[][] = opts.bookmarkCalls ?? [];
  const pushCalls: string[] = opts.pushCalls ?? [];

  return {
    getChangedFiles: async () => opts.changedFiles ?? [],
    getDiffGit: async () => opts.diff ?? "",
    getStat: async () => opts.stat ?? "",
    getHunks: async () => [],
    getRecentCommits: async () => [],
    absorb: async () => opts.absorbResult ?? { changed: false, output: "" },
    commit: async (message: string, files?: string[]) => {
      commitLog.push([message, ...(files ?? [])]);
    },
    setBookmark: async (name: string, rev: string) => {
      bookmarkCalls.push([name, rev]);
    },
    pushBookmark: async (name: string) => {
      pushCalls.push(name);
    },
    _commitLog: commitLog,
    _bookmarkCalls: bookmarkCalls,
    _pushCalls: pushCalls,
  };
}

const sessionModel: ModelCandidate = {
  provider: "anthropic",
  id: "claude-sonnet-4-6-20260301",
  name: "Claude Sonnet 4.6",
};

function createBasicContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
  return {
    jj: createMockJj({ changedFiles: ["src/main.ts"] }) as any,
    cwd: "/tmp/test-repo",
    args: { dryRun: false, push: false, noChangelog: true, noAbsorb: false },
    availableModels: [],
    sessionModel: undefined,
    hasApiKey: async () => false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------

test("pipeline: reports nothing to commit when no changed files", async () => {
  const jj = createMockJj({ changedFiles: [] });
  const ctx = createBasicContext({ jj: jj as any });
  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, false);
  assert.ok(result.summary.includes("Nothing to commit"));
});

test("pipeline: uses deterministic fallback when no model available", async () => {
  const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({ jj: jj as any });
  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, true);
  assert.ok(result.messages.length > 0);
  assert.ok(result.warnings.some((w) => w.includes("fallback")));
});

test("pipeline: does not fetch diff/stat when agentic analysis is not used", async () => {
  let diffCalls = 0;
  let statCalls = 0;
  const jj = createMockJj({ changedFiles: ["src/main.ts"] });
  jj.getDiffGit = async () => {
    diffCalls += 1;
    return "diff";
  };
  jj.getStat = async () => {
    statCalls += 1;
    return "stat";
  };

  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [],
    sessionModel: undefined,
    hasApiKey: async () => false,
    runAgenticSession: undefined,
  });

  await runCommitPipeline(ctx);

  assert.equal(diffCalls, 0);
  assert.equal(statCalls, 0);
});

test("pipeline: dry-run does not commit", async () => {
  const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    args: { dryRun: true, push: false, noChangelog: true, noAbsorb: false },
  });
  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, false);
  assert.ok(result.summary.includes("commit message"));
  assert.equal(jj._commitLog.length, 0);
});

test("pipeline: runs absorb when not disabled", async () => {
  let absorbCalled = false;
  const jj = createMockJj({
    changedFiles: ["src/main.ts"],
    diff: "diff",
    stat: "stat",
    absorbResult: { changed: false, output: "" },
  });
  const origAbsorb = jj.absorb;
  jj.absorb = async () => {
    absorbCalled = true;
    return origAbsorb();
  };

  const ctx = createBasicContext({ jj: jj as any });
  await runCommitPipeline(ctx);
  assert.ok(absorbCalled, "absorb should have been called");
});

test("pipeline: skips absorb when disabled", async () => {
  let absorbCalled = false;
  const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
  jj.absorb = async () => {
    absorbCalled = true;
    return { changed: false, output: "" };
  };

  const ctx = createBasicContext({
    jj: jj as any,
    args: { dryRun: false, push: false, noChangelog: true, noAbsorb: true },
  });
  await runCommitPipeline(ctx);
  assert.ok(!absorbCalled, "absorb should not have been called");
});

test("pipeline: all changes absorbed means nothing left to commit", async () => {
  let callCount = 0;
  const jj = createMockJj({ diff: "diff", stat: "stat" });
  jj.getChangedFiles = async () => {
    callCount++;
    return callCount === 1 ? ["a.ts"] : [];
  };
  jj.absorb = async () => ({ changed: true, output: "Absorbed 1 change" });

  const ctx = createBasicContext({ jj: jj as any });
  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, false);
  assert.ok(result.summary.includes("absorbed"));
});

test("pipeline: uses agentic session when model and session available", async () => {
  let agenticCalled = false;
  const expectedProposal: CommitProposal = {
    type: "feat",
    scope: "commit",
    summary: "added commit pipeline",
    details: [],
    issueRefs: [],
    warnings: [],
  };

  const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => {
      agenticCalled = true;
      return { proposal: expectedProposal };
    },
  });

  const result = await runCommitPipeline(ctx);
  assert.ok(agenticCalled, "agentic session should have been called");
  assert.equal(result.committed, true);
  assert.ok(result.messages[0].includes("added commit pipeline"));
});

test("pipeline: fetches diff/stat only when running agentic session", async () => {
  let diffCalls = 0;
  let statCalls = 0;

  const jj = createMockJj({ changedFiles: ["src/main.ts"] });
  jj.getDiffGit = async () => {
    diffCalls += 1;
    return "diff";
  };
  jj.getStat = async () => {
    statCalls += 1;
    return "stat";
  };

  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => ({
      proposal: {
        type: "chore",
        scope: null,
        summary: "updated files",
        details: [],
        issueRefs: [],
        warnings: [],
      },
    }),
  });

  await runCommitPipeline(ctx);

  assert.equal(diffCalls, 1);
  assert.equal(statCalls, 1);
});

test("pipeline: falls back to deterministic on agentic failure", async () => {
  const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => {
      throw new Error("Model API error");
    },
  });

  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, true);
  assert.ok(result.warnings.some((w) => w.includes("Agentic session failed")));
});

test("pipeline: executes split commits in dependency order", async () => {
  const splitPlan: SplitCommitPlan = {
    commits: [
      {
        files: ["a.ts"],
        type: "feat",
        scope: null,
        summary: "added module a",
        details: [],
        issueRefs: [],
        dependencies: [1], // depends on b
      },
      {
        files: ["b.ts"],
        type: "feat",
        scope: null,
        summary: "added module b",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
    ],
    warnings: [],
    mode: "file",
  };

  const jj = createMockJj({ changedFiles: ["a.ts", "b.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => ({ splitPlan }),
  });

  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, true);
  assert.equal(jj._commitLog.length, 2);
  // b should be committed first (dependency order)
  assert.ok(jj._commitLog[0][0].includes("added module b"));
  assert.ok(jj._commitLog[1][0].includes("added module a"));
});

test("pipeline: dry-run with split plan shows all commits", async () => {
  const splitPlan: SplitCommitPlan = {
    commits: [
      {
        files: ["a.ts"],
        type: "feat",
        scope: null,
        summary: "added feature a",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
      {
        files: ["b.ts"],
        type: "fix",
        scope: null,
        summary: "fixed bug in b",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
    ],
    warnings: [],
    mode: "file",
  };

  const jj = createMockJj({ changedFiles: ["a.ts", "b.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    args: { dryRun: true, push: false, noChangelog: true, noAbsorb: false },
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => ({ splitPlan }),
  });

  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, false);
  assert.ok(result.summary.includes("Split commit plan"));
  assert.equal(result.messages.length, 2);
  assert.equal(jj._commitLog.length, 0);
});

test("pipeline: rejects split plan that omits changed files", async () => {
  const splitPlan: SplitCommitPlan = {
    commits: [
      {
        files: ["a.ts"],
        type: "feat",
        scope: null,
        summary: "added module a",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
    ],
    warnings: [],
    mode: "file",
  };

  const jj = createMockJj({ changedFiles: ["a.ts", "b.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => ({ splitPlan }),
  });

  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, false);
  assert.equal(jj._commitLog.length, 0);
  assert.ok(result.summary.includes("Invalid split commit plan"));
  assert.ok(result.summary.includes("Changed file missing from split plan: b.ts"));
  assert.ok(result.warnings.some((w) => w.includes("Split plan validation failed")));
});

test("pipeline: rejects split plan with duplicate files and invalid dependencies", async () => {
  const splitPlan: SplitCommitPlan = {
    commits: [
      {
        files: ["a.ts"],
        type: "feat",
        scope: null,
        summary: "added module a",
        details: [],
        issueRefs: [],
        dependencies: [],
      },
      {
        files: ["a.ts", "b.ts"],
        type: "fix",
        scope: null,
        summary: "fixed module b",
        details: [],
        issueRefs: [],
        dependencies: [9],
      },
    ],
    warnings: [],
    mode: "file",
  };

  const jj = createMockJj({ changedFiles: ["a.ts", "b.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [sessionModel],
    sessionModel,
    hasApiKey: async () => true,
    runAgenticSession: async () => ({ splitPlan }),
  });

  const result = await runCommitPipeline(ctx);
  assert.equal(result.committed, false);
  assert.equal(jj._commitLog.length, 0);
  assert.ok(result.summary.includes("Invalid split commit plan"));
  assert.ok(result.summary.includes("File appears in multiple commits: a.ts"));
  assert.ok(result.summary.includes("dependency index out of range"));
  assert.ok(result.warnings.some((w) => w.includes("Split plan validation failed")));
});

test("pipeline: warns and continues when changelog path does not exist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-changelog-missing-"));
  try {
    const missingPath = path.join(dir, "MISSING_CHANGELOG.md");
    const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
    const ctx = createBasicContext({
      jj: jj as any,
      cwd: dir,
      args: { dryRun: false, push: false, noChangelog: false, noAbsorb: true },
      availableModels: [sessionModel],
      sessionModel,
      hasApiKey: async () => true,
      runAgenticSession: async () => ({
        proposal: {
          type: "chore",
          scope: null,
          summary: "updated files",
          details: [],
          issueRefs: [],
          warnings: [],
        },
        changelogEntries: [
          {
            path: missingPath,
            entries: { Added: ["Added missing-path coverage"] },
          },
        ],
      }),
    });

    const result = await runCommitPipeline(ctx);

    assert.equal(result.committed, true);
    assert.equal(jj._commitLog.length, 1);
    assert.ok(result.warnings.some((w) => w.includes("Changelog path does not exist")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: surfaces changelog parse failures as warnings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-changelog-parse-"));
  try {
    const changelogPath = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(changelogPath, "# Changelog\n\n## [1.0.0] - 2026-01-01\n");

    const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
    const ctx = createBasicContext({
      jj: jj as any,
      cwd: dir,
      args: { dryRun: false, push: false, noChangelog: false, noAbsorb: true },
      availableModels: [sessionModel],
      sessionModel,
      hasApiKey: async () => true,
      runAgenticSession: async () => ({
        proposal: {
          type: "chore",
          scope: null,
          summary: "updated files",
          details: [],
          issueRefs: [],
          warnings: [],
        },
        changelogEntries: [
          {
            path: changelogPath,
            entries: { Added: ["Should fail to apply"] },
          },
        ],
      }),
    });

    const result = await runCommitPipeline(ctx);

    assert.equal(result.committed, true);
    assert.equal(jj._commitLog.length, 1);
    assert.ok(result.warnings.some((w) => w.includes("Changelog update failed")));
    assert.ok(result.warnings.some((w) => w.includes("No [Unreleased] section found")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: dry-run does not write changelog updates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-changelog-dryrun-"));
  try {
    const changelogPath = path.join(dir, "CHANGELOG.md");
    const initial = `# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n`;
    fs.writeFileSync(changelogPath, initial);

    const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
    const ctx = createBasicContext({
      jj: jj as any,
      cwd: dir,
      args: { dryRun: true, push: false, noChangelog: false, noAbsorb: true },
      availableModels: [sessionModel],
      sessionModel,
      hasApiKey: async () => true,
      runAgenticSession: async () => ({
        proposal: {
          type: "chore",
          scope: null,
          summary: "updated files",
          details: [],
          issueRefs: [],
          warnings: [],
        },
        changelogEntries: [
          {
            path: changelogPath,
            entries: { Added: ["Would be added outside dry-run"] },
          },
        ],
      }),
    });

    const result = await runCommitPipeline(ctx);

    assert.equal(result.committed, false);
    assert.equal(jj._commitLog.length, 0);
    assert.equal(fs.readFileSync(changelogPath, "utf-8"), initial);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: writes changelog updates and reports progress", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pipeline-changelog-write-"));
  try {
    const changelogPath = path.join(dir, "CHANGELOG.md");
    fs.writeFileSync(
      changelogPath,
      "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n",
    );

    const progress: string[] = [];
    const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
    const ctx = createBasicContext({
      jj: jj as any,
      cwd: dir,
      args: { dryRun: false, push: false, noChangelog: false, noAbsorb: true },
      availableModels: [sessionModel],
      sessionModel,
      hasApiKey: async () => true,
      onProgress: (message: string) => {
        progress.push(message);
      },
      runAgenticSession: async () => ({
        proposal: {
          type: "chore",
          scope: null,
          summary: "updated files",
          details: [],
          issueRefs: [],
          warnings: [],
        },
        changelogEntries: [
          {
            path: changelogPath,
            entries: { Added: ["Added pipeline changelog integration"] },
          },
        ],
      }),
    });

    const result = await runCommitPipeline(ctx);
    const updated = fs.readFileSync(changelogPath, "utf-8");

    assert.equal(result.committed, true);
    assert.equal(jj._commitLog.length, 1);
    assert.ok(updated.includes("### Added"));
    assert.ok(updated.includes("- Added pipeline changelog integration"));
    assert.ok(progress.some((p) => p === `Updated ${changelogPath}`));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pipeline: model fallback warning is included", async () => {
  const jj = createMockJj({ changedFiles: ["src/main.ts"], diff: "diff", stat: "stat" });
  const ctx = createBasicContext({
    jj: jj as any,
    availableModels: [],
    sessionModel: undefined,
    hasApiKey: async () => true,
  });

  const result = await runCommitPipeline(ctx);
  assert.ok(result.warnings.some((w) => w.includes("not found in registry")));
});

// ---------------------------------------------------------------------------
// pushWithBookmark
// ---------------------------------------------------------------------------

test("pushWithBookmark: sets bookmark and pushes", async () => {
  const jj = createMockJj();
  const result = await pushWithBookmark(jj as any, "main", () => {});
  assert.equal(result.success, true);
  assert.deepStrictEqual(jj._bookmarkCalls, [["main", "@-"]]);
  assert.deepStrictEqual(jj._pushCalls, ["main"]);
});

test("pushWithBookmark: returns error on failure", async () => {
  const jj = createMockJj();
  jj.pushBookmark = async () => {
    throw new Error("no remote configured");
  };
  const result = await pushWithBookmark(jj as any, "main", () => {});
  assert.equal(result.success, false);
  assert.ok(result.error?.includes("no remote"));
});
