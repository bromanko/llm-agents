import test from "node:test";
import assert from "node:assert/strict";

import { createMockExtensionAPI, type ExecResult } from "../helpers.ts";
import autoresearchExtension, {
  formatDelta,
  formatMetric,
  parseInlineConfig,
} from "../../pi/autoresearch/extensions/index.ts";
import type {
  AutoresearchState,
  IterationStatus,
} from "../../pi/autoresearch/extensions/types.ts";

type AutoresearchPi = Parameters<typeof autoresearchExtension>[0];

type NotificationLevel = "info" | "warning" | "error" | "success";

type SessionEntry = {
  type: string;
  customType?: string;
  data?: unknown;
};

interface RegisteredCommand {
  description?: string;
  handler(args: string, ctx: MockContext): Promise<void>;
}

interface AutoresearchLogParams {
  iteration: number;
  commit: string;
  metric: number;
  status: IterationStatus;
  description: string;
}

interface ToolTextContent {
  type: "text";
  text: string;
}

interface ToolExecuteResult {
  content: ToolTextContent[];
  details: {
    result?: unknown;
    state?: AutoresearchState;
  };
}

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: (() => void) | undefined,
    ctx: MockContext,
  ): Promise<ToolExecuteResult>;
}

interface MockContext {
  hasUI: boolean;
  cwd: string;
  sessionManager: {
    getEntries(): SessionEntry[];
  };
  ui: {
    theme: {
      fg(color: string, text: string): string;
      bold(text: string): string;
    };
    notify(message: string, level: NotificationLevel): void;
    input(prompt: string, defaultValue?: string): Promise<string | undefined>;
    select(prompt: string, options: string[]): Promise<string | undefined>;
    confirm(title: string, message: string): Promise<boolean>;
    setStatus(key: string, value: string | undefined): void;
    setWidget(key: string, value: string[] | undefined): void;
  };
}

function okResult(stdout = ""): ExecResult {
  return { code: 0, stdout, stderr: "", killed: false };
}

function makeInlineConfig(overrides: Partial<{
  goal: string;
  scope: string;
  metric: string;
  direction: "higher" | "lower";
  verify: string;
  guard: string;
  iterations: string;
}> = {}): string {
  const lines = [
    `goal: ${overrides.goal ?? "Improve coverage"}`,
    `scope: ${overrides.scope ?? "src/**/*.ts"}`,
    `metric: ${overrides.metric ?? "Coverage %"}`,
    `direction: ${overrides.direction ?? "higher"}`,
    `verify: ${overrides.verify ?? "npm test"}`,
  ];

  if (overrides.guard !== undefined) {
    lines.push(`guard: ${overrides.guard}`);
  }
  if (overrides.iterations !== undefined) {
    lines.push(`iterations: ${overrides.iterations}`);
  }

  return lines.join("\n");
}

function createContext(sessionEntries: SessionEntry[] = []) {
  const notifications: Array<{ message: string; level: NotificationLevel }> = [];
  const statusUpdates: Array<{ key: string; value: string | undefined }> = [];
  const widgetUpdates: Array<{ key: string; value: string[] | undefined }> = [];
  const inputCalls: Array<{ prompt: string; defaultValue?: string }> = [];
  const selectCalls: Array<{ prompt: string; options: string[] }> = [];
  const confirmCalls: Array<{ title: string; message: string }> = [];
  const inputQueue: Array<string | undefined> = [];
  const selectQueue: Array<string | undefined> = [];
  const confirmQueue: boolean[] = [];

  const ctx: MockContext = {
    hasUI: true,
    cwd: process.cwd(),
    sessionManager: {
      getEntries() {
        return sessionEntries;
      },
    },
    ui: {
      theme: {
        fg(_color: string, text: string) {
          return text;
        },
        bold(text: string) {
          return text;
        },
      },
      notify(message: string, level: NotificationLevel) {
        notifications.push({ message, level });
      },
      async input(prompt: string, defaultValue?: string) {
        inputCalls.push({ prompt, defaultValue });
        return inputQueue.shift();
      },
      async select(prompt: string, options: string[]) {
        selectCalls.push({ prompt, options });
        return selectQueue.shift();
      },
      async confirm(title: string, message: string) {
        confirmCalls.push({ title, message });
        return confirmQueue.shift() ?? false;
      },
      setStatus(key: string, value: string | undefined) {
        statusUpdates.push({ key, value });
      },
      setWidget(key: string, value: string[] | undefined) {
        widgetUpdates.push({ key, value });
      },
    },
  };

  return {
    ctx,
    notifications,
    statusUpdates,
    widgetUpdates,
    inputCalls,
    selectCalls,
    confirmCalls,
    inputQueue,
    selectQueue,
    confirmQueue,
  };
}

