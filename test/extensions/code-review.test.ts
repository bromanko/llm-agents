import * as fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBulkFixMessage,
  buildFindingsReport,
  buildSystemPrompt,
  detectReviewOutputMode,
  executeReviewSkills,
  extractResponseText,
  matchesFixThreshold,
  registerReviewCommand,
  resetReviewStdoutStateForTests,
  resolveReviewModelObject,
  resolveReviewRequestAuth,
  setOutputGuardModuleLoaderForTests,
  writeReviewStdout,
  type ReviewContext,
  type ReviewDependencies,
} from "../../pi/code-review/extensions/index.ts";
import type { Finding } from "../../pi/code-review/lib/parser.ts";
import type { NotificationLevel } from "../../pi/code-review/lib/fix-flow.ts";
import type { ReviewSkill } from "../../pi/code-review/lib/skills.ts";

/** The pi parameter type expected by registerReviewCommand. */
type ReviewCommandPi = Parameters<typeof registerReviewCommand>[0];

interface RegisteredCommand {
  name: string;
  command: {
    handler(args: string, ctx: ReviewContext): Promise<void>;
  };
}

function sampleFinding(severity: Finding["severity"], title: string): Finding {
  return {
    severity,
    title,
    file: `src/${title}.gleam`,
    category: "code",
    issue: `${title} issue`,
    suggestion: `${title} suggestion`,
    effort: "small",
    skill: "gleam-code-review",
  };
}

function createTestCtx(): {
  ctx: ReviewContext;
  notifications: Array<{ message: string; level: NotificationLevel }>;
} {
  const notifications: Array<{ message: string; level: NotificationLevel }> = [];
  const ctx: ReviewContext = {
    hasUI: true,
    model: "test-model",
    cwd: "/tmp/repo",
    ui: {
      notify(message: string, level: NotificationLevel) {
        notifications.push({ message, level });
      },
      async custom<T>(): Promise<T> {
        throw new Error("not implemented in test");
      },
    },
  };
  return { ctx, notifications };
}

function setupReviewCommand(overrides: ReviewDependencies = {}) {
  const registrations: RegisteredCommand[] = [];
  const followUps: Array<{ message: string; options: unknown }> = [];

  const pi = {
    registerCommand(name: string, command: RegisteredCommand["command"]) {
      registrations.push({ name, command });
    },
    async sendUserMessage(message: string, options: unknown) {
      followUps.push({ message, options });
    },
  };

  const { ctx, notifications } = createTestCtx();

  const skills: ReviewSkill[] = [
    {
      name: "gleam-code-review",
      language: "gleam",
      type: "code",
      path: "/tmp/gleam-code-review/SKILL.md",
    },
  ];

  registerReviewCommand(pi as ReviewCommandPi, {
    skills,
    gatherRangeDiff: async () => ({
      diff: "diff --git a/src/main.gleam b/src/main.gleam\n",
      source: "jj",
    }),
    runReviews: async () => ({
      ok: true,
      findings: [sampleFinding("MEDIUM", "default")],
      totalResponseLength: 42,
    }),
    processFindingActions: async () => ({
      queuedFixCount: 0,
      queueFailures: 0,
      stoppedAt: null,
    }),
    ...overrides,
  });

  const review = registrations.find((r) => r.name === "review")?.command;
  assert.ok(review, "review command should be registered");

  return {
    review,
    ctx,
    followUps,
    notifications,
  };
}

