import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export interface TmuxWorkspaceWindow {
  windowId: string;
  windowName: string;
  wsName: string;
  active: boolean;
}

export type CreateWorkspaceWindowResult =
  | { ok: true; windowId: string; selected: boolean }
  | { ok: false; error: string };

const TMUX_TIMEOUT_MS = 5_000;
const TMUX_VERSION_RE = /tmux\s+(\d+)(?:\.(\d+))?/;
const TMUX_LIST_WINDOWS_FORMAT = "#{window_id}\t#{window_name}\t#{@pi-ws}\t#{window_active}";

function formatTmuxError(stderr: string, fallback: string): string {
  return stderr.trim() || fallback;
}

async function runTmux(
  pi: ExtensionAPI,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }> {
  const result = await pi.exec("tmux", args, { timeout: TMUX_TIMEOUT_MS });
  return {
    code: result.code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    killed: result.killed,
  };
}

export function inTmuxEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): boolean {
  const term = env.TERM ?? "";
  return !!(
    env.TMUX
    || env.TERM_PROGRAM === "tmux"
    || term.startsWith("tmux")
    || term === "screen"
  );
}

export function parseTmuxVersion(output: string): number | null {
  const match = output.trim().match(TMUX_VERSION_RE);
  if (!match) return null;

  const major = Number.parseInt(match[1] ?? "", 10);
  const minor = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null;

  return Number.parseFloat(`${major}.${minor}`);
}

export function parseWorkspaceWindows(output: string): TmuxWorkspaceWindow[] {
  const windows: TmuxWorkspaceWindow[] = [];

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const [windowId = "", windowName = "", wsName = "", active = "0"] = line.split("\t");
    if (!windowId || !wsName) continue;

    windows.push({
      windowId,
      windowName,
      wsName,
      active: active === "1",
    });
  }

  return windows;
}

export async function listWorkspaceWindows(pi: ExtensionAPI): Promise<TmuxWorkspaceWindow[]> {
  const result = await runTmux(pi, ["list-windows", "-F", TMUX_LIST_WINDOWS_FORMAT]);
  if (result.killed || result.code !== 0) return [];
  return parseWorkspaceWindows(result.stdout);
}

export async function findWorkspaceWindow(
  pi: ExtensionAPI,
  wsName: string,
): Promise<TmuxWorkspaceWindow | null> {
  const windows = await listWorkspaceWindows(pi);
  return windows.find((window) => window.wsName === wsName) ?? null;
}

export async function selectWindow(pi: ExtensionAPI, windowId: string): Promise<boolean> {
  const result = await runTmux(pi, ["select-window", "-t", windowId]);
  return !result.killed && result.code === 0;
}

export async function killWindow(pi: ExtensionAPI, windowId: string): Promise<boolean> {
  const result = await runTmux(pi, ["kill-window", "-t", windowId]);
  return !result.killed && result.code === 0;
}

export async function createWorkspaceWindow(
  pi: ExtensionAPI,
  options: { wsName: string; cwd: string; continueRecent: boolean },
): Promise<CreateWorkspaceWindowResult> {
  const command = options.continueRecent ? "pi -c" : "pi";
  const newWindowResult = await runTmux(pi, [
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{window_id}",
    "-n",
    `ws:${options.wsName}`,
    "-c",
    options.cwd,
    command,
  ]);

  if (newWindowResult.killed || newWindowResult.code !== 0) {
    return {
      ok: false,
      error: formatTmuxError(newWindowResult.stderr, `Failed to create tmux window for workspace '${options.wsName}'.`),
    };
  }

  const windowId = newWindowResult.stdout.trim();
  if (!windowId) {
    return {
      ok: false,
      error: `tmux created a window for workspace '${options.wsName}', but did not return a window id.`,
    };
  }

  const tagResult = await runTmux(pi, [
    "set-window-option",
    "-t",
    windowId,
    "@pi-ws",
    options.wsName,
  ]);
  if (tagResult.killed || tagResult.code !== 0) {
    await killWindow(pi, windowId);
    return {
      ok: false,
      error: formatTmuxError(tagResult.stderr, `Failed to tag tmux window for workspace '${options.wsName}'.`),
    };
  }

  const remainResult = await runTmux(pi, [
    "set-window-option",
    "-t",
    windowId,
    "remain-on-exit",
    "off",
  ]);
  if (remainResult.killed || remainResult.code !== 0) {
    await killWindow(pi, windowId);
    return {
      ok: false,
      error: formatTmuxError(remainResult.stderr, `Failed to configure tmux window for workspace '${options.wsName}'.`),
    };
  }

  const selected = await selectWindow(pi, windowId);
  return { ok: true, windowId, selected };
}