function setupExtension(sessionEntries: SessionEntry[] = []) {
  const pi = createMockExtensionAPI();
  const commands = new Map<string, RegisteredCommand>();
  const tools = new Map<string, RegisteredTool>();
  const userMessages: Array<{ message: string; options: unknown }> = [];
  const messages: Array<{ message: any; options: unknown }> = [];
  const appendedEntries: Array<{ customType: string; data: unknown }> = [];

  pi.registerCommand = (name: string, command: RegisteredCommand) => {
    commands.set(name, command);
  };
  pi.registerTool = (tool: RegisteredTool) => {
    tools.set(tool.name, tool);
  };
  pi.sendUserMessage = async (message: string, options?: unknown) => {
    userMessages.push({ message, options });
  };
  pi.sendMessage = (message: unknown, options?: unknown) => {
    messages.push({ message, options });
  };
  pi.appendEntry = (customType: string, data?: unknown) => {
    appendedEntries.push({ customType, data });
  };
  pi.execMock.fn = async (command, args = []) => {
    if (command === "git" && args[0] === "rev-parse") return okResult(".git\n");
    if (command === "git" && args[0] === "status") return okResult("");
    if (command === "find") return okResult("");
    return okResult("");
  };

  autoresearchExtension(pi as unknown as AutoresearchPi);

  return {
    pi,
    commands,
    tools,
    userMessages,
    messages,
    appendedEntries,
    ...createContext(sessionEntries),
  };
}

async function startAutoresearch(
  harness: ReturnType<typeof setupExtension>,
  config: string = makeInlineConfig({ iterations: "5" }),
): Promise<void> {
  const command = harness.commands.get("autoresearch");
  assert.ok(command, "autoresearch command should be registered");
  await command.handler(config, harness.ctx);
}

async function logResult(
  harness: ReturnType<typeof setupExtension>,
  params: AutoresearchLogParams,
) {
  const tool = harness.tools.get("autoresearch_log");
  assert.ok(tool, "autoresearch_log tool should be registered");
  return tool.execute("tc-1", params, undefined, undefined, harness.ctx);
}

test("parseInlineConfig handles multiline input, explicit direction, and invalid iterations", () => {
  const parsed = parseInlineConfig(`
    goal: Reduce latency
    scope: src/**/*.ts, test/**/*.ts
    metric: p95 latency ms
    direction: lower
    verify: npm run bench
    guard: npm test
    iterations: 0
  `);

  assert.deepEqual(parsed, {
    goal: "Reduce latency",
    scope: ["src/**/*.ts", "test/**/*.ts"],
    metric: "p95 latency ms",
    direction: "lower",
    verify: "npm run bench",
    guard: "npm test",
    maxIterations: undefined,
  });

  const defaults = parseInlineConfig(`goal: Improve tests\nverify: npm test`);
  assert.deepEqual(defaults, {
    goal: "Improve tests",
    scope: ["src/**/*"],
    metric: "metric",
    direction: "higher",
    verify: "npm test",
    guard: undefined,
    maxIterations: undefined,
  });
});

test("parseInlineConfig rejects blank required fields and non-positive iterations", () => {
  assert.equal(parseInlineConfig(`goal:   \nverify: npm test`), null);
  assert.equal(parseInlineConfig(`goal: Improve tests\nverify:   `), null);
  assert.equal(
    parseInlineConfig(`goal: Improve tests\nverify: npm test\niterations: -3`)?.maxIterations,
    undefined,
  );
  assert.equal(
    parseInlineConfig(`goal: Improve tests\nverify: npm test\niterations: abc`)?.maxIterations,
    undefined,
  );
});

test("formatMetric and formatDelta cover boundary cases", () => {
  assert.equal(formatMetric(0), "0");
  assert.equal(formatMetric(1.23456789), "1.234568");
  assert.equal(formatDelta(0, "higher"), "0.000000");
  assert.equal(formatDelta(0.5, "higher"), "+0.500000 ✓");
  assert.equal(formatDelta(-0.5, "higher"), "-0.500000");
  assert.equal(formatDelta(-0.5, "lower"), "-0.500000 ✓");
  assert.equal(formatDelta(0.5, "lower"), "+0.500000");
});

