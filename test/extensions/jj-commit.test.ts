import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, registerJjCommitCommand } from "../../packages/jj/extensions/jj-commit.ts";

test("registerJjCommitCommand: registers jj-commit entrypoint", () => {
  const registrations: Array<{ name: string; command: any }> = [];
  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  registerJjCommitCommand(pi);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "jj-commit");
  assert.equal(typeof registrations[0].command.handler, "function");
  assert.ok(registrations[0].command.description.includes("Analyze jj working copy"));
});

test("parseArgs: handles malformed and unknown flags", () => {
  const cases: Array<{
    name: string;
    input: string;
    expected: Record<string, unknown>;
  }> = [
    {
      name: "unknown flags are ignored",
      input: "--unknown --dry-run --weird",
      expected: { dryRun: true, push: false, noChangelog: false, noAbsorb: false },
    },
    {
      name: "bookmark missing value does not consume following flag",
      input: "--bookmark --push",
      expected: { dryRun: false, push: true, noChangelog: false, noAbsorb: false },
    },
    {
      name: "bookmark value is parsed when provided",
      input: "--push --bookmark feature/abc",
      expected: {
        dryRun: false,
        push: true,
        bookmark: "feature/abc",
        noChangelog: false,
        noAbsorb: false,
      },
    },
    {
      name: "context consumes the remainder exactly",
      input: "--dry-run --context keep   spacing --bookmark main",
      expected: {
        dryRun: true,
        push: false,
        noChangelog: false,
        noAbsorb: false,
        context: "keep   spacing --bookmark main",
      },
    },
  ];

  for (const tc of cases) {
    const actual = parseArgs(tc.input);
    assert.deepStrictEqual(actual, tc.expected, tc.name);
  }
});

test("jj-commit handler: exits early in non-jj repo", async () => {
  let runPipelineCalled = false;
  const registrations: Array<{ name: string; command: any }> = [];

  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  registerJjCommitCommand(pi, {
    isJjRepo: () => false,
    ControlledJj: class {
      constructor(_cwd: string) {
        throw new Error("ControlledJj should not be constructed for non-repo path");
      }
    } as any,
    runCommitPipeline: async () => {
      runPipelineCalled = true;
      return { committed: false, summary: "", warnings: [], messages: [] };
    },
    pushWithBookmark: async () => ({ success: true }),
  });

  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    cwd: "/tmp/not-a-repo",
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ msg, level });
      },
    },
  };

  await registrations[0].command.handler("--push", ctx);

  assert.equal(runPipelineCalled, false);
  assert.deepStrictEqual(notifications, [
    { msg: "Not a jujutsu repository.", level: "error" },
  ]);
});

test("jj-commit handler: --push defaults bookmark to main when omitted", async () => {
  let pipelineArgs: any;
  const pushCalls: Array<{ bookmark: string }> = [];
  const registrations: Array<{ name: string; command: any }> = [];

  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  class MockJj {
    cwd: string;
    constructor(cwd: string) {
      this.cwd = cwd;
    }
  }

  registerJjCommitCommand(pi, {
    isJjRepo: () => true,
    ControlledJj: MockJj as any,
    runCommitPipeline: async (ctx: any) => {
      pipelineArgs = ctx.args;
      return {
        committed: true,
        summary: "Commit created.",
        warnings: [],
        messages: [],
      };
    },
    pushWithBookmark: async (_jj: any, bookmark: string) => {
      pushCalls.push({ bookmark });
      return { success: true };
    },
  });

  const notifications: Array<{ msg: string; level: string }> = [];
  const ctx = {
    cwd: "/tmp/repo",
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ msg, level });
      },
    },
    modelRegistry: undefined,
    model: undefined,
  };

  await registrations[0].command.handler("--push --bookmark", ctx);

  assert.equal(pipelineArgs.push, true);
  assert.equal(pipelineArgs.bookmark, undefined);
  assert.deepStrictEqual(pushCalls, [{ bookmark: "main" }]);
  assert.ok(
    notifications.some((n) => n.msg === "Pushed bookmark 'main' to remote." && n.level === "info"),
  );
});

test("jj-commit handler: reuses one registry snapshot and memoizes API key lookups", async () => {
  const registrations: Array<{ name: string; command: any }> = [];

  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  const sonnetModel = {
    provider: "anthropic",
    id: "claude-sonnet-4-6-20260301",
    name: "Claude Sonnet 4.6",
  };

  const otherModel = {
    provider: "openai",
    id: "gpt-4.1",
    name: "GPT-4.1",
  };

  let getAllCalls = 0;
  const apiKeyCalls: Array<{ provider: string; id: string }> = [];
  const allModels = [sonnetModel, otherModel];

  registerJjCommitCommand(pi, {
    isJjRepo: () => true,
    ControlledJj: class {
      constructor(_cwd: string) {}
    } as any,
    runCommitPipeline: async (pipelineCtx: any) => {
      assert.deepStrictEqual(pipelineCtx.availableModels, [sonnetModel, otherModel]);

      assert.equal(await pipelineCtx.hasApiKey(sonnetModel), true);
      assert.equal(await pipelineCtx.hasApiKey(sonnetModel), true);
      assert.equal(
        await pipelineCtx.hasApiKey({ provider: "missing", id: "missing", name: "Missing" }),
        false,
      );

      return {
        committed: false,
        summary: "Nothing to commit.",
        warnings: [],
        messages: [],
      };
    },
    pushWithBookmark: async () => ({ success: true }),
  });

  await registrations[0].command.handler("", {
    cwd: "/tmp/repo",
    ui: { notify: () => {} },
    modelRegistry: {
      getAll: () => {
        getAllCalls += 1;
        return allModels;
      },
      getAvailable: () => allModels,
      find: (provider: string, id: string) =>
        allModels.find((m: any) => m.provider === provider && m.id === id),
      getApiKey: async (model: { provider: string; id: string }) => {
        apiKeyCalls.push({ provider: model.provider, id: model.id });
        return "fake-key";
      },
    },
    model: undefined,
  });

  assert.equal(getAllCalls, 1);
  assert.deepStrictEqual(apiKeyCalls, [
    { provider: "anthropic", id: "claude-sonnet-4-6-20260301" },
  ]);
});

test("jj-commit handler: does not show recovery guidance for no-op outcomes", async () => {
  const registrations: Array<{ name: string; command: any }> = [];

  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  registerJjCommitCommand(pi, {
    isJjRepo: () => true,
    ControlledJj: class {
      constructor(_cwd: string) {}
    } as any,
    runCommitPipeline: async () => ({
      committed: false,
      summary: "Nothing to commit.",
      warnings: [],
      messages: [],
    }),
    pushWithBookmark: async () => ({ success: true }),
  });

  const notifications: Array<{ msg: string; level: string }> = [];
  await registrations[0].command.handler("", {
    cwd: "/tmp/repo",
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ msg, level });
      },
    },
    modelRegistry: undefined,
    model: undefined,
  });

  assert.ok(notifications.some((n) => n.msg === "Nothing to commit." && n.level === "info"));
  assert.ok(
    notifications.every(
      (n) => n.msg !== "To inspect operations: jj op log\nTo undo last operation: jj op undo",
    ),
  );
});
