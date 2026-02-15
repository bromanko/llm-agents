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
 * Uses targeted tmux commands bound to the current pane (TMUX_PANE), so
 * multiple pi instances do not clobber each other's window titles.
 *
 * Configuration via environment variables:
 *   TMUX_TITLES_POSITION — "suffix" (default) or "prefix"
 */

import { spawnSync } from "node:child_process";
import { openSync, writeSync, closeSync } from "node:fs";
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

function runTmux(args: string[]): { ok: boolean; stdout: string } {
  try {
    const result = spawnSync("tmux", args, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    });
    return {
      ok: !result.error && result.status === 0,
      stdout: (result.stdout ?? "").trim(),
    };
  } catch {
    return { ok: false, stdout: "" };
  }
}

function getTargetPane(): string | undefined {
  const pane = process.env.TMUX_PANE;
  return pane && pane.length > 0 ? pane : undefined;
}

function getTargetWindow(): string | undefined {
  const targetPane = getTargetPane();
  if (!targetPane) return undefined;

  const result = runTmux([
    "display-message",
    "-p",
    "-t",
    targetPane,
    "#{window_id}",
  ]);

  return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
}

function getCurrentWindowTitle(): string | undefined {
  const targetWindow = getTargetWindow();
  const args = targetWindow
    ? ["display-message", "-p", "-t", targetWindow, "#{window_name}"]
    : ["display-message", "-p", "#{window_name}"];

  const result = runTmux(args);
  return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
}

function renameWindow(title: string): boolean {
  const targetWindow = getTargetWindow();
  const args = targetWindow
    ? ["rename-window", "-t", targetWindow, title]
    : ["rename-window", title];

  return runTmux(args).ok;
}

const STATUS_ICONS = ["○", "✻", "$", "✎", "…", "⌫", "✓"];
const ICON_CLASS = STATUS_ICONS.map((icon) => icon.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
const PREFIX_ICON_RE = new RegExp(`^[${ICON_CLASS}]\\s+`);
const SUFFIX_ICON_RE = new RegExp(`\\s+[${ICON_CLASS}]$`);

function withIcon(title: string, icon: string, position: "prefix" | "suffix"): string {
  if (position === "prefix") {
    const base = title.replace(PREFIX_ICON_RE, "");
    return `${icon} ${base}`.trim();
  }

  const base = title.replace(SUFFIX_ICON_RE, "");
  return `${base} ${icon}`.trim();
}

function withoutIcon(title: string, position: "prefix" | "suffix"): string {
  return position === "prefix"
    ? title.replace(PREFIX_ICON_RE, "").trim()
    : title.replace(SUFFIX_ICON_RE, "").trim();
}

function setIcon(icon: string): void {
  if (!inTmux()) return;

  const position = (process.env.TMUX_TITLES_POSITION === "prefix" ? "prefix" : "suffix") as
    | "prefix"
    | "suffix";

  const current = getCurrentWindowTitle();
  if (!current) return;

  const next = withIcon(current, icon, position);

  if (!renameWindow(next)) {
    writeToTty(`\x1bk${next}\x1b\\`);
  }
}

function clearIcon(): void {
  if (!inTmux()) return;

  const position = (process.env.TMUX_TITLES_POSITION === "prefix" ? "prefix" : "suffix") as
    | "prefix"
    | "suffix";

  const current = getCurrentWindowTitle();
  if (!current) return;

  const next = withoutIcon(current, position);
  if (!renameWindow(next)) {
    writeToTty(`\x1bk${next}\x1b\\`);
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
  pi.on("session_start", async () => {
    setIcon("○");
  });

  pi.on("agent_start", async () => {
    setIcon("✻");
  });

  pi.on("agent_end", async () => {
    setIcon("✓");
  });

  pi.on("tool_call", async (event) => {
    setIcon(TOOL_ICONS[event.toolName] ?? "✻");
  });

  pi.on("tool_result", async () => {
    setIcon("✻");
  });

  pi.on("session_before_compact", async () => {
    setIcon("⌫");
  });

  pi.on("session_shutdown", async () => {
    clearIcon();
  });
}