async function captureProcessWrites<T>(
  fn: (captured: { stdout: string[]; stderr: string[] }) => Promise<T> | T,
): Promise<T> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  (process.stdout.write as unknown as (chunk: unknown, ...args: unknown[]) => boolean) =
    ((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

  (process.stderr.write as unknown as (chunk: unknown, ...args: unknown[]) => boolean) =
    ((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

  try {
    return await fn({ stdout, stderr });
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

test("/review gleam uses default @ range and interactive flow when --fix is omitted", async () => {
  const ranges: string[] = [];
  let processCalls = 0;

  const { review, ctx, followUps } = setupReviewCommand({
    gatherRangeDiff: async (_pi, _ctx, range) => {
      ranges.push(range);
      return {
        diff: "diff --git a/src/main.gleam b/src/main.gleam\n",
        source: "jj",
      };
    },
    processFindingActions: async () => {
      processCalls += 1;
      return {
        queuedFixCount: 0,
        queueFailures: 0,
        stoppedAt: null,
      };
    },
  });

  await review.handler("gleam", ctx);

  assert.deepEqual(ranges, ["@"]);
  assert.equal(processCalls, 1);
  assert.equal(followUps.length, 0, "interactive path should not auto-queue fixes");
});

test("/review gleam -r main..@ routes explicit range to range resolver", async () => {
  const ranges: string[] = [];

  const { review, ctx } = setupReviewCommand({
    gatherRangeDiff: async (_pi, _ctx, range) => {
      ranges.push(range);
      return {
        diff: "diff --git a/src/main.gleam b/src/main.gleam\n",
        source: "jj",
      };
    },
  });

  await review.handler("gleam -r main..@", ctx);

  assert.deepEqual(ranges, ["main..@"]);
});

test("/review gleam --fix high queues only HIGH findings", async () => {
  let processCalled = false;

  const { review, ctx, followUps } = setupReviewCommand({
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "high-find"),
        sampleFinding("MEDIUM", "medium-find"),
        sampleFinding("LOW", "low-find"),
      ],
      totalResponseLength: 420,
    }),
    processFindingActions: async () => {
      processCalled = true;
      return {
        queuedFixCount: 0,
        queueFailures: 0,
        stoppedAt: null,
      };
    },
  });

  await review.handler("gleam --fix high", ctx);

  assert.equal(processCalled, false, "--fix path must bypass interactive flow");
  assert.equal(followUps.length, 1);
  assert.match(followUps[0]!.message, /HIGH: high-find/);
  assert.doesNotMatch(followUps[0]!.message, /MEDIUM: medium-find/);
  assert.doesNotMatch(followUps[0]!.message, /LOW: low-find/);
});

test("/review gleam --fix medium queues HIGH and MEDIUM findings", async () => {
  const { review, ctx, followUps } = setupReviewCommand({
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "high-find"),
        sampleFinding("MEDIUM", "medium-find"),
        sampleFinding("LOW", "low-find"),
      ],
      totalResponseLength: 420,
    }),
  });

  await review.handler("gleam --fix medium", ctx);

  assert.equal(followUps.length, 1);
  assert.match(followUps[0]!.message, /HIGH: high-find/);
  assert.match(followUps[0]!.message, /MEDIUM: medium-find/);
  assert.doesNotMatch(followUps[0]!.message, /LOW: low-find/);
});

test("/review gleam still errors without UI when --report is not present", async () => {
  const { review, ctx, notifications } = setupReviewCommand({
    detectOutputMode: () => "interactive",
  });
  ctx.hasUI = false;

  await review.handler("gleam", ctx);

  assert.ok(
    notifications.some((n) => n.message.includes("interactive terminal")),
    `Expected interactive terminal notification, got: ${JSON.stringify(notifications)}`,
  );
});

test("/review gleam --report all in print mode outputs report and bypasses triage", async () => {
  let capturedReport: string | undefined;
  let processCalls = 0;
  let queueCalls = 0;

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => {
      capturedReport = report;
    },
    runReviews: async () => ({
      ok: true,
      findings: [sampleFinding("MEDIUM", "test-find")],
      totalResponseLength: 100,
    }),
    processFindingActions: async () => {
      processCalls += 1;
      return {
        queuedFixCount: 0,
        queueFailures: 0,
        stoppedAt: null,
      };
    },
    queueFixFollowUp: async () => {
      queueCalls += 1;
      return { ok: true as const };
    },
  });
  ctx.hasUI = false;

  await review.handler("gleam --report all", ctx);

  assert.ok(capturedReport);
  assert.match(capturedReport!, /test-find/);
  assert.equal(processCalls, 0);
  assert.equal(queueCalls, 0);
});

test("/review gleam --report all in interactive mode notifies user to use pi -p", async () => {
  const { review, ctx, notifications } = setupReviewCommand({
    detectOutputMode: () => "interactive",
  });

  await review.handler("gleam --report all", ctx);

  assert.ok(
    notifications.some((n) => n.message.includes("pi -p")),
    `Expected pi -p notification, got: ${JSON.stringify(notifications)}`,
  );
});

test("/review gleam --report high includes only HIGH findings in report", async () => {
  let capturedReport = "";

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => {
      capturedReport = report;
    },
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "high-find"),
        sampleFinding("MEDIUM", "medium-find"),
        sampleFinding("LOW", "low-find"),
      ],
      totalResponseLength: 420,
    }),
  });
  ctx.hasUI = false;

  await review.handler("gleam --report high", ctx);

  assert.match(capturedReport, /high-find/);
  assert.doesNotMatch(capturedReport, /medium-find/);
  assert.doesNotMatch(capturedReport, /low-find/);
  assert.match(capturedReport, /Findings: 1 of 3 matched/);
});

