/**
 * tmux-titles — Update tmux window title with pi status indicators.
 *
 * Shows the current agent state as an icon in the tmux window name:
 *
 *   ○  idle        — session started, waiting for input
 *   ✻  thinking    — agent is working
 *   $  bash        — running a shell command
 *   ✎  editing     — writing/editing files
 *   …  reading     — reading files
 *   ⌫  compacting  — context compaction in progress
 *   ✓  done        — agent finished
 *
 * Primary path uses `tmux rename-window` for reliable updates.
 * Falls back to tmux escape sequences (\033k...\033\\) written to the TTY,
 * so it still works in environments where tmux CLI invocation fails.
 * Requires `allow-rename on` in tmux config.
 *
 * Configuration via environment variables:
 *   TMUX_TITLES_POSITION — "suffix" (default) or "prefix"
 */

import { spawnSync } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
import { basename } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function inTmux(): boolean {
  const term = process.env.TERM ?? "";
  return !!(
    process.env.TMUX ||
    process.env.TERM_PROGRAM === "tmux" ||
    term.startsWith("tmux") ||
    term === "screen"
  );
}

function writeToTty(data: string): void {
  const ttyPath = process.env.SSH_TTY || "/dev/tty";
  try {
    const fd = openSync(ttyPath, "w");
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  } catch {
    // TTY not available — ignore
  }
}

function renameWindowWithTmux(title: string): boolean {
  try {
    const result = spawnSync("tmux", ["rename-window", title], {
      stdio: "ignore",
    });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

function setTitle(icon: string, cwd: string): void {
  if (!inTmux()) return;

  const base = basename(cwd);
  const position = process.env.TMUX_TITLES_POSITION ?? "suffix";
  const title =
    position === "prefix" ? `${icon} ${base}` : `${base} ${icon}`;

  // Primary path: ask tmux directly to rename the current window.
  // Fallback: write tmux title escape sequence to TTY.
  if (!renameWindowWithTmux(title)) {
    writeToTty(`\x1bk${title}\x1b\\`);
  }
}

function clearTitle(): void {
  if (!inTmux()) return;
  if (!renameWindowWithTmux("bash")) {
    writeToTty(`\x1bkbash\x1b\\`);
  }
}

const TOOL_ICONS: Record<string, string> = {
  bash: "$",
  write: "✎",
  edit: "✎",
  read: "…",
  grep: "…",
  find: "…",
  ls: "…",
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    setTitle("○", ctx.cwd);
  });

  pi.on("agent_start", async (_event, ctx) => {
    setTitle("✻", ctx.cwd);
  });

  pi.on("agent_end", async (_event, ctx) => {
    setTitle("✓", ctx.cwd);
  });

  pi.on("tool_call", async (event, ctx) => {
    setTitle(TOOL_ICONS[event.toolName] ?? "✻", ctx.cwd);
  });

  pi.on("tool_result", async (_event, ctx) => {
    setTitle("✻", ctx.cwd);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    setTitle("⌫", ctx.cwd);
  });

  pi.on("session_shutdown", async () => {
    clearTitle();
  });
}
