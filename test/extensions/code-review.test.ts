import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBulkFixMessage,
  buildSystemPrompt,
  extractResponseText,
  matchesFixThreshold,
  registerReviewCommand,
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

// --- Finding 18: no-UI early return path ---

test("/review exits early when hasUI is false", async () => {
  const { review, ctx, notifications } = setupReviewCommand();
  ctx.hasUI = false;
  await review.handler("gleam", ctx);
  assert.ok(
    notifications.some((n) => n.message.includes("interactive terminal")),
    `Expected interactive terminal notification, got: ${JSON.stringify(notifications)}`,
  );
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
