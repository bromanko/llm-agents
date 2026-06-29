import test from "node:test";
import assert from "node:assert/strict";
import {
  clearIcon,
  inTmux,
  setIcon,
  type TmuxCommandResult,
  type TmuxRunner,
} from "../../pi/tmux-titles/extensions/tmux-titles.ts";

const ok = (stdout = ""): TmuxCommandResult => ({ ok: true, stdout });
const fail = (): TmuxCommandResult => ({ ok: false, stdout: "" });

function recordingRunner(handler: TmuxRunner): { calls: string[][]; runTmux: TmuxRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runTmux(args: string[]) {
      calls.push([...args]);
      return handler(args);
    },
  };
}

test("inTmux requires a concrete tmux pane target", () => {
  assert.equal(inTmux({ TERM: "screen" }), false);
  assert.equal(inTmux({ TMUX: "/tmp/tmux/default,1,0" }), false);
  assert.equal(inTmux({ TMUX: "/tmp/tmux/default,1,0", TMUX_PANE: "%1" }), true);
});

test("setIcon does nothing when no pane target is available", () => {
  const { calls, runTmux } = recordingRunner(() => ok("@1"));

  setIcon("✻", {
    env: { TMUX: "/tmp/tmux/default,1,0", TERM: "screen" },
    runTmux,
  });

  assert.deepEqual(calls, []);
});

test("setIcon does not fall back to the active tmux window when pane lookup fails", () => {
  const { calls, runTmux } = recordingRunner((args) => {
    if (args[0] === "display-message" && args.includes("%missing")) {
      return fail();
    }
    throw new Error(`unexpected tmux call: ${args.join(" ")}`);
  });

  setIcon("✻", {
    env: { TMUX: "/tmp/tmux/default,1,0", TMUX_PANE: "%missing" },
    runTmux,
  });

  assert.deepEqual(calls, [["display-message", "-p", "-t", "%missing", "#{window_id}"]]);
  assert.equal(calls.some((args) => args[0] === "rename-window"), false);
  assert.equal(
    calls.some((args) => args[0] === "display-message" && !args.includes("-t")),
    false,
  );
});

test("setIcon renames only the window resolved from the current pane", () => {
  const { calls, runTmux } = recordingRunner((args) => {
    if (args.join("\0") === ["display-message", "-p", "-t", "%1", "#{window_id}"].join("\0")) {
      return ok("@7");
    }
    if (args.join("\0") === ["display-message", "-p", "-t", "@7", "#{window_name}"].join("\0")) {
      return ok("workspace ✻");
    }
    if (args.join("\0") === ["rename-window", "-t", "@7", "workspace $"].join("\0")) {
      return ok();
    }
    throw new Error(`unexpected tmux call: ${args.join(" ")}`);
  });

  setIcon("$", {
    env: { TMUX: "/tmp/tmux/default,1,0", TMUX_PANE: "%1" },
    runTmux,
  });

  assert.deepEqual(calls, [
    ["display-message", "-p", "-t", "%1", "#{window_id}"],
    ["display-message", "-p", "-t", "@7", "#{window_name}"],
    ["rename-window", "-t", "@7", "workspace $"],
  ]);
});

test("clearIcon removes a prefix icon only on the resolved window", () => {
  const { calls, runTmux } = recordingRunner((args) => {
    if (args.join("\0") === ["display-message", "-p", "-t", "%1", "#{window_id}"].join("\0")) {
      return ok("@7");
    }
    if (args.join("\0") === ["display-message", "-p", "-t", "@7", "#{window_name}"].join("\0")) {
      return ok("✻ workspace");
    }
    if (args.join("\0") === ["rename-window", "-t", "@7", "workspace"].join("\0")) {
      return ok();
    }
    throw new Error(`unexpected tmux call: ${args.join(" ")}`);
  });

  clearIcon({
    env: {
      TMUX: "/tmp/tmux/default,1,0",
      TMUX_PANE: "%1",
      TMUX_TITLES_POSITION: "prefix",
    },
    runTmux,
  });

  assert.deepEqual(calls, [
    ["display-message", "-p", "-t", "%1", "#{window_id}"],
    ["display-message", "-p", "-t", "@7", "#{window_name}"],
    ["rename-window", "-t", "@7", "workspace"],
  ]);
});
