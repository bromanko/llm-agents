import test from "node:test";
import assert from "node:assert/strict";

import {
  createWorkspaceWindow,
  findWorkspaceWindow,
  inTmuxEnv,
  killWindow,
  listWorkspaceWindows,
  parseTmuxVersion,
  parseWorkspaceWindows,
  selectWindow,
} from "./tmux-workspaces.ts";

function ok(stdout = "", stderr = "") {
  return { code: 0, stdout, stderr, killed: false };
}

function fail(stderr = "failed", stdout = "") {
  return { code: 1, stdout, stderr, killed: false };
}

function createPi(execImpl: (command: string, args: string[]) => Promise<any> | any) {
  return {
    exec(command: string, args: string[] = []) {
      return execImpl(command, args);
    },
  };
}

test("inTmuxEnv detects tmux-style environments", () => {
  assert.equal(inTmuxEnv({ TMUX: "/tmp/tmux-1/default,123,0" }), true);
  assert.equal(inTmuxEnv({ TERM: "tmux-256color" }), true);
  assert.equal(inTmuxEnv({ TERM: "xterm-256color" }), false);
});

test("parseTmuxVersion parses standard versions and rejects garbage", () => {
  assert.equal(parseTmuxVersion("tmux 3.6a"), 3.6);
  assert.equal(parseTmuxVersion("tmux 3.2"), 3.2);
  assert.equal(parseTmuxVersion("garbage"), null);
});

test("parseWorkspaceWindows keeps tag-based identity even when names are icon-mutated", () => {
  const output = [
    "@1\tws:auth ✻\tauth\t1",
    "@2\tcustom name\tui\t0",
    "@3\tnot-a-workspace\t\t0",
  ].join("\n");

  assert.deepEqual(parseWorkspaceWindows(output), [
    { windowId: "@1", windowName: "ws:auth ✻", wsName: "auth", active: true },
    { windowId: "@2", windowName: "custom name", wsName: "ui", active: false },
  ]);
});

test("listWorkspaceWindows and findWorkspaceWindow use tagged tmux output", async () => {
  const pi = createPi((_command, args) => {
    assert.equal(args[0], "list-windows");
    return ok("@1\tws:auth ✻\tauth\t1\n@2\tws:ui\tui\t0\n");
  });

  const windows = await listWorkspaceWindows(pi as any);
  assert.equal(windows.length, 2);

  const auth = await findWorkspaceWindow(pi as any, "auth");
  assert.deepEqual(auth, { windowId: "@1", windowName: "ws:auth ✻", wsName: "auth", active: true });
});

test("selectWindow and killWindow return false on tmux failure", async () => {
  const pi = createPi((_command, args) => {
    if (args[0] === "select-window") return fail("cannot select");
    if (args[0] === "kill-window") return fail("cannot kill");
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });

  assert.equal(await selectWindow(pi as any, "@1"), false);
  assert.equal(await killWindow(pi as any, "@1"), false);
});

test("createWorkspaceWindow uses bare pi for fresh sessions and pi -c for resumed sessions", async () => {
  const commands: string[][] = [];
  const pi = createPi((_command, args) => {
    commands.push(args);
    if (args[0] === "new-window") return ok("@7\n");
    if (args[0] === "set-window-option") return ok();
    if (args[0] === "select-window") return ok();
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });

  const fresh = await createWorkspaceWindow(pi as any, {
    wsName: "auth",
    cwd: "/repo-ws-auth",
    continueRecent: false,
  });
  assert.deepEqual(fresh, { ok: true, windowId: "@7", selected: true });
  assert.equal(commands[0]![commands[0]!.length - 1], "pi");

  commands.length = 0;
  const resumed = await createWorkspaceWindow(pi as any, {
    wsName: "auth",
    cwd: "/repo-ws-auth",
    continueRecent: true,
  });
  assert.deepEqual(resumed, { ok: true, windowId: "@7", selected: true });
  assert.equal(commands[0]![commands[0]!.length - 1], "pi -c");
});

test("createWorkspaceWindow kills created window when tagging fails", async () => {
  const commands: string[][] = [];
  const pi = createPi((_command, args) => {
    commands.push(args);
    if (args[0] === "new-window") return ok("@9\n");
    if (args[0] === "set-window-option" && args[3] === "@pi-ws") return fail("tag failed");
    if (args[0] === "kill-window") return ok();
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  });

  const result = await createWorkspaceWindow(pi as any, {
    wsName: "auth",
    cwd: "/repo-ws-auth",
    continueRecent: false,
  });

  assert.deepEqual(result, { ok: false, error: "tag failed" });
  assert.ok(commands.some((args) => args[0] === "kill-window" && args[2] === "@9"));
});