test("/autoresearch starts the loop, sends the initial protocol prompt, and refuses a second start", async () => {
  const harness = setupExtension();

  await startAutoresearch(harness);
  assert.equal(harness.userMessages.length, 1, "initial protocol should be queued");
  assert.match(harness.userMessages[0]!.message, /Autoresearch — Autonomous Loop Protocol/);
  assert.match(harness.userMessages[0]!.message, /Improve coverage/);

  await startAutoresearch(harness);
  assert.ok(
    harness.notifications.some((n) => n.level === "warning" && n.message.includes("already running")),
    `Expected already-running warning, got ${JSON.stringify(harness.notifications)}`,
  );
});

test("/autoresearch treats failed git rev-parse as not-a-repo even if stdout is populated", async () => {
  const harness = setupExtension();
  harness.pi.execMock.fn = async (command, args = []) => {
    if (command === "git" && args[0] === "rev-parse") {
      return { code: 1, stdout: ".git\n", stderr: "fatal: not a git repository", killed: false };
    }
    if (command === "git" && args[0] === "status") return okResult("");
    if (command === "find") return okResult("");
    return okResult("");
  };

  await startAutoresearch(harness);

  assert.equal(harness.userMessages.length, 0, "loop must not start outside git");
  assert.ok(
    harness.notifications.some((n) => n.level === "error" && n.message.includes("Not a git repository")),
  );
});

test("/autoresearch handles dirty working tree confirmation branches", async () => {
  const declineHarness = setupExtension();
  declineHarness.pi.execMock.fn = async (command, args = []) => {
    if (command === "git" && args[0] === "rev-parse") return okResult(".git\n");
    if (command === "git" && args[0] === "status") return okResult(" M src/main.ts\n");
    if (command === "find") return okResult("");
    return okResult("");
  };
  declineHarness.confirmQueue.push(false);

  await startAutoresearch(declineHarness);
  assert.equal(declineHarness.userMessages.length, 0, "loop should not start when user declines dirty-tree confirmation");
  assert.equal(declineHarness.confirmCalls.length, 1);

  const acceptHarness = setupExtension();
  acceptHarness.pi.execMock.fn = async (command, args = []) => {
    if (command === "git" && args[0] === "rev-parse") return okResult(".git\n");
    if (command === "git" && args[0] === "status") return okResult(" M src/main.ts\n");
    if (command === "find") return okResult("");
    return okResult("");
  };
  acceptHarness.confirmQueue.push(true);

  await startAutoresearch(acceptHarness);
  assert.equal(acceptHarness.userMessages.length, 1, "loop should start when user accepts dirty-tree confirmation");
});

test("/autoresearch surfaces non-interactive wizard failure without prompting", async () => {
  const harness = setupExtension();
  harness.ctx.hasUI = false;

  const command = harness.commands.get("autoresearch");
  assert.ok(command);
  await command.handler("", harness.ctx);

  assert.equal(harness.userMessages.length, 0);
  assert.equal(harness.inputCalls.length, 0);
  assert.equal(harness.selectCalls.length, 0);
  assert.ok(
    harness.notifications.some((n) => n.level === "error" && n.message.includes("Setup wizard requires interactive mode")),
  );
});

test("agent_end continues only after autoresearch_log ran in that cycle", async () => {
  const harness = setupExtension();
  await startAutoresearch(harness);

  const agentStart = harness.pi.getHandlers("agent_start")[0];
  const agentEnd = harness.pi.getHandlers("agent_end")[0];
  assert.ok(agentStart);
  assert.ok(agentEnd);

  await agentStart({}, harness.ctx);
  await agentEnd({}, harness.ctx);
  assert.equal(harness.userMessages.length, 1, "no continuation without a logged result");

  await logResult(harness, {
    iteration: 0,
    commit: "abcdef0",
    metric: 10,
    status: "baseline",
    description: "establish baseline",
  });

  await agentEnd({}, harness.ctx);
  assert.equal(harness.userMessages.length, 2, "continuation should be queued after logging");
  assert.match(harness.userMessages[1]!.message, /Continue the autoresearch loop/);
  assert.match(harness.userMessages[1]!.message, /Last: baseline/);
});