test("/review gleam --report medium includes HIGH and MEDIUM findings", async () => {
  let capturedReport = "";

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => {
      capturedReport = report;
    },
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "high-find"),
        sampleFinding("MEDIUM", "medium-find"),
        sampleFinding("LOW", "low-find"),
      ],
      totalResponseLength: 420,
    }),
  });
  ctx.hasUI = false;

  await review.handler("gleam --report medium", ctx);

  assert.match(capturedReport, /high-find/);
  assert.match(capturedReport, /medium-find/);
  assert.doesNotMatch(capturedReport, /low-find/);
  assert.match(capturedReport, /Findings: 2 of 3 matched/);
});

test("/review gleam --report all includes all findings in severity order", async () => {
  let capturedReport = "";

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => {
      capturedReport = report;
    },
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "high-find"),
        sampleFinding("MEDIUM", "medium-find"),
        sampleFinding("LOW", "low-find"),
      ],
      totalResponseLength: 420,
    }),
  });
  ctx.hasUI = false;

  await review.handler("gleam --report all", ctx);

  assert.match(capturedReport, /high-find/);
  assert.match(capturedReport, /medium-find/);
  assert.match(capturedReport, /low-find/);
  assert.match(capturedReport, /Findings: 3 of 3 matched/);
  assert.ok(capturedReport.indexOf("high-find") < capturedReport.indexOf("medium-find"));
  assert.ok(capturedReport.indexOf("medium-find") < capturedReport.indexOf("low-find"));
});

test("/review gleam --report all bypasses processFindingActions and queueFixFollowUp", async () => {
  let processCalls = 0;
  let queueCalls = 0;

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: () => { },
    runReviews: async () => ({
      ok: true,
      findings: [sampleFinding("HIGH", "high-find")],
      totalResponseLength: 420,
    }),
    processFindingActions: async () => {
      processCalls += 1;
      return {
        queuedFixCount: 0,
        queueFailures: 0,
        stoppedAt: null,
      };
    },
    queueFixFollowUp: async () => {
      queueCalls += 1;
      return { ok: true as const };
    },
  });
  ctx.hasUI = false;

  await review.handler("gleam --report all", ctx);

  assert.equal(processCalls, 0);
  assert.equal(queueCalls, 0);
});

test("/review gleam --report high with only LOW findings reports zero matches", async () => {
  let capturedReport = "";

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => {
      capturedReport = report;
    },
    runReviews: async () => ({
      ok: true,
      findings: [sampleFinding("LOW", "minor-thing")],
      totalResponseLength: 100,
    }),
  });
  ctx.hasUI = false;

  await review.handler("gleam --report high", ctx);

  assert.match(capturedReport, /Findings: 0 of 1 matched/);
  assert.match(capturedReport, /No findings matched --report high\./);
});

test("/review gleam --report all with zero findings and large response writes parse-suspicion warning to stderr", async () => {
  let capturedReport: string | undefined;
  let capturedError: string | undefined;

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => {
      capturedReport = report;
    },
    reportErrorWriter: (message) => {
      capturedError = message;
    },
    runReviews: async () => ({
      ok: true,
      findings: [],
      totalResponseLength: 500,
    }),
  });
  ctx.hasUI = false;

  await review.handler("gleam --report all", ctx);

  assert.equal(capturedReport, undefined);
  assert.ok(capturedError);
  assert.match(capturedError!, /no findings could be parsed/i);
});

test("/review gleam --report all in print mode writes fatal setup errors to stderr", async () => {
  let capturedError: string | undefined;

  const { review, ctx, notifications } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportErrorWriter: (message) => {
      capturedError = message;
    },
  });
  ctx.hasUI = false;
  ctx.model = undefined;

  await review.handler("gleam --report all", ctx);

  assert.equal(notifications.length, 0);
  assert.equal(capturedError, "No model selected");
});

test("/review gleam --report all in JSON mode rejects with error", async () => {
  const { review, ctx, notifications } = setupReviewCommand({
    detectOutputMode: () => "json",
  });
  ctx.hasUI = false;

  await review.handler("gleam --report all", ctx);

  assert.ok(
    notifications.some((n) =>
      n.message.includes("--report requires print mode (-p). It cannot be used in JSON mode.")),
    `Expected JSON mode rejection, got: ${JSON.stringify(notifications)}`,
  );
});

