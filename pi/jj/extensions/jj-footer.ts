/**
 * Custom footer extension for jujutsu repositories.
 *
 * Replaces the git branch display with jj info:
 * - The working copy change ID (styled like `jj log` with highlighted unique prefix)
 * - First line of description (if any)
 * - Lines added/removed in the working copy
 *
 * Everything else (tokens, cost, context %, model, etc.) stays the same.
 *
 * Performance note:
 * The footer must never do blocking shell work during render().
 * jj state is refreshed asynchronously in the background and render()
 * only reads cached values.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "../../lib/tui-shim.ts";

import {
  JJ_FOOTER_COMMANDS,
  JJ_INFO_FIELD_SEPARATOR,
  stripAnsi,
  type FooterSessionEntry,
  type JjInfo,
} from "../lib/footer.ts";
import { isJjRepo } from "../lib/utils.ts";

interface UsageCostLike {
  total: number;
}

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: UsageCostLike;
}

type AssistantMessageWithUsage = AssistantMessage & {
  role: "assistant";
  usage: UsageLike;
  stopReason?: unknown;
};

type AssistantMessageEntry = {
  type: "message";
  message: AssistantMessageWithUsage;
};

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const ANSI_CONTROL_SEQUENCE_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC_SEQUENCE_RE = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const UNSAFE_CONTROL_CHARS_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const JJ_TIMEOUT_MS = 3000;
const CACHE_MS = 5000;
const WORKSPACE_STATE_ENTRY = "jj-workspace-state";

interface SessionStats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  contextTokens: number;
}

interface FooterCacheSnapshot {
  jjInfo: JjInfo | null;
  workspaceName: string | null;
}

interface FooterCacheController {
  getSnapshot(): FooterCacheSnapshot;
  attachRequestRender(requestRender: (() => void) | null): void;
  scheduleRefresh(force?: boolean): void;
  dispose(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isUsageLike(value: unknown): value is UsageLike {
  if (!isRecord(value)) return false;
  if (!isNumber(value.input)) return false;
  if (!isNumber(value.output)) return false;
  if (!isNumber(value.cacheRead)) return false;
  if (!isNumber(value.cacheWrite)) return false;
  if (!isRecord(value.cost)) return false;
  return isNumber(value.cost.total);
}

function isAssistantMessageWithUsage(value: unknown): value is AssistantMessageWithUsage {
  if (!isRecord(value)) return false;
  if (value.role !== "assistant") return false;
  return isUsageLike(value.usage);
}

function isAssistantMessageEntry(value: unknown): value is AssistantMessageEntry {
  if (!isRecord(value)) return false;
  if (value.type !== "message") return false;
  return isAssistantMessageWithUsage(value.message);
}

function isFooterSessionEntry(value: unknown): value is FooterSessionEntry {
  return isRecord(value);
}

function getThinkingLevelFromContext(context: unknown): string | null {
  if (!isRecord(context)) return null;
  const level = context.thinkingLevel;
  return typeof level === "string" ? level : null;
}

function stripAnsiIfPresent(text: string): string {
  if (!text.includes("\x1b[")) return text;
  return text.replace(ANSI_ESCAPE_RE, "");
}

function sanitizeFooterText(text: string): string {
  if (!text) return "";

  const sanitized = text
    .replace(ANSI_OSC_SEQUENCE_RE, "")
    .replace(ANSI_CONTROL_SEQUENCE_RE, "")
    .replace(/\x1b/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(UNSAFE_CONTROL_CHARS_RE, "")
    .replace(/ +/g, " ")
    .trim();

  return sanitized;
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function computeSessionStats(entries: unknown[], branchEntries: unknown[]): SessionStats {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalCost = 0;

  for (const entry of entries) {
    if (!isAssistantMessageEntry(entry)) continue;

    const usage = entry.message.usage;
    totalInput += usage.input;
    totalOutput += usage.output;
    totalCacheRead += usage.cacheRead;
    totalCacheWrite += usage.cacheWrite;
    totalCost += usage.cost.total;
  }

  let contextTokens = 0;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (!isAssistantMessageEntry(entry)) continue;

    const message = entry.message;
    if (message.stopReason === "aborted") continue;

    const usage = message.usage;
    contextTokens =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    break;
  }

  return {
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCacheWrite,
    totalCost,
    contextTokens,
  };
}

function getWorkspaceNameFromEntries(entries: FooterSessionEntry[]): string | null | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    const isWsEntry =
      entry.customType === WORKSPACE_STATE_ENTRY
      || entry.type === WORKSPACE_STATE_ENTRY;
    if (!isWsEntry) continue;

    const data = entry.data;
    if (data === null || data === undefined) return null;
    if (!isRecord(data)) return null;

    const name = data.name;
    return typeof name === "string" ? name : null;
  }

  return undefined;
}

function parseWorkspaceNameFromOutput(ourChangeId: string, workspaceListOutput: string): string | null {
  let cursor = 0;
  while (cursor <= workspaceListOutput.length) {
    const nextNewline = workspaceListOutput.indexOf("\n", cursor);
    const lineEnd = nextNewline === -1 ? workspaceListOutput.length : nextNewline;
    const line = workspaceListOutput.slice(cursor, lineEnd).trim();

    if (line) {
      const sep = line.indexOf(":");
      if (sep !== -1) {
        const name = line.slice(0, sep);
        const changeId = line.slice(sep + 1);
        if (changeId === ourChangeId && name !== "default") {
          return name;
        }
      }
    }

    if (nextNewline === -1) break;
    cursor = nextNewline + 1;
  }

  return null;
}

function parseJjInfoFromOutput(logOutput: string, statOutput: string | null): JjInfo | null {
  const parts = logOutput.trim().split(JJ_INFO_FIELD_SEPARATOR);
  if (parts.length < 4) return null;

  const uniquePrefix = parts[0] ?? "";
  const fullShort = parts[1] ?? "";
  const emptyFlag = parts[parts.length - 1] ?? "";
  const description = parts.slice(2, -1).join(JJ_INFO_FIELD_SEPARATOR);

  const rest = fullShort.startsWith(uniquePrefix)
    ? fullShort.slice(uniquePrefix.length)
    : fullShort;

  let insertions = 0;
  let deletions = 0;

  if (statOutput) {
    const trimmedStat = statOutput.trim();
    const insertionMatch = trimmedStat.match(/(\d+) insertions?\(\+\)/);
    const deletionMatch = trimmedStat.match(/(\d+) deletions?\(-\)/);

    if (insertionMatch) {
      insertions = parseInt(insertionMatch[1], 10);
    }
    if (deletionMatch) {
      deletions = parseInt(deletionMatch[1], 10);
    }
  }

  return {
    uniquePrefix,
    rest,
    description: description || "",
    empty: emptyFlag === "empty",
    insertions,
    deletions,
  };
}

export default function(pi: ExtensionAPI) {
  let footerCache: FooterCacheController | null = null;

  async function runJj(cwd: string, args: readonly string[]): Promise<string | null> {
    const result = await pi.exec("jj", [...args], {
      cwd,
      timeout: JJ_TIMEOUT_MS,
    });

    if (result.killed || result.code !== 0) return null;
    return stripAnsi(result.stdout ?? "").trim();
  }

  async function fetchWorkspaceName(cwd: string, entries: FooterSessionEntry[]): Promise<string | null> {
    const fromEntries = getWorkspaceNameFromEntries(entries);
    if (fromEntries !== undefined) return fromEntries;

    const ourChangeId = await runJj(cwd, JJ_FOOTER_COMMANDS.currentChangeId);
    if (!ourChangeId) return null;

    const workspaceList = await runJj(cwd, JJ_FOOTER_COMMANDS.workspaceList);
    if (!workspaceList) return null;

    return parseWorkspaceNameFromOutput(ourChangeId, workspaceList);
  }

  async function fetchJjInfo(cwd: string): Promise<JjInfo | null> {
    const logOutput = await runJj(cwd, JJ_FOOTER_COMMANDS.infoLog);
    if (!logOutput) return null;

    const statOutput = await runJj(cwd, JJ_FOOTER_COMMANDS.diffStat);
    return parseJjInfoFromOutput(logOutput, statOutput);
  }

  function createFooterCacheController(ctx: any): FooterCacheController {
    let cachedJjInfo: JjInfo | null = null;
    let cachedWsName: string | null = null;
    let lastFetch = 0;
    let refreshInFlight: Promise<void> | null = null;
    let pendingForceRefresh = false;
    let disposed = false;
    let requestRender: (() => void) | null = null;
    let refreshTimer: ReturnType<typeof setInterval> | null = null;

    async function refresh(force = false): Promise<void> {
      if (disposed) return;
      if (!force && Date.now() - lastFetch < CACHE_MS) return;

      if (refreshInFlight) {
        pendingForceRefresh = pendingForceRefresh || force;
        return refreshInFlight;
      }

      refreshInFlight = (async () => {
        const entries = ctx.sessionManager
          .getEntries()
          .filter(isFooterSessionEntry);

        const [jjInfo, wsName] = await Promise.all([
          fetchJjInfo(ctx.cwd),
          fetchWorkspaceName(ctx.cwd, entries),
        ]);

        if (disposed) return;

        cachedJjInfo = jjInfo;
        cachedWsName = wsName;
        lastFetch = Date.now();
        requestRender?.();
      })().finally(() => {
        refreshInFlight = null;

        if (disposed) return;
        if (!pendingForceRefresh) return;

        const rerunForce = pendingForceRefresh;
        pendingForceRefresh = false;
        queueMicrotask(() => {
          void refresh(rerunForce);
        });
      });

      return refreshInFlight;
    }

    refreshTimer = setInterval(() => {
      void refresh(false);
    }, CACHE_MS);
    refreshTimer.unref?.();

    return {
      getSnapshot() {
        return {
          jjInfo: cachedJjInfo,
          workspaceName: cachedWsName,
        };
      },
      attachRequestRender(nextRequestRender) {
        requestRender = nextRequestRender;
      },
      scheduleRefresh(force = false) {
        void refresh(force);
      },
      dispose() {
        disposed = true;
        requestRender = null;
        if (refreshTimer) {
          clearInterval(refreshTimer);
          refreshTimer = null;
        }
      },
    };
  }

  function refreshFooter(force = false): void {
    footerCache?.scheduleRefresh(force);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isJjRepo(ctx.cwd)) return;

    footerCache?.dispose();
    footerCache = createFooterCacheController(ctx);
    refreshFooter(true);

    ctx.ui.setFooter((tui, theme, footerData) => {
      footerCache?.attachRequestRender(() => tui.requestRender());
      const unsubscribeBranch = footerData.onBranchChange(() => {
        refreshFooter(true);
        tui.requestRender();
      });

      return {
        dispose() {
          unsubscribeBranch();
          footerCache?.attachRequestRender(null);
        },
        invalidate() { },
        render(width: number): string[] {
          // --- Line 1: cwd + jj info ---
          let pwd = ctx.cwd;
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          const snapshot = footerCache?.getSnapshot() ?? {
            jjInfo: null,
            workspaceName: null,
          };

          // Workspace indicator (yellow, between cwd and change ID)
          const safeWsName = snapshot.workspaceName ? sanitizeFooterText(snapshot.workspaceName) : "";
          if (safeWsName) {
            pwd += " " + theme.fg("warning", `⎇ ${safeWsName}`);
          }

          const jj = snapshot.jjInfo;
          if (jj) {
            // Style change ID like jj log: unique prefix highlighted, rest dimmed
            const changeId =
              theme.fg("accent", theme.bold(jj.uniquePrefix)) + theme.fg("dim", jj.rest);

            let jjParts = changeId;

            const safeDescription = sanitizeFooterText(jj.description);
            if (safeDescription) {
              jjParts += " " + theme.fg("muted", safeDescription);
            } else if (jj.empty) {
              jjParts += " " + theme.fg("dim", "(empty)");
            } else {
              jjParts += " " + theme.fg("dim", "(no description)");
            }

            // Diff stats
            const diffParts: string[] = [];
            if (jj.insertions > 0) {
              diffParts.push(theme.fg("success", `+${jj.insertions}`));
            }
            if (jj.deletions > 0) {
              diffParts.push(theme.fg("error", `-${jj.deletions}`));
            }
            if (diffParts.length > 0) {
              jjParts += " " + diffParts.join(" ");
            }

            pwd = `${pwd} ${jjParts}`;
          } else {
            // Fall back to git branch if not a jj repo or refresh failed
            const branch = footerData.getGitBranch();
            if (branch) {
              pwd = `${pwd} (${branch})`;
            }
          }

          // Session name
          const sessionName = ctx.sessionManager.getSessionName();
          const safeSessionName = sessionName ? sanitizeFooterText(sessionName) : "";
          if (safeSessionName) {
            pwd = `${pwd} • ${safeSessionName}`;
          }

          // --- Line 2: token stats + model (replicate default behavior) ---
          const sessionStats = computeSessionStats(
            ctx.sessionManager.getEntries(),
            ctx.sessionManager.getBranch(),
          );
          const {
            totalInput,
            totalOutput,
            totalCacheRead,
            totalCacheWrite,
            totalCost,
            contextTokens,
          } = sessionStats;

          const contextWindow = ctx.model?.contextWindow || 0;
          const contextPercentValue =
            contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0;
          const contextPercent = contextPercentValue.toFixed(1);

          const statsParts: string[] = [];
          if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`);
          if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`);
          if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`);
          if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`);
          if (totalCost) statsParts.push(`$${totalCost.toFixed(3)}`);

          let contextPercentStr: string;
          const contextPercentDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
          if (contextPercentValue > 90) {
            contextPercentStr = theme.fg("error", contextPercentDisplay);
          } else if (contextPercentValue > 70) {
            contextPercentStr = theme.fg("warning", contextPercentDisplay);
          } else {
            contextPercentStr = contextPercentDisplay;
          }
          statsParts.push(contextPercentStr);

          const statsLeft = statsParts.join(" ");
          const statsLeftWidth = visibleWidth(statsLeft);

          // Model + thinking level on the right
          const modelName = ctx.model?.id || "no-model";
          let rightSide = modelName;
          if (ctx.model?.reasoning) {
            const thinkingLevel = getThinkingLevelFromContext(ctx) ?? pi.getThinkingLevel();
            rightSide =
              thinkingLevel === "off"
                ? `${modelName} • thinking off`
                : `${modelName} • ${thinkingLevel}`;
          }

          if (footerData.getAvailableProviderCount() > 1 && ctx.model) {
            const withProvider = `(${ctx.model.provider}) ${rightSide}`;
            if (statsLeftWidth + 2 + visibleWidth(withProvider) <= width) {
              rightSide = withProvider;
            }
          }

          const rightSideWidth = visibleWidth(rightSide);
          const totalNeeded = statsLeftWidth + 2 + rightSideWidth;

          let statsLine: string;
          if (totalNeeded <= width) {
            const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
            statsLine = theme.fg("dim", statsLeft) + padding + theme.fg("dim", rightSide);
          } else {
            const availableForRight = width - statsLeftWidth - 2;
            if (availableForRight > 3) {
              const plainRight = stripAnsiIfPresent(rightSide);
              const truncatedRight = plainRight.substring(0, availableForRight);
              const truncatedWidth = visibleWidth(truncatedRight);
              const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedWidth));
              statsLine = theme.fg("dim", statsLeft) + padding + theme.fg("dim", truncatedRight);
            } else {
              statsLine = theme.fg("dim", statsLeft);
            }
          }

          const lines = [
            truncateToWidth(theme.fg("dim", pwd), width),
            truncateToWidth(statsLine, width, theme.fg("dim", "...")),
          ];

          // Extension statuses
          const extensionStatuses = footerData.getExtensionStatuses();
          if (extensionStatuses.size > 0) {
            const statusLine = Array.from(extensionStatuses.entries())
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([, text]) =>
                text
                  .replace(/[\r\n\t]/g, " ")
                  .replace(/ +/g, " ")
                  .trim(),
              )
              .join(" ");
            lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
          }

          return lines;
        },
      };
    });
  });

  pi.on("tool_result", async (event) => {
    if (!footerCache) return;
    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash") {
      refreshFooter(true);
    }
  });

  pi.on("agent_end", async () => {
    refreshFooter(true);
  });

  pi.on("session_switch", async () => {
    refreshFooter(true);
  });

  pi.on("session_fork", async () => {
    refreshFooter(true);
  });

  pi.on("session_tree", async () => {
    refreshFooter(true);
  });

  pi.on("session_shutdown", async () => {
    footerCache?.dispose();
    footerCache = null;
  });
}
