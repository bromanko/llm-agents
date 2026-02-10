import test from "node:test";
import assert from "node:assert/strict";

import {
  notifyQueueSummary,
  processFindingActions,
  queueFixFollowUp,
} from "./fix-flow.js";

test("queueFixFollowUp returns ok:true and uses followUp delivery on success", async () => {
  const calls = [];
  const pi = {
    async sendUserMessage(message, options) {
      calls.push({ message, options });
    },
  };

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
  const calls = [];
  const pi = {
    async sendUserMessage(message, options) {
      calls.push({ message, options });
      throw err;
    },
  };

  const result = await queueFixFollowUp(pi, "fix:Second issue");

  assert.equal(result.ok, false);
  assert.equal(result.error, err);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    message: "fix:Second issue",
    options: { deliverAs: "followUp" },
  });
});

test("Fix and Fix-custom queue follow-up messages, continue to next finding, and avoid per-item success toasts", async () => {
  const sent = [];
  const pi = {
    async sendUserMessage(message, options) {
      sent.push({ message, options });
    },
  };

  let waitForIdleCalls = 0;
  const notifications = [];
  const ctx = {
    waitForIdle: async () => {
      waitForIdleCalls += 1;
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  const findings = [
    { title: "First issue" },
    { title: "Second issue" },
  ];

  let showCalls = 0;
  const actions = [
    { type: "fix" },
    { type: "fix-custom", instructions: "Use a guard" },
  ];

  const buildFixMessageCalls = [];
  const result = await processFindingActions({
    pi,
    ctx,
    findings,
    showFinding: async () => actions[showCalls++],
    buildFixMessage: (finding, customInstructions) => {
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
  assert.equal(buildFixMessageCalls[0].customInstructions, undefined);
  assert.equal(buildFixMessageCalls[1].customInstructions, "Use a guard");

  assert.equal(
    notifications.length,
    0,
    "all-success path should avoid per-item success notifications",
  );
});

test("Process finding actions still emits per-item error notifications for failed queues", async () => {
  const pi = {
    async sendUserMessage(message) {
      if (String(message).includes("Second")) {
        throw new Error("busy");
      }
    },
  };

  const notifications = [];
  const ctx = {
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
    },
  };

  const findings = [{ title: "First issue" }, { title: "Second issue" }];
  const actions = [{ type: "fix" }, { type: "fix" }];
  let showCalls = 0;

  const result = await processFindingActions({
    pi,
    ctx,
    findings,
    showFinding: async () => actions[showCalls++],
    buildFixMessage: (finding) => `fix:${finding.title}`,
  });

  assert.equal(result.queuedFixCount, 1);
  assert.equal(result.queueFailures, 1);

  assert.ok(
    notifications.some(
      (n) => n.level === "error" && n.message === "Failed to queue fix: Second issue (busy)",
    ),
  );
});

test("Queue summary notifications are correct for success/failure scenarios", () => {
  const cases = [
    {
      name: "all queue attempts succeed",
      result: { queuedFixCount: 2, queueFailures: 0 },
      expected: {
        message: "Queued 2 follow-up fix requests. They will run while you continue reviewing.",
        level: "info",
      },
    },
    {
      name: "partial failures",
      result: { queuedFixCount: 1, queueFailures: 1 },
      expected: {
        message: "Queued 1 follow-up fix request. They will run while you continue reviewing.",
        level: "warning",
      },
    },
    {
      name: "all failures",
      result: { queuedFixCount: 0, queueFailures: 2 },
      expected: {
        message: "No fixes were queued due to send errors",
        level: "error",
      },
    },
    {
      name: "no fix actions selected",
      result: { queuedFixCount: 0, queueFailures: 0 },
      expected: null,
    },
  ];

  for (const c of cases) {
    const notifications = [];
    const ctx = {
      ui: {
        notify(message, level) {
          notifications.push({ message, level });
        },
      },
    };

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