test("buildFindingsReport produces deterministic markdown with heading, metadata, and findings", () => {
  const report = buildFindingsReport(
    [sampleFinding("HIGH", "auth-bypass"), sampleFinding("MEDIUM", "missing-guard")],
    {
      language: "gleam",
      range: "@",
      threshold: "medium",
      totalFindings: 3,
    },
  );

  assert.ok(report.startsWith("# Review report\n"));
  assert.match(report, /Language: gleam/);
  assert.match(report, /Range: @/);
  assert.match(report, /Threshold: medium/);
  assert.match(report, /Findings: 2 of 3 matched/);
  assert.match(report, /## HIGH[\s\S]*### 1\. auth-bypass/);
  assert.match(report, /File: src\/auth-bypass\.gleam/);
  assert.match(report, /Skill: gleam-code-review/);
  assert.match(report, /Issue:\nauth-bypass issue/);
  assert.match(report, /Suggested fix:\nauth-bypass suggestion/);
  assert.match(report, /## MEDIUM[\s\S]*### 2\. missing-guard/);
  assert.match(report, /File: src\/missing-guard\.gleam/);
  assert.match(report, /Issue:\nmissing-guard issue/);
  assert.match(report, /Suggested fix:\nmissing-guard suggestion/);
});

test("detectReviewOutputMode classifies argv correctly", () => {
  assert.equal(detectReviewOutputMode(["node", "pi", "-p"]), "print");
  assert.equal(
    detectReviewOutputMode(["/usr/local/bin/node", "/path/to/pi", "-p", "/review gleam"]),
    "print",
  );
  assert.equal(detectReviewOutputMode(["node", "pi", "--print"]), "print");
  assert.equal(detectReviewOutputMode(["node", "pi", "--mode", "json"]), "json");
  assert.equal(detectReviewOutputMode(["node", "pi"]), "interactive");
  assert.throws(() => detectReviewOutputMode(["node", "pi", "--mode", "json", "-p"]), /Cannot combine/);
  assert.equal(detectReviewOutputMode([]), "interactive");
});

test("/review gleam --fix high notifies error and completes when queueFixFollowUp fails", async () => {
  const { review, ctx, notifications } = setupReviewCommand({
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "broken-guard"),
      ],
      totalResponseLength: 200,
    }),
    queueFixFollowUp: async () => ({
      ok: false as const,
      error: new Error("queue full"),
    }),
  });

  await review.handler("gleam --fix high", ctx);

  // queueAutoFixes should emit per-batch error with the reason from formatQueueError
  const batchError = notifications.find(
    (n) => n.level === "error" && n.message.includes("Failed to queue auto-fix batch"),
  );
  assert.ok(
    batchError,
    `Expected batch error notification, got: ${JSON.stringify(notifications)}`,
  );
  assert.match(
    batchError.message,
    /queue full/,
    "Error notification should contain the error reason",
  );

  // notifyQueueSummary should reflect the queueFailures count
  assert.ok(
    notifications.some(
      (n) => n.level === "error" && n.message === "No fixes were queued due to send errors",
    ),
    `Expected queue summary error notification, got: ${JSON.stringify(notifications)}`,
  );

  // Command should still complete normally
  assert.ok(
    notifications.some((n) => n.message === "Review complete"),
    `Expected "Review complete" notification, got: ${JSON.stringify(notifications)}`,
  );
});

test("/review gleam --fix high notifies error without reason when error is not an Error instance", async () => {
  const { review, ctx, notifications } = setupReviewCommand({
    runReviews: async () => ({
      ok: true,
      findings: [
        sampleFinding("HIGH", "broken-guard"),
      ],
      totalResponseLength: 200,
    }),
    queueFixFollowUp: async () => ({
      ok: false as const,
      error: "some opaque value",
    }),
  });

  await review.handler("gleam --fix high", ctx);

  // formatQueueError returns "" for non-Error values, so no parenthesized reason
  const batchError = notifications.find(
    (n) => n.level === "error" && n.message.includes("Failed to queue auto-fix batch"),
  );
  assert.ok(batchError, "Expected batch error notification");
  assert.equal(
    batchError.message,
    "Failed to queue auto-fix batch",
    "Should omit parenthesized reason when error is not an Error instance",
  );
});

test("/review gleam --fix high notifies error and completes when sendUserMessage throws", async () => {
  const registrations: RegisteredCommand[] = [];

  const pi = {
    registerCommand(name: string, command: RegisteredCommand["command"]) {
      registrations.push({ name, command });
    },
    async sendUserMessage(_message: string, _options: unknown) {
      throw new Error("busy");
    },
  };

  const { ctx, notifications } = createTestCtx();

  registerReviewCommand(pi as ReviewCommandPi, {
    skills: [
      {
        name: "gleam-code-review",
        language: "gleam",
        type: "code",
        path: "/tmp/gleam-code-review/SKILL.md",
      },
    ],
    gatherRangeDiff: async () => ({
      diff: "diff --git a/src/main.gleam b/src/main.gleam\n",
      source: "jj" as const,
    }),
    runReviews: async () => ({
      ok: true,
      findings: [sampleFinding("HIGH", "broken-guard")],
      totalResponseLength: 200,
    }),
    // Intentionally NOT overriding queueFixFollowUp — the real one
    // calls pi.sendUserMessage which throws, exercising the end-to-end error path
  });

  const review = registrations.find((r) => r.name === "review")?.command;
  assert.ok(review);

  await review.handler("gleam --fix high", ctx);

  // The real queueFixFollowUp catches the throw and returns { ok: false, error }
  // Then queueAutoFixes formats it and notifies
  const batchError = notifications.find(
    (n) => n.level === "error" && n.message.includes("Failed to queue auto-fix batch"),
  );
  assert.ok(batchError, "Expected batch error notification from real queueFixFollowUp path");
  assert.match(batchError.message, /busy/, "Should surface the thrown error message");

  assert.ok(
    notifications.some((n) => n.message === "Review complete"),
    "Command should complete without throwing",
  );
});

