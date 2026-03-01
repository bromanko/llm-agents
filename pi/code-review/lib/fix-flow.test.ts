import assert from "node:assert/strict";
import test from "node:test";

import type { Finding } from "./parser.ts";
import {
  formatQueueError,
  type FollowUpMessenger,
  type NotificationLevel,
  notifyQueueSummary,
  processFindingActions,
  queueFixFollowUp,
  type ReviewUiContext,
} from "./fix-flow.ts";

// --- Shared test helpers (Finding 6) ---

type SendCall = { message: string; options: { deliverAs: "followUp" } };

function createMockMessenger(calls: SendCall[]): FollowUpMessenger {
  return {
    async sendUserMessage(
      message: string,
      options: { deliverAs: "followUp" },
    ) {
      calls.push({ message, options });
    },
  };
}

function createThrowingMessenger(
  calls: SendCall[],
  error: Error,
): FollowUpMessenger {
  return {
    async sendUserMessage(
      message: string,
      options: { deliverAs: "followUp" },
    ) {
      calls.push({ message, options });
      throw error;
    },
  };
}

function createMockUiContext(): {
  ctx: ReviewUiContext;
  notifications: Array<{ message: string; level: NotificationLevel }>;
} {
  const notifications: Array<{ message: string; level: NotificationLevel }> =
    [];
  const ctx: ReviewUiContext = {
    ui: {
      notify(message: string, level: NotificationLevel) {
        notifications.push({ message, level });
      },
    },
  };
  return { ctx, notifications };
}

function testFinding(title: string): Finding {
  return {
    severity: "MEDIUM",
    title,
    file: undefined,
    category: undefined,
    issue: `${title} issue`,
    suggestion: `${title} suggestion`,
    effort: undefined,
    skill: "test",
  };
}

// --- queueFixFollowUp tests ---

test("queueFixFollowUp returns ok:true and uses followUp delivery on success", async () => {
  const calls: SendCall[] = [];
  const pi = createMockMessenger(calls);

  const result = await queueFixFollowUp(pi, "fix:First issue");

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    message: "fix:First issue",
    options: { deliverAs: "followUp" },
  });
});

test("queueFixFollowUp returns ok:false with error when sendUserMessage throws", async () => {
  const err = new Error("busy");
  const calls: SendCall[] = [];
  const pi = createThrowingMessenger(calls, err);

  const result = await queueFixFollowUp(pi, "fix:Second issue");

  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error, err);
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    message: "fix:Second issue",
    options: { deliverAs: "followUp" },
  });
});

// --- formatQueueError tests (Finding 2) ---

test("formatQueueError returns trimmed message for Error with message", () => {
  assert.equal(formatQueueError(new Error("  oops  ")), "oops");
});

test("formatQueueError returns empty string for Error with blank message", () => {
  assert.equal(formatQueueError(new Error("   ")), "");
});

test("formatQueueError returns empty string for non-Error values", () => {
  assert.equal(formatQueueError("string error"), "");
  assert.equal(formatQueueError(null), "");
  assert.equal(formatQueueError(42), "");
  assert.equal(formatQueueError(undefined), "");
});

// --- processFindingActions tests ---

test("Fix and Fix-custom queue follow-up messages, continue to next finding, and avoid per-item success toasts", async () => {
  const sent: SendCall[] = [];
  const pi = createMockMessenger(sent);

  let waitForIdleCalls = 0;
  const { ctx, notifications } = createMockUiContext();
  const ctxWithIdle = {
    ...ctx,
    waitForIdle: async () => {
      waitForIdleCalls += 1;
    },
  };

  const findings: Finding[] = [
    testFinding("First issue"),
    testFinding("Second issue"),
  ];

  let showCalls = 0;
  const actions = [
    { type: "fix" as const },
    { type: "fix-custom" as const, instructions: "Use a guard" },
  ];

  const buildFixMessageCalls: Array<{
    finding: Finding;
    customInstructions: string | undefined;
  }> = [];
  const result = await processFindingActions({
    pi,
    ctx: ctxWithIdle,
    findings,
    showFinding: async () => actions[showCalls++]!,
    buildFixMessage: (finding: Finding, customInstructions?: string) => {
      buildFixMessageCalls.push({ finding, customInstructions });
      return customInstructions
        ? `fix:${finding.title}:${customInstructions}`
        : `fix:${finding.title}`;
    },
  });

  assert.equal(result.queuedFixCount, 2);
  assert.equal(result.queueFailures, 0);
  assert.equal(result.stoppedAt, null);

  assert.equal(showCalls, 2, "review loop should continue to second finding");

  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], {
    message: "fix:First issue",
    options: { deliverAs: "followUp" },
  });
  assert.deepEqual(sent[1], {
    message: "fix:Second issue:Use a guard",
    options: { deliverAs: "followUp" },
  });

  assert.equal(waitForIdleCalls, 0, "fix queueing path must not call waitForIdle");

  assert.equal(buildFixMessageCalls.length, 2);
  assert.equal(buildFixMessageCalls[0]?.customInstructions, undefined);
  assert.equal(buildFixMessageCalls[1]?.customInstructions, "Use a guard");

  assert.equal(
    notifications.length,
    0,
    "all-success path should avoid per-item success notifications",
  );
});

