import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockExtensionAPI } from "../../test/helpers.ts";
import extension from "../../pi/session-stats/extensions/session-stats.ts";
import { scanSessionFiles } from "../../pi/session-stats/lib/scan-sessions.ts";
import { aggregateUsage } from "../../pi/session-stats/lib/aggregate.ts";
import { formatReport } from "../../pi/session-stats/lib/format.ts";
import { resolveDateRange } from "../../pi/session-stats/lib/date-range.ts";

interface CommandRegistration {
  description: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown[] | null;
}

function setupExtension() {
  const pi = createMockExtensionAPI();
  const commands = new Map<string, CommandRegistration>();
  pi.registerCommand = (name: string, options: CommandRegistration) => {
    commands.set(name, options);
  };
  extension(pi as unknown as Parameters<typeof extension>[0]);
  return { pi, commands };
}

test("registers /session-stats command with description", () => {
  const { commands } = setupExtension();
  assert.ok(commands.has("session-stats"));
  assert.ok(commands.get("session-stats")!.description.length > 0);
});

test("provides argument completions", () => {
  const { commands } = setupExtension();
  const cmd = commands.get("session-stats")!;
  assert.ok(cmd.getArgumentCompletions);
  const completions = cmd.getArgumentCompletions!("");
  assert.ok(completions && completions.length > 0);
});

test("handler notifies error without UI", async () => {
  const { commands } = setupExtension();
  const handler = commands.get("session-stats")!.handler;
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: () => Promise.resolve(null),
    },
  };
  await handler("", ctx);
  assert.ok(
    notifications.some(
      (n) => n.level === "error" && /interactive/i.test(n.message),
    ),
  );
});

// --- Finding 4: --help handler tests ---

test("--help without UI notifies with help text, not error", async () => {
  const { commands } = setupExtension();
  const handler = commands.get("session-stats")!.handler;
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: () => Promise.resolve(null),
    },
  };
  await handler("--help", ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.ok(notifications[0].message.includes("/session-stats"));
  assert.ok(notifications[0].message.includes("Ranges:"));
});

test("'help' without UI notifies with help text, not error", async () => {
  const { commands } = setupExtension();
  const handler = commands.get("session-stats")!.handler;
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: () => Promise.resolve(null),
    },
  };
  await handler("help", ctx);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].level, "info");
  assert.ok(notifications[0].message.includes("Examples:"));
});

// --- Finding 3: Integration test for scan → aggregate → format pipeline ---

const SESSION_HEADER = JSON.stringify({
  type: "session",
  version: 3,
  id: "test-id-1",
  timestamp: "2026-04-05T10:00:00.000Z",
  cwd: "/Users/me/Code/my-project",
});

const ASSISTANT_ENTRY = JSON.stringify({
  type: "message",
  id: "a1",
  parentId: null,
  timestamp: "2026-04-05T10:01:00.000Z",
  message: {
    role: "assistant",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    stopReason: "stop",
    timestamp: 1775127660000,
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 500,
      cacheWrite: 100,
      totalTokens: 1800,
      cost: {
        input: 0.003,
        output: 0.006,
        cacheRead: 0.001,
        cacheWrite: 0.0005,
        total: 0.0105,
      },
    },
    content: [{ type: "text", text: "Hello" }],
  },
});

test("full pipeline: scan → aggregate → format produces report lines", async () => {
  const sessionsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "session-stats-integration-"),
  );
  try {
    const dir = path.join(sessionsRoot, "--Users--me--Code--my-project--");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "session1.jsonl"),
      [SESSION_HEADER, ASSISTANT_ENTRY].join("\n") + "\n",
    );

    const range = resolveDateRange("all time");
    const scanResult = await scanSessionFiles(
      sessionsRoot,
      undefined,
      undefined,
      range,
    );
    assert.equal(scanResult.filesScanned, 1);
    assert.equal(scanResult.records.length, 1);

    const report = aggregateUsage(
      scanResult.records,
      range,
      scanResult.filesScanned,
    );
    assert.equal(report.messagesCounted, 1);
    assert.equal(report.totals.input, 1000);

    const lines = formatReport(report);
    assert.ok(lines.length > 0);
    assert.ok(lines.some((l) => l.includes("1,000")));
    assert.ok(lines.some((l) => l.includes("$0.01")));
    assert.ok(lines.some((l) => l.includes("my-project")));
  } finally {
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  }
});

test("full pipeline: empty sessions dir produces valid empty report", async () => {
  const sessionsRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "session-stats-integration-empty-"),
  );
  try {
    const range = resolveDateRange("today");
    const scanResult = await scanSessionFiles(
      sessionsRoot,
      undefined,
      undefined,
      range,
    );
    assert.equal(scanResult.filesScanned, 0);
    assert.equal(scanResult.records.length, 0);

    const report = aggregateUsage(
      scanResult.records,
      range,
      scanResult.filesScanned,
    );
    assert.equal(report.messagesCounted, 0);

    const lines = formatReport(report);
    assert.ok(lines.length > 0);
    assert.ok(lines.some((l) => l.includes("0")));
  } finally {
    fs.rmSync(sessionsRoot, { recursive: true, force: true });
  }
});

test("handler notifies error for invalid breakdown", async () => {
  const { commands } = setupExtension();
  const handler = commands.get("session-stats")!.handler;
  const notifications: Array<{ message: string; level: string }> = [];
  const ctx = {
    hasUI: false,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: () => Promise.resolve(null),
    },
  };
  await handler("today by invalid", ctx);
  assert.ok(
    notifications.some(
      (n) => n.level === "error" && /unknown breakdown/i.test(n.message),
    ),
  );
});