test("matchesFixThreshold maps severities to expected thresholds", () => {
  const matrix: Array<{ level: "high" | "medium" | "low" | "all"; severity: Finding["severity"]; expected: boolean }> = [
    { level: "high", severity: "HIGH", expected: true },
    { level: "high", severity: "MEDIUM", expected: false },
    { level: "medium", severity: "HIGH", expected: true },
    { level: "medium", severity: "MEDIUM", expected: true },
    { level: "medium", severity: "LOW", expected: false },
    { level: "low", severity: "LOW", expected: true },
    { level: "low", severity: "HIGH", expected: true },
    { level: "low", severity: "MEDIUM", expected: true },
    { level: "all", severity: "HIGH", expected: true },
    { level: "all", severity: "MEDIUM", expected: true },
    { level: "all", severity: "LOW", expected: true },
  ];

  for (const row of matrix) {
    assert.equal(
      matchesFixThreshold(row.severity, row.level),
      row.expected,
      `${row.level} threshold mismatch for ${row.severity}`,
    );
  }
});

// --- Finding 3: buildBulkFixMessage unit tests ---

function simpleBuildFixMessage(finding: Finding, customInstructions?: string): string {
  let message = `Please fix the following code review finding:\n\n`;
  message += `**${finding.severity}: ${finding.title}**\n`;
  if (finding.file) {
    message += `File: ${finding.file}\n`;
  }
  message += `\nIssue: ${finding.issue}\n`;
  message += `\nSuggested fix: ${finding.suggestion}\n`;
  if (customInstructions) {
    message += `\nAdditional instructions: ${customInstructions}\n`;
  }
  return message;
}

test("buildBulkFixMessage with single finding produces correct 1/1 numbering", () => {
  const findings = [sampleFinding("HIGH", "single-issue")];
  const result = buildBulkFixMessage(findings, simpleBuildFixMessage);

  assert.match(result, /--- Finding 1\/1 ---/);
  assert.match(result, /HIGH: single-issue/);
  assert.ok(result.endsWith("\n"), "should end with a single newline");
  assert.ok(!result.endsWith("\n\n"), "should not end with double newline");
});

test("buildBulkFixMessage with multiple findings concatenates in order with correct headers", () => {
  const findings = [
    sampleFinding("HIGH", "first"),
    sampleFinding("MEDIUM", "second"),
    sampleFinding("LOW", "third"),
  ];
  const result = buildBulkFixMessage(findings, simpleBuildFixMessage);

  assert.match(result, /--- Finding 1\/3 ---/);
  assert.match(result, /--- Finding 2\/3 ---/);
  assert.match(result, /--- Finding 3\/3 ---/);

  const firstIdx = result.indexOf("first");
  const secondIdx = result.indexOf("second");
  const thirdIdx = result.indexOf("third");
  assert.ok(firstIdx < secondIdx, "first finding should come before second");
  assert.ok(secondIdx < thirdIdx, "second finding should come before third");
});

test("buildBulkFixMessage output is trimmed with single trailing newline", () => {
  const findings = [sampleFinding("LOW", "trailing-ws")];
  const result = buildBulkFixMessage(findings, simpleBuildFixMessage);

  assert.ok(result.endsWith("\n"), "should end with newline");
  assert.ok(!result.endsWith("\n\n"), "should not end with double newline");
});

test("buildBulkFixMessage handles findings with trailing whitespace", () => {
  const buildFixWithTrailing = (finding: Finding) => {
    return `**${finding.severity}: ${finding.title}**\n\nIssue: ${finding.issue}  \n\n`;
  };
  const findings = [sampleFinding("HIGH", "ws-test")];
  const result = buildBulkFixMessage(findings, buildFixWithTrailing);

  // The trimEnd() in buildBulkFixMessage should prevent double blank lines
  assert.ok(!result.includes("\n\n\n"), "should not produce triple newlines");
});