test("hitting maxIterations stops the loop and prints a summary instead of continuing", async () => {
  const harness = setupExtension();
  await startAutoresearch(harness, makeInlineConfig({ iterations: "1" }));

  const agentStart = harness.pi.getHandlers("agent_start")[0];
  const agentEnd = harness.pi.getHandlers("agent_end")[0];
  assert.ok(agentStart);
  assert.ok(agentEnd);

  await logResult(harness, {
    iteration: 0,
    commit: "aaaaaaa",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });
  await agentEnd({}, harness.ctx);
  assert.equal(harness.userMessages.length, 2, "baseline should schedule iteration 1");

  await agentStart({}, harness.ctx);
  await logResult(harness, {
    iteration: 1,
    commit: "bbbbbbb",
    metric: 11,
    status: "keep",
    description: "small improvement",
  });
  await agentEnd({}, harness.ctx);

  assert.equal(harness.userMessages.length, 2, "bounded run should stop instead of continuing");
  assert.equal(harness.messages.length, 1, "summary should be emitted when max iterations are reached");
  assert.match(harness.messages[0]!.message.content, /Autoresearch Complete/);
  assert.match(harness.messages[0]!.message.content, /Best iteration: #1/);
  assert.equal(harness.statusUpdates.at(-1)?.value, "🔬 stopped");
});

test("session_start restores valid persisted state, stops a running session, and ignores invalid state", async () => {
  const validState = {
    config: {
      goal: "Persisted goal",
      scope: ["src/**/*.ts"],
      metric: "Coverage",
      direction: "higher",
      verify: "npm test",
      maxIterations: 5,
    },
    running: true,
    currentIteration: 2,
    baseline: 10,
    bestMetric: 12,
    results: [
      {
        iteration: 0,
        commit: "aaaaaaa",
        metric: 10,
        delta: 0,
        status: "baseline",
        description: "baseline",
      },
      {
        iteration: 1,
        commit: "bbbbbbb",
        metric: 12,
        delta: 2,
        status: "keep",
        description: "improvement",
      },
    ],
  };

  const runningHarness = setupExtension([
    { type: "custom", customType: "autoresearch-state", data: validState },
  ]);
  const sessionStart = runningHarness.pi.getHandlers("session_start")[0];
  assert.ok(sessionStart);

  await sessionStart({}, runningHarness.ctx);

  assert.ok(
    runningHarness.notifications.some((n) => n.message.includes("restored (stopped)")),
    `Expected restore notification, got ${JSON.stringify(runningHarness.notifications)}`,
  );
  assert.equal(runningHarness.statusUpdates.at(-1)?.value, "🔬 stopped");
  assert.equal((runningHarness.appendedEntries.at(-1)?.data as AutoresearchState | undefined)?.running, false);

  const invalidHarness = setupExtension([
    {
      type: "custom",
      customType: "autoresearch-state",
      data: { running: true, results: "bad-data" },
    },
  ]);
  const invalidSessionStart = invalidHarness.pi.getHandlers("session_start")[0];
  assert.ok(invalidSessionStart);
  await invalidSessionStart({}, invalidHarness.ctx);

  const statusCommand = invalidHarness.commands.get("autoresearch:status");
  assert.ok(statusCommand);
  await statusCommand.handler("", invalidHarness.ctx);
  assert.ok(
    invalidHarness.notifications.some((n) => n.message.includes("No autoresearch session")),
    `Expected invalid persisted state to be ignored, got ${JSON.stringify(invalidHarness.notifications)}`,
  );
});

test("session_start restores the newest valid autoresearch-state entry", async () => {
  const olderState = {
    config: {
      goal: "Older goal",
      scope: ["src/**/*.ts"],
      metric: "Coverage",
      direction: "higher" as const,
      verify: "npm test",
      maxIterations: 5,
    },
    running: false,
    currentIteration: 1,
    baseline: 10,
    bestMetric: 11,
    results: [
      {
        iteration: 0,
        commit: "aaaaaaa",
        metric: 10,
        delta: 0,
        status: "baseline" as const,
        description: "baseline",
      },
      {
        iteration: 1,
        commit: "bbbbbbb",
        metric: 11,
        delta: 1,
        status: "keep" as const,
        description: "older keep",
      },
    ],
  };
  const newerState = {
    config: {
      goal: "Newer goal",
      scope: ["src/**/*.ts"],
      metric: "Coverage",
      direction: "higher" as const,
      verify: "npm test",
      maxIterations: 5,
    },
    running: false,
    currentIteration: 2,
    baseline: 10,
    bestMetric: 12,
    results: [
      {
        iteration: 0,
        commit: "aaaaaaa",
        metric: 10,
        delta: 0,
        status: "baseline" as const,
        description: "baseline",
      },
      {
        iteration: 1,
        commit: "bbbbbbb",
        metric: 11,
        delta: 1,
        status: "keep" as const,
        description: "older keep",
      },
      {
        iteration: 2,
        commit: "ccccccc",
        metric: 12,
        delta: 2,
        status: "keep" as const,
        description: "newer keep",
      },
    ],
  };

  const harness = setupExtension([
    { type: "custom", customType: "other-entry", data: { ignore: true } },
    { type: "custom", customType: "autoresearch-state", data: olderState },
    { type: "custom", customType: "different-custom", data: { ignore: true } },
    { type: "custom", customType: "autoresearch-state", data: newerState },
  ]);
  const sessionStart = harness.pi.getHandlers("session_start")[0];
  assert.ok(sessionStart);
  await sessionStart({}, harness.ctx);

  const statusCommand = harness.commands.get("autoresearch:status");
  assert.ok(statusCommand);
  await statusCommand.handler("", harness.ctx);
  const statusText = harness.notifications.at(-1)?.message ?? "";
  assert.match(statusText, /Goal: Newer goal/);
  assert.match(statusText, /Best: 12.000000/);
  assert.doesNotMatch(statusText, /Goal: Older goal/);
});

test("session_start falls back to an older valid state when the newest matching entry is invalid", async () => {
  const validState = {
    config: {
      goal: "Valid goal",
      scope: ["src/**/*.ts"],
      metric: "Coverage",
      direction: "higher" as const,
      verify: "npm test",
      maxIterations: 5,
    },
    running: false,
    currentIteration: 1,
    baseline: 10,
    bestMetric: 11,
    results: [
      {
        iteration: 0,
        commit: "aaaaaaa",
        metric: 10,
        delta: 0,
        status: "baseline" as const,
        description: "baseline",
      },
      {
        iteration: 1,
        commit: "bbbbbbb",
        metric: 11,
        delta: 1,
        status: "keep" as const,
        description: "keep",
      },
    ],
  };

  const harness = setupExtension([
    { type: "custom", customType: "autoresearch-state", data: validState },
    { type: "custom", customType: "autoresearch-state", data: { running: true, results: "bad-data" } },
  ]);
  const sessionStart = harness.pi.getHandlers("session_start")[0];
  assert.ok(sessionStart);
  await sessionStart({}, harness.ctx);

  const statusCommand = harness.commands.get("autoresearch:status");
  assert.ok(statusCommand);
  await statusCommand.handler("", harness.ctx);
  const statusText = harness.notifications.at(-1)?.message ?? "";
  assert.match(statusText, /Goal: Valid goal/);
  assert.match(statusText, /Best: 11.000000/);
});

test("/autoresearch:stop persists state, updates the UI, and emits the summary", async () => {
  const harness = setupExtension();
  await startAutoresearch(harness);
  await logResult(harness, {
    iteration: 0,
    commit: "aaaaaaa",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });

  const stopCommand = harness.commands.get("autoresearch:stop");
  assert.ok(stopCommand);
  const appendCountBefore = harness.appendedEntries.length;

  await stopCommand.handler("", harness.ctx);

  assert.equal(harness.appendedEntries.length, appendCountBefore + 1, "stop should persist updated state");
  assert.equal(harness.statusUpdates.at(-1)?.value, "🔬 stopped");
  assert.equal(harness.messages.length, 1, "summary output should be emitted");
  assert.match(harness.messages[0]!.message.content, /No improvements found\./);
  assert.ok(harness.notifications.some((n) => n.message === "Autoresearch stopped."));
});

test("autoresearch_log updates decision state correctly across statuses and directions", async () => {
  const cases: Array<{
    direction: "higher" | "lower";
    baseline: number;
    status: IterationStatus;
    metric: number;
    iteration: number;
    expectedBest: number;
    expectedMetricText: string;
    expectedRemaining: string;
  }> = [
      {
        direction: "higher" as const,
        baseline: 10,
        status: "baseline",
        metric: 10,
        iteration: 0,
        expectedBest: 10,
        expectedMetricText: "Metric: 10.000000 (0.000000)",
        expectedRemaining: "Remaining: 5",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "keep",
        metric: 12,
        iteration: 1,
        expectedBest: 12,
        expectedMetricText: "Metric: 12.000000 (+2.000000 ✓)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "keep",
        metric: 9,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 9.000000 (-1.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "keep (reworked)",
        metric: 11,
        iteration: 1,
        expectedBest: 11,
        expectedMetricText: "Metric: 11.000000 (+1.000000 ✓)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "discard",
        metric: 8,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 8.000000 (-2.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "crash",
        metric: 0,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: crash",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "no-op",
        metric: 10,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 10.000000 (0.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "higher" as const,
        baseline: 10,
        status: "hook-blocked",
        metric: 10,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 10.000000 (0.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "keep",
        metric: 8,
        iteration: 1,
        expectedBest: 8,
        expectedMetricText: "Metric: 8.000000 (-2.000000 ✓)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "keep",
        metric: 11,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 11.000000 (+1.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "keep (reworked)",
        metric: 9,
        iteration: 1,
        expectedBest: 9,
        expectedMetricText: "Metric: 9.000000 (-1.000000 ✓)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "discard",
        metric: 12,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 12.000000 (+2.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "crash",
        metric: 0,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: crash",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "no-op",
        metric: 10,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 10.000000 (0.000000)",
        expectedRemaining: "Remaining: 4",
      },
      {
        direction: "lower" as const,
        baseline: 10,
        status: "hook-blocked",
        metric: 10,
        iteration: 1,
        expectedBest: 10,
        expectedMetricText: "Metric: 10.000000 (0.000000)",
        expectedRemaining: "Remaining: 4",
      },
    ];

  for (const row of cases) {
    const harness = setupExtension();
    await startAutoresearch(
      harness,
      makeInlineConfig({ direction: row.direction, iterations: "5" }),
    );

    const baselineResult = await logResult(harness, {
      iteration: 0,
      commit: "base000",
      metric: row.baseline,
      status: "baseline",
      description: "baseline",
    });

    if (row.status === "baseline") {
      const baselineState = baselineResult.details.state;
      if (!baselineState) throw new Error("expected tool response state for baseline");
      assert.equal(baselineState.baseline, row.baseline);
      assert.equal(baselineState.bestMetric, row.expectedBest);
      assert.equal(baselineState.currentIteration, 0);
      assert.match(baselineResult.content[0].text, /Iteration #0 logged: baseline/);
      assert.match(baselineResult.content[0].text, /Keeps: 0 \| Discards: 0 \| Remaining: 5/);
      continue;
    }

    const appendCountBefore = harness.appendedEntries.length;
    const statusCountBefore = harness.statusUpdates.length;
    const result = await logResult(harness, {
      iteration: row.iteration,
      commit: "iter001",
      metric: row.metric,
      status: row.status,
      description: `case ${row.status}`,
    });

    const resultState = result.details.state;
    if (!resultState) throw new Error("expected tool response state");
    assert.equal(harness.appendedEntries.length, appendCountBefore + 1, `${row.direction}/${row.status} should persist`);
    assert.ok(harness.statusUpdates.length > statusCountBefore, `${row.direction}/${row.status} should refresh UI`);
    assert.equal(resultState.bestMetric, row.expectedBest, `${row.direction}/${row.status} best metric mismatch`);
    assert.equal(resultState.currentIteration, row.iteration, `${row.direction}/${row.status} iteration mismatch`);
    assert.match(result.content[0].text, new RegExp(`Iteration #${row.iteration} logged: ${row.status.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(result.content[0].text, new RegExp(row.expectedMetricText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.content[0].text, new RegExp(row.expectedRemaining.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("autoresearch_log rejects inconsistent iteration sequences and status/metric combinations", async () => {
  const beforeBaseline = setupExtension();
  await startAutoresearch(beforeBaseline);
  const beforeBaselineResult = await logResult(beforeBaseline, {
    iteration: 1,
    commit: "iter001",
    metric: 12,
    status: "keep",
    description: "should fail before baseline",
  });
  assert.match(beforeBaselineResult.content[0]!.text, /Baseline must be established/);
  assert.equal(beforeBaseline.appendedEntries.length, 1, "invalid log must not persist state");

  const duplicateIteration = setupExtension();
  await startAutoresearch(duplicateIteration);
  await logResult(duplicateIteration, {
    iteration: 0,
    commit: "base000",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });
  const duplicateIterationResult = await logResult(duplicateIteration, {
    iteration: 0,
    commit: "dupe000",
    metric: 10,
    status: "no-op",
    description: "duplicate iteration",
  });
  assert.match(duplicateIterationResult.content[0]!.text, /Expected iteration 1, received 0/);
  assert.equal(duplicateIteration.appendedEntries.length, 2, "duplicate iteration must not persist");

  const duplicateBaseline = setupExtension();
  await startAutoresearch(duplicateBaseline);
  await logResult(duplicateBaseline, {
    iteration: 0,
    commit: "base000",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });
  const duplicateBaselineResult = await logResult(duplicateBaseline, {
    iteration: 1,
    commit: "base001",
    metric: 11,
    status: "baseline",
    description: "duplicate baseline",
  });
  assert.match(duplicateBaselineResult.content[0]!.text, /baseline.*only valid|baseline.*only be logged once/i);

  const invalidCrash = setupExtension();
  await startAutoresearch(invalidCrash);
  await logResult(invalidCrash, {
    iteration: 0,
    commit: "base000",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });
  const invalidCrashResult = await logResult(invalidCrash, {
    iteration: 1,
    commit: "boom000",
    metric: 5,
    status: "crash",
    description: "invalid crash metric",
  });
  assert.match(invalidCrashResult.content[0]!.text, /Status "crash" requires metric 0/);
});

test("status/widget/summary formatting handles empty, running, stopped, crash, and truncation cases", async () => {
  const emptyHarness = setupExtension();
  const sessionSwitch = emptyHarness.pi.getHandlers("session_switch")[0];
  assert.ok(sessionSwitch);
  await sessionSwitch({}, emptyHarness.ctx);
  assert.equal(emptyHarness.statusUpdates.at(-1)?.value, undefined);
  assert.equal(emptyHarness.widgetUpdates.at(-1)?.value, undefined);

  const harness = setupExtension();
  await startAutoresearch(harness, makeInlineConfig({ iterations: "3" }));

  const statusCommand = harness.commands.get("autoresearch:status");
  assert.ok(statusCommand);
  await statusCommand.handler("", harness.ctx);
  assert.ok(
    harness.notifications.some((n) => n.message.includes("Status: RUNNING") && n.message.includes("Recent results:")),
  );

  await logResult(harness, {
    iteration: 0,
    commit: "base000",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });
  await logResult(harness, {
    iteration: 1,
    commit: "boom000",
    metric: 0,
    status: "crash",
    description: "this is a very long description that should be truncated in the widget output for readability",
  });
  await logResult(harness, {
    iteration: 2,
    commit: "keep000",
    metric: 12,
    status: "keep",
    description: "kept variant",
  });

  const widget = harness.widgetUpdates.at(-1)?.value?.join("\n") ?? "";
  assert.match(widget, /Autoresearch Progress/);
  assert.match(widget, /crash/);
  assert.match(widget, /\.\.\./, "long descriptions should be truncated");
  assert.equal(harness.statusUpdates.at(-1)?.value?.includes("1💥"), true, "running status should include crash count");

  await statusCommand.handler("", harness.ctx);
  const populatedStatus = harness.notifications.at(-1)?.message ?? "";
  assert.match(populatedStatus, /Status: RUNNING/);
  assert.match(populatedStatus, /Keeps: 1 \| Discards: 0 \| Crashes: 1/);
  assert.match(populatedStatus, /💥 #1 crash crash —/);
  assert.doesNotMatch(populatedStatus, /💥 #1 0 crash —/);

  const stopCommand = harness.commands.get("autoresearch:stop");
  assert.ok(stopCommand);
  await stopCommand.handler("", harness.ctx);
  assert.equal(harness.statusUpdates.at(-1)?.value, "🔬 stopped");
  assert.match(harness.messages.at(-1)!.message.content, /Best iteration: #2 — kept variant/);

  const noKeepHarness = setupExtension();
  await startAutoresearch(noKeepHarness, makeInlineConfig({ iterations: "2" }));
  await logResult(noKeepHarness, {
    iteration: 0,
    commit: "base000",
    metric: 10,
    status: "baseline",
    description: "baseline",
  });
  await logResult(noKeepHarness, {
    iteration: 1,
    commit: "drop000",
    metric: 9,
    status: "discard",
    description: "regression",
  });
  const noKeepStop = noKeepHarness.commands.get("autoresearch:stop");
  assert.ok(noKeepStop);
  await noKeepStop.handler("", noKeepHarness.ctx);
  assert.match(noKeepHarness.messages.at(-1)!.message.content, /No improvements found\./);
});

test("wizard cancellation paths return without launching and custom metric/custom iteration flows behave correctly", async () => {
  const goalCancel = setupExtension();
  goalCancel.inputQueue.push(undefined);
  const planCommand1 = goalCancel.commands.get("autoresearch:plan");
  assert.ok(planCommand1);
  await planCommand1.handler("", goalCancel.ctx);
  assert.equal(goalCancel.userMessages.length, 0);

  const directionCancel = setupExtension();
  directionCancel.inputQueue.push("Improve perf", "src/**/*.ts", "Latency", "npm run bench");
  directionCancel.selectQueue.push("Custom metric...", undefined);
  const planCommand2 = directionCancel.commands.get("autoresearch:plan");
  assert.ok(planCommand2);
  await planCommand2.handler("", directionCancel.ctx);
  assert.equal(directionCancel.userMessages.length, 0);

  const iterationsCancel = setupExtension();
  iterationsCancel.inputQueue.push("Improve perf", "src/**/*.ts", "npm run bench", undefined);
  iterationsCancel.selectQueue.push(
    "Benchmark time ms (lower is better)",
    "Skip — no guard",
    "Custom...",
  );
  const planCommand3 = iterationsCancel.commands.get("autoresearch:plan");
  assert.ok(planCommand3);
  await planCommand3.handler("", iterationsCancel.ctx);
  assert.equal(iterationsCancel.userMessages.length, 0);

  const customMetric = setupExtension();
  customMetric.inputQueue.push("Improve perf", "src/**/*.ts", "Latency", "npm run bench");
  customMetric.selectQueue.push(
    "Custom metric...",
    "Lower is better",
    "Skip — no guard",
    "5 iterations",
  );
  customMetric.confirmQueue.push(true);
  const planCommand4 = customMetric.commands.get("autoresearch");
  assert.ok(planCommand4);
  await planCommand4.handler("", customMetric.ctx);
  assert.equal(customMetric.userMessages.length, 1);
  assert.match(customMetric.userMessages[0]!.message, /\*\*Metric:\*\* Latency \(lower is better\)/);

  const customIterations = setupExtension();
  customIterations.inputQueue.push("Improve perf", "src/**/*.ts", "npm run bench", "0");
  customIterations.selectQueue.push(
    "Benchmark time ms (lower is better)",
    "Skip — no guard",
    "Custom...",
  );
  customIterations.confirmQueue.push(true);
  const planCommand5 = customIterations.commands.get("autoresearch");
  assert.ok(planCommand5);
  await planCommand5.handler("", customIterations.ctx);
  assert.equal(customIterations.userMessages.length, 1);
  assert.match(customIterations.userMessages[0]!.message, /BOUNDED run: 25 iterations/);
});

test("wizard project detection selects expected default scope and verify commands for Node, Python, Rust, and Go", async () => {
  const cases = [
    {
      name: "node",
      findOutput: "./package.json\n",
      expectedScope: "src/**/*.ts",
      expectedVerify: "npm test -- --coverage 2>&1 | grep 'All files' | awk '{print $4}'",
    },
    {
      name: "python",
      findOutput: "./pyproject.toml\n",
      expectedScope: "**/*.py",
      expectedVerify: "pytest --cov=src --cov-report=term 2>&1 | grep TOTAL | awk '{print $4}'",
    },
    {
      name: "rust",
      findOutput: "./Cargo.toml\n",
      expectedScope: "src/**/*.rs",
      expectedVerify: "cargo test 2>&1 | grep -oP '\\d+ passed' | grep -oP '\\d+'",
    },
    {
      name: "go",
      findOutput: "./go.mod\n",
      expectedScope: "**/*.go",
      expectedVerify: "go test -count=1 ./... 2>&1 | grep -c '^ok'",
    },
  ];

  for (const row of cases) {
    const harness = setupExtension();
    harness.pi.execMock.fn = async (command, args = []) => {
      if (command === "git" && args[0] === "rev-parse") return okResult(".git\n");
      if (command === "git" && args[0] === "status") return okResult("");
      if (command === "find") return okResult(row.findOutput);
      return okResult("");
    };

    harness.inputQueue.push(
      "Goal",
      row.expectedScope,
      row.expectedVerify,
    );
    harness.selectQueue.push(
      "Test coverage % (higher is better)",
      "Skip — no guard",
      "5 iterations",
    );
    harness.confirmQueue.push(false);

    const command = harness.commands.get("autoresearch");
    assert.ok(command);
    await command.handler("", harness.ctx);

    const scopePrompt = harness.inputCalls.find((call) => call.prompt.includes("Which files can be modified"));
    const verifyPrompt = harness.inputCalls.find((call) => call.prompt.includes("Command that outputs the metric number"));
    assert.equal(scopePrompt?.defaultValue, row.expectedScope, `${row.name} scope default mismatch`);
    assert.equal(verifyPrompt?.defaultValue, row.expectedVerify, `${row.name} verify default mismatch`);
  }
});
