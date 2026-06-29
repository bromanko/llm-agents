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
 * multiple pi instances do not clobber each other's window titles. If the
 * pane target cannot be resolved, the extension does nothing rather than
 * falling back to the active tmux window.
 *
 * Configuration via environment variables:
 *   TMUX_TITLES_POSITION — "suffix" (default) or "prefix"
 */

import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface TmuxCommandResult {
  ok: boolean;
  stdout: string;
}

export type TmuxRunner = (args: string[]) => TmuxCommandResult;

export interface TmuxTitleRuntime {
  env?: Record<string, string | undefined>;
  runTmux?: TmuxRunner;
}

function getEnv(runtime?: TmuxTitleRuntime): Record<string, string | undefined> {
  return runtime?.env ?? process.env;
}

function getRunner(runtime?: TmuxTitleRuntime): TmuxRunner {
  return runtime?.runTmux ?? runTmux;
}

export function inTmux(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.TMUX && env.TMUX_PANE);
}

function runTmux(args: string[]): TmuxCommandResult {
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

function getTargetPane(env: Record<string, string | undefined>): string | undefined {
  const pane = env.TMUX_PANE;
  return pane && pane.length > 0 ? pane : undefined;
}

function getTargetWindow(runtime?: TmuxTitleRuntime): string | undefined {
  const targetPane = getTargetPane(getEnv(runtime));
  if (!targetPane) return undefined;

  const result = getRunner(runtime)([
    "display-message",
    "-p",
    "-t",
    targetPane,
    "#{window_id}",
  ]);

  return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
}

function getWindowTitle(windowId: string, runtime?: TmuxTitleRuntime): string | undefined {
  const result = getRunner(runtime)([
    "display-message",
    "-p",
    "-t",
    windowId,
    "#{window_name}",
  ]);
  return result.ok && result.stdout.length > 0 ? result.stdout : undefined;
}

function renameWindow(windowId: string, title: string, runtime?: TmuxTitleRuntime): boolean {
  return getRunner(runtime)(["rename-window", "-t", windowId, title]).ok;
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

function getPosition(env: Record<string, string | undefined>): "prefix" | "suffix" {
  return env.TMUX_TITLES_POSITION === "prefix" ? "prefix" : "suffix";
}

export function setIcon(icon: string, runtime?: TmuxTitleRuntime): void {
  const env = getEnv(runtime);
  if (!inTmux(env)) return;

  const targetWindow = getTargetWindow(runtime);
  if (!targetWindow) return;

  const current = getWindowTitle(targetWindow, runtime);
  if (!current) return;

  renameWindow(targetWindow, withIcon(current, icon, getPosition(env)), runtime);
}

export function clearIcon(runtime?: TmuxTitleRuntime): void {
  const env = getEnv(runtime);
  if (!inTmux(env)) return;

  const targetWindow = getTargetWindow(runtime);
  if (!targetWindow) return;

  const current = getWindowTitle(targetWindow, runtime);
  if (!current) return;

  renameWindow(targetWindow, withoutIcon(current, getPosition(env)), runtime);
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

export default function(pi: ExtensionAPI) {
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