// --- Finding 4: buildSystemPrompt and extractResponseText unit tests ---

test("buildSystemPrompt includes skill content", () => {
  const prompt = buildSystemPrompt("Review for null checks.", []);
  assert.match(prompt, /Review for null checks\./);
  assert.match(prompt, /You are a code reviewer/);
});

test("buildSystemPrompt includes previous findings context", () => {
  const existing: Finding[] = [
    sampleFinding("HIGH", "existing-issue"),
  ];
  const prompt = buildSystemPrompt("Check safety.", existing);

  assert.match(prompt, /Findings already reported/);
  assert.match(prompt, /existing-issue/);
  assert.match(prompt, /do NOT repeat these/);
});

test("buildSystemPrompt omits findings section when no existing findings", () => {
  const prompt = buildSystemPrompt("Check safety.", []);
  assert.doesNotMatch(prompt, /Findings already reported/);
});

test("extractResponseText filters for text content blocks only", () => {
  const content = [
    { type: "text", text: "Hello" },
    { type: "image", url: "http://example.com" },
    { type: "text", text: "World" },
    { type: "tool_use", id: "123" },
  ];
  const result = extractResponseText(content);
  assert.equal(result, "Hello\nWorld");
});

test("extractResponseText handles empty content array", () => {
  const result = extractResponseText([]);
  assert.equal(result, "");
});

test("extractResponseText handles content with no text blocks", () => {
  const content = [
    { type: "image", url: "http://example.com" },
  ];
  const result = extractResponseText(content);
  assert.equal(result, "");
});

test("resolveReviewModelObject prefers registry model for object session models", () => {
  const registryModel = {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
  };

  const ctx: ReviewContext = {
    ...createTestCtx().ctx,
    model: {
      provider: "openai-codex",
      id: "gpt-5.4",
      name: "session-model",
    },
    modelRegistry: {
      find: () => registryModel,
    },
  };

  assert.equal(resolveReviewModelObject(ctx), registryModel);
});

test("resolveReviewRequestAuth uses getApiKeyAndHeaders when available", async () => {
  const model = {
    provider: "openai-codex",
    id: "gpt-5.4",
  };

  const auth = await resolveReviewRequestAuth(
    {
      ...createTestCtx().ctx,
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          apiKey: "token-123",
          headers: { Authorization: "Bearer token-123" },
        }),
      },
    },
    model,
  );

  assert.deepEqual(auth, {
    apiKey: "token-123",
    headers: { Authorization: "Bearer token-123" },
  });
});

test("resolveReviewRequestAuth tolerates undefined getApiKeyAndHeaders results", async () => {
  const model = {
    provider: "openai-codex",
    id: "gpt-5.4",
  };

  const auth = await resolveReviewRequestAuth(
    {
      ...createTestCtx().ctx,
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => undefined as never,
        getApiKey: async () => "fallback-token",
      },
    },
    model,
  );

  assert.deepEqual(auth, {
    apiKey: "fallback-token",
  });
});

// --- Finding 19: parseReviewArgs empty-input handler path ---

test("/review with no args shows usage", async () => {
  const { review, ctx, notifications } = setupReviewCommand();
  await review.handler("", ctx);
  assert.ok(
    notifications.some((n) => n.message.includes("Usage")),
    `Expected Usage notification, got: ${JSON.stringify(notifications)}`,
  );
});

// --- Finding 20: --fix with zero findings above threshold ---

test("/review gleam --fix high with only LOW findings skips all and does not queue", async () => {
  const { review, ctx, followUps, notifications } = setupReviewCommand({
    runReviews: async () => ({
      ok: true,
      findings: [sampleFinding("LOW", "minor-thing")],
      totalResponseLength: 100,
    }),
  });
  await review.handler("gleam --fix high", ctx);
  assert.equal(followUps.length, 0, "no follow-ups should be queued");
  assert.ok(
    notifications.some((n) => n.message.includes("Skipped 1 finding")),
    `Expected skip notification, got: ${JSON.stringify(notifications)}`,
  );
});

// --- Finding 6: buildFindingsReport with empty findings array ---