test("Process finding actions still emits per-item error notifications for failed queues", async () => {
  const pi: FollowUpMessenger = {
    async sendUserMessage(message: string) {
      if (String(message).includes("Second")) {
        throw new Error("busy");
      }
    },
  };

  const { ctx, notifications } = createMockUiContext();

  const findings: Finding[] = [
    testFinding("First issue"),
    testFinding("Second issue"),
  ];
  const actions = [{ type: "fix" as const }, { type: "fix" as const }];
  let showCalls = 0;

  const result = await processFindingActions({
    pi,
    ctx,
    findings,
    showFinding: async () => actions[showCalls++]!,
    buildFixMessage: (finding: Finding) => `fix:${finding.title}`,
  });

  assert.equal(result.queuedFixCount, 1);
  assert.equal(result.queueFailures, 1);

  assert.ok(
    notifications.some(
      (n) =>
        n.level === "error" &&
        n.message === "Failed to queue fix: Second issue (busy)",
    ),
  );
});

// --- processFindingActions skip action (Finding 3) ---

test("processFindingActions skips findings when action is skip", async () => {
  const sent: SendCall[] = [];
  const pi = createMockMessenger(sent);
  const { ctx } = createMockUiContext();

  const findings: Finding[] = [testFinding("A"), testFinding("B")];
  const actions = [{ type: "skip" as const }, { type: "fix" as const }];
  let i = 0;
  const result = await processFindingActions({
    pi,
    ctx,
    findings,
    showFinding: async () => actions[i++]!,
    buildFixMessage: (f: Finding) => `fix:${f.title}`,
  });
  assert.equal(result.queuedFixCount, 1);
  assert.equal(result.stoppedAt, null);
  assert.equal(sent.length, 1);
  assert.match(sent[0]!.message, /fix:B/);
});

// --- processFindingActions stop action (Finding 4) ---

test("processFindingActions stops at correct index when action is stop", async () => {
  const sent: SendCall[] = [];
  const pi = createMockMessenger(sent);
  const { ctx } = createMockUiContext();

  const findings: Finding[] = [
    testFinding("A"),
    testFinding("B"),
    testFinding("C"),
  ];
  const actions = [
    { type: "fix" as const },
    { type: "stop" as const },
    { type: "fix" as const },
  ];
  let i = 0;
  const result = await processFindingActions({
    pi,
    ctx,
    findings,
    showFinding: async () => actions[i++]!,
    buildFixMessage: (f: Finding) => `fix:${f.title}`,
  });
  assert.equal(result.stoppedAt, 1);
  assert.equal(result.queuedFixCount, 1);
  assert.equal(sent.length, 1);
});

// --- notifyQueueSummary tests ---

test("Queue summary notifications are correct for success/failure scenarios", () => {
  const cases = [
    {
      name: "all queue attempts succeed",
      result: { queuedFixCount: 2, queueFailures: 0 },
      expected: {
        message:
          "Queued 2 follow-up fix requests. They will run while you continue reviewing.",
        level: "info" as const,
      },
    },
    {
      name: "partial failures",
      result: { queuedFixCount: 1, queueFailures: 1 },
      expected: {
        message:
          "Queued 1 follow-up fix request. They will run while you continue reviewing.",
        level: "warning" as const,
      },
    },
    {
      name: "all failures",
      result: { queuedFixCount: 0, queueFailures: 2 },
      expected: {
        message: "No fixes were queued due to send errors",
        level: "error" as const,
      },
    },
    {
      name: "no fix actions selected",
      result: { queuedFixCount: 0, queueFailures: 0 },
      expected: null,
    },
  ];

  for (const c of cases) {
    const { ctx, notifications } = createMockUiContext();

    notifyQueueSummary(ctx, c.result);

    if (c.expected === null) {
      assert.equal(
        notifications.length,
        0,
        `${c.name}: expected no summary notification`,
      );
      continue;
    }

    assert.equal(
      notifications.length,
      1,
      `${c.name}: expected exactly one summary notification`,
    );
    assert.deepEqual(notifications[0], c.expected, `${c.name}: summary mismatch`);
  }
});
