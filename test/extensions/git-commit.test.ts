import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, registerGitCommitCommand } from "../../pi/git/extensions/git-commit.ts";

test("registerGitCommitCommand: registers git-commit entrypoint", () => {
  const registrations: Array<{ name: string; command: any }> = [];
  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  registerGitCommitCommand(pi);

  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].name, "git-commit");
  assert.equal(typeof registrations[0].command.handler, "function");
  assert.match(registrations[0].command.description, /hunk-level splits/i);
});

test("parseArgs: handles known flags and ignores unknown ones", () => {
  assert.deepStrictEqual(parseArgs("--unknown --dry-run"), {
    dryRun: true,
    push: false,
  });

  assert.deepStrictEqual(parseArgs("--push --context split auth and docs"), {
    dryRun: false,
    push: true,
    context: "split auth and docs",
  });
});

test("git-commit handler: exits early in non-git repo", async () => {
  const registrations: Array<{ name: string; command: any }> = [];
  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  registerGitCommitCommand(pi, {
    isGitRepo: () => false,
    loadGitCommitConfig: () => ({}),
    ControlledGit: class {
      constructor(_cwd: string) {
        throw new Error("ControlledGit should not be constructed for non-repo path");
      }
    } as any,
    runCommitPipeline: async () => ({ committed: false, summary: "", warnings: [], messages: [] }),
  });

  const notifications: Array<{ msg: string; level: string }> = [];
  await registrations[0].command.handler("", {
    cwd: "/tmp/not-a-repo",
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ msg, level });
      },
    },
  });

  assert.deepStrictEqual(notifications, [
    { msg: "Not a Git repository.", level: "error" },
  ]);
});

test("git-commit handler: auto-stages and restores staging on non-commit outcomes", async () => {
  const registrations: Array<{ name: string; command: any }> = [];
  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  const calls: string[] = [];
  class MockGit {
    async hasStagedChanges() {
      calls.push("hasStagedChanges");
      return false;
    }
    async stageAll() {
      calls.push("stageAll");
    }
    async getStagedSnapshot() {
      calls.push("getStagedSnapshot");
      return {
        files: [{ path: "src/app.ts", kind: "modified", isBinary: false, patch: "", hunks: [], splitAllowed: false }],
        stat: "",
        diff: "",
      };
    }
    async resetStaging() {
      calls.push("resetStaging");
    }
    async push() {
      calls.push("push");
    }
  }

  registerGitCommitCommand(pi, {
    isGitRepo: () => true,
    loadGitCommitConfig: () => ({}),
    ControlledGit: MockGit as any,
    runCommitPipeline: async () => ({
      committed: false,
      summary: "No commit proposal could be generated. Check model configuration and try again.",
      warnings: [],
      messages: [],
    }),
  });

  const notifications: Array<{ msg: string; level: string }> = [];
  await registrations[0].command.handler("", {
    cwd: "/tmp/repo",
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ msg, level });
      },
    },
    modelRegistry: { getAll: () => [] },
    model: undefined,
  });

  assert.deepStrictEqual(calls, [
    "hasStagedChanges",
    "stageAll",
    "getStagedSnapshot",
    "resetStaging",
  ]);
  assert.ok(
    notifications.some((entry) =>
      entry.msg === "No staged changes detected; staging all changes for analysis." && entry.level === "info"
    ),
  );
});

test("git-commit handler: passes configured model into the pipeline", async () => {
  const registrations: Array<{ name: string; command: any }> = [];
  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  class MockGit {
    async hasStagedChanges() {
      return true;
    }
    async getStagedSnapshot() {
      return {
        files: [{ path: "src/app.ts", kind: "modified", isBinary: false, patch: "", hunks: [], splitAllowed: false }],
        stat: "",
        diff: "",
      };
    }
    async resetStaging() { }
    async push() { }
  }

  registerGitCommitCommand(pi, {
    isGitRepo: () => true,
    loadGitCommitConfig: () => ({
      model: { provider: "anthropic", id: "claude-opus-4-1" },
    }),
    ControlledGit: MockGit as any,
    runCommitPipeline: async (pipelineCtx: any) => {
      assert.deepStrictEqual(pipelineCtx.configuredModel, {
        provider: "anthropic",
        id: "claude-opus-4-1",
        name: "anthropic/claude-opus-4-1",
      });
      return {
        committed: false,
        summary: "No commit proposal could be generated. Check model configuration and try again.",
        warnings: [],
        messages: [],
      };
    },
  });

  await registrations[0].command.handler("", {
    cwd: "/tmp/repo",
    ui: {
      notify: () => { },
    },
    modelRegistry: { getAll: () => [] },
    model: undefined,
  });
});

test("git-commit handler: pushes after successful commit when requested", async () => {
  const registrations: Array<{ name: string; command: any }> = [];
  const pi = {
    registerCommand: (name: string, command: any) => {
      registrations.push({ name, command });
    },
  } as any;

  const calls: string[] = [];
  class MockGit {
    async hasStagedChanges() {
      calls.push("hasStagedChanges");
      return true;
    }
    async getStagedSnapshot() {
      calls.push("getStagedSnapshot");
      return {
        files: [{ path: "src/app.ts", kind: "modified", isBinary: false, patch: "", hunks: [], splitAllowed: false }],
        stat: "",
        diff: "",
      };
    }
    async resetStaging() {
      calls.push("resetStaging");
    }
    async push() {
      calls.push("push");
    }
  }

  registerGitCommitCommand(pi, {
    isGitRepo: () => true,
    loadGitCommitConfig: () => ({}),
    ControlledGit: MockGit as any,
    runCommitPipeline: async (pipelineCtx: any) => {
      assert.equal(pipelineCtx.args.push, true);
      return {
        committed: true,
        summary: "Commit created.",
        warnings: [],
        messages: ["fix: updated auth flow"],
      };
    },
  });

  const notifications: Array<{ msg: string; level: string }> = [];
  await registrations[0].command.handler("--push", {
    cwd: "/tmp/repo",
    ui: {
      notify: (msg: string, level: string) => {
        notifications.push({ msg, level });
      },
    },
    modelRegistry: { getAll: () => [] },
    model: undefined,
  });

  assert.deepStrictEqual(calls, ["hasStagedChanges", "getStagedSnapshot", "push"]);
  assert.ok(notifications.some((entry) => entry.msg === "Pushed to remote." && entry.level === "info"));
});