test("buildFindingsReport with empty findings produces no-match message", () => {
  const report = buildFindingsReport([], {
    language: "gleam",
    range: "@",
    threshold: "high",
    totalFindings: 5,
  });

  assert.match(report, /Findings: 0 of 5 matched/);
  assert.match(report, /No findings matched --report high\./);
  assert.doesNotMatch(report, /## HIGH/);
});

// --- Finding 7: buildFindingsReport when finding.file is undefined ---

test("buildFindingsReport omits File line when finding has no file", () => {
  const finding: Finding = {
    ...sampleFinding("HIGH", "no-file-finding"),
    file: undefined,
  };
  const report = buildFindingsReport([finding], {
    language: "gleam",
    range: "@",
    threshold: "all",
    totalFindings: 1,
  });

  assert.match(report, /no-file-finding/);
  assert.doesNotMatch(report, /File:/);
  assert.match(report, /Skill: gleam-code-review/);
});

// --- Finding 8: --report all with zero findings and short response ---

test("/review gleam --report all with zero findings and short response outputs clean empty report", async () => {
  let capturedReport: string | undefined;
  let capturedError: string | undefined;

  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportPresenter: (report) => { capturedReport = report; },
    reportErrorWriter: (message) => { capturedError = message; },
    runReviews: async () => ({
      ok: true,
      findings: [],
      totalResponseLength: 50, // below MIN_RESPONSE_FOR_SUSPICION
    }),
  });
  ctx.hasUI = false;

  await review.handler("gleam --report all", ctx);

  assert.equal(capturedError, undefined);
  assert.ok(capturedReport);
  assert.match(capturedReport!, /No findings matched --report all/);
});

// --- Finding 9: --report error paths routing through reportErrorWriter for non-model errors ---

test("/review gleam --report all writes range-diff errors to stderr", async () => {
  let capturedError: string | undefined;
  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportErrorWriter: (msg) => { capturedError = msg; },
    gatherRangeDiff: async () => ({ error: "jj/git not found", diff: null }),
  });
  ctx.hasUI = false;
  await review.handler("gleam --report all", ctx);
  assert.ok(capturedError);
  assert.match(capturedError!, /jj\/git not found/);
});

// --- Finding 3: executeReviewSkills abort/cancellation path ---

test("executeReviewSkills returns cancelled when response is aborted", async () => {
  const tmpSkillPath = "/tmp/test-review-skill-abort.md";
  fs.writeFileSync(tmpSkillPath, "Review carefully.\n");
  try {
    const { ctx } = createTestCtx();
    ctx.model = { provider: "test", id: "test-model", name: "Test" };
    const skills: ReviewSkill[] = [
      { name: "skill-1", language: "gleam", type: "code", path: tmpSkillPath },
      { name: "skill-2", language: "gleam", type: "security", path: tmpSkillPath },
    ];
    const controller = new AbortController();
    const complete = async (
      _model: unknown,
      _input: unknown,
      _options: unknown,
    ) => {
      controller.abort();
      return {
        stopReason: "aborted" as const,
        content: [] as Array<{ type: string; text?: string }>,
      };
    };
    const result = await executeReviewSkills(ctx, skills, "diff content", complete, {
      signal: controller.signal,
    });
    assert.equal(result.ok, false);
    assert.equal((result as Extract<typeof result, { ok: false }>).cancelled, true);
  } finally {
    fs.unlinkSync(tmpSkillPath);
  }
});

// --- Finding 4: headless runReviews error handling (via handler in print mode) ---

test("/review gleam --report all suppresses cancelled-review info in print mode", async () => {
  let capturedError: string | undefined;
  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportErrorWriter: (msg) => { capturedError = msg; },
    runReviews: async () => ({ ok: false as const, cancelled: true as const }),
  });
  ctx.hasUI = false;
  await review.handler("gleam --report all", ctx);
  assert.equal(capturedError, undefined, "cancelled review should not write to stderr in print mode");
});

// --- Finding 14: buildFindingsReport when finding.effort is undefined ---

test("buildFindingsReport omits Effort line when finding has no effort", () => {
  const finding: Finding = { ...sampleFinding("HIGH", "no-effort"), effort: undefined };
  const report = buildFindingsReport([finding], {
    language: "gleam",
    range: "@",
    threshold: "all",
    totalFindings: 1,
  });
  assert.doesNotMatch(report, /Effort:/);
});

// --- Finding 15: onSkillStart callback in executeReviewSkills ---

test("executeReviewSkills calls onSkillStart for each skill", async () => {
  const tmpSkillPath = "/tmp/test-review-skill-callback.md";
  fs.writeFileSync(tmpSkillPath, "Review carefully.\n");
  try {
    const { ctx } = createTestCtx();
    ctx.model = { provider: "test", id: "test-model", name: "Test" };
    const skills: ReviewSkill[] = [
      { name: "skill-1", language: "gleam", type: "code", path: tmpSkillPath },
      { name: "skill-2", language: "gleam", type: "security", path: tmpSkillPath },
    ];
    const calls: Array<{ name: string; index: number; total: number }> = [];
    const complete = async (
      _model: unknown,
      _input: unknown,
      _options: unknown,
    ) => ({
      content: [{ type: "text" as const, text: "No issues found." }] as Array<{
        type: string;
        text?: string;
      }>,
    });
    const result = await executeReviewSkills(ctx, skills, "diff content", complete, {
      onSkillStart: (skill, index, total) => {
        calls.push({ name: skill.name, index, total });
      },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { name: "skill-1", index: 0, total: 2 });
    assert.deepEqual(calls[1], { name: "skill-2", index: 1, total: 2 });
  } finally {
    fs.unlinkSync(tmpSkillPath);
  }
});

// --- Finding 16: detectReviewOutputMode edge cases ---

test("detectReviewOutputMode handles --mode as last element without crashing", () => {
  assert.equal(detectReviewOutputMode(["node", "pi", "--mode"]), "interactive");
});

test("detectReviewOutputMode throws when -p and --mode json both present (either order)", () => {
  assert.throws(
    () => detectReviewOutputMode(["node", "pi", "-p", "--mode", "json"]),
    /Cannot combine/,
  );
  assert.throws(
    () => detectReviewOutputMode(["node", "pi", "--mode", "json", "--print"]),
    /Cannot combine/,
  );
});

test("detectReviewOutputMode returns interactive for non-json --mode value", () => {
  assert.equal(detectReviewOutputMode(["node", "pi", "--mode", "text"]), "interactive");
});

// --- Finding 17: resolveReviewRequestAuth with null result ---

test("resolveReviewRequestAuth tolerates null getApiKeyAndHeaders result", async () => {
  const model = { provider: "openai", id: "gpt-5" };
  const auth = await resolveReviewRequestAuth(
    {
      ...createTestCtx().ctx,
      model,
      modelRegistry: {
        getApiKeyAndHeaders: async () => null as never,
        getApiKey: async () => "fallback-key",
      },
    },
    model,
  );
  assert.deepEqual(auth, { apiKey: "fallback-key" });
});

// --- Finding 18: writeReviewStdout helper behavior ---

test("writeReviewStdout uses writeRawStdout when output-guard loader succeeds", async () => {
  setOutputGuardModuleLoaderForTests(async () => ({
    writeRawStdout(text: string) {
      rawWrites.push(text);
    },
  }));

  const rawWrites: string[] = [];

  try {
    await captureProcessWrites(async ({ stdout, stderr }) => {
      await writeReviewStdout("report body\n");
      assert.deepEqual(rawWrites, ["report body\n"]);
      assert.deepEqual(stdout, []);
      assert.deepEqual(stderr, []);
    });
  } finally {
    resetReviewStdoutStateForTests();
  }
});

test("writeReviewStdout clears failed loader cache and retries successfully", async () => {
  let attempts = 0;
  const rawWrites: string[] = [];

  setOutputGuardModuleLoaderForTests(async () => {
    attempts += 1;
    if (attempts === 1) {
      throw new Error("boom");
    }
    return {
      writeRawStdout(text: string) {
        rawWrites.push(text);
      },
    };
  });

  try {
    await captureProcessWrites(async ({ stdout, stderr }) => {
      await writeReviewStdout("first\n");
      await writeReviewStdout("second\n");

      assert.equal(attempts, 2);
      assert.deepEqual(stdout, ["first\n"]);
      assert.deepEqual(rawWrites, ["second\n"]);
      assert.equal(stderr.length, 1);
      assert.match(stderr[0]!, /Raw stdout unavailable/);
      assert.match(stderr[0]!, /boom/);
    });
  } finally {
    resetReviewStdoutStateForTests();
  }
});

test("writeReviewStdout warns only once when output-guard module is invalid", async () => {
  setOutputGuardModuleLoaderForTests(async () => ({}));

  try {
    await captureProcessWrites(async ({ stdout, stderr }) => {
      await writeReviewStdout("one\n");
      await writeReviewStdout("two\n");

      assert.deepEqual(stdout, ["one\n", "two\n"]);
      assert.equal(stderr.length, 1);
      assert.match(stderr[0]!, /missing writeRawStdout export/);
    });
  } finally {
    resetReviewStdoutStateForTests();
  }
});

// --- Finding 19: --report combined with review failure ---

test("/review gleam --report all writes review failure to stderr", async () => {
  let capturedError: string | undefined;
  const { review, ctx } = setupReviewCommand({
    detectOutputMode: () => "print",
    reportErrorWriter: (msg) => { capturedError = msg; },
    runReviews: async () => ({ ok: false as const, cancelled: false as const, error: "Model timeout" }),
  });
  ctx.hasUI = false;
  await review.handler("gleam --report all", ctx);
  assert.ok(capturedError);
  assert.match(capturedError!, /Model timeout/);
});
