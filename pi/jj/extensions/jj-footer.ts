/**
 * Custom footer extension for jujutsu repositories.
 *
 * Replaces the git branch display with jj info:
 * - The working copy change ID (styled like `jj log` with highlighted unique prefix)
 * - First line of description (if any)
 * - Lines added/removed in the working copy
 *
 * Everything else (tokens, cost, context %, model, etc.) stays the same.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

import {
  detectWorkspaceName,
  getJjInfo,
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

interface SessionStats {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCost: number;
  contextTokens: number;
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

export default function(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    if (!isJjRepo(ctx.cwd)) return;

    ctx.ui.setFooter((_tui, theme, footerData) => {
      // Poll for jj changes periodically
      let cachedJjInfo: JjInfo | null = null;
      let cachedWsName: string | null = null;
      let lastFetch = 0;
      const CACHE_MS = 3000;

      let cachedSessionStats: SessionStats | null = null;
      let cachedEntriesLength = -1;
      let cachedLastEntry: unknown = undefined;
      let cachedBranchLength = -1;
      let cachedLastBranchEntry: unknown = undefined;

      function refreshCache() {
        cachedJjInfo = getJjInfo(ctx.cwd);

        const entries = ctx.sessionManager
          .getEntries()
          .filter(isFooterSessionEntry);
        cachedWsName = detectWorkspaceName(ctx.cwd, entries);

        lastFetch = Date.now();
      }

      function ensureCache() {
        if (Date.now() - lastFetch > CACHE_MS) {
          refreshCache();
        }
      }

      function getInfo(): JjInfo | null {
        ensureCache();
        return cachedJjInfo;
      }

      function getWsName(): string | null {
        ensureCache();
        return cachedWsName;
      }

      function getSessionStats(): SessionStats {
        const entries = ctx.sessionManager.getEntries();
        const branchEntries = ctx.sessionManager.getBranch();

        const entriesLength = entries.length;
        const branchLength = branchEntries.length;
        const lastEntry = entriesLength > 0 ? entries[entriesLength - 1] : undefined;
        const lastBranchEntry = branchLength > 0 ? branchEntries[branchLength - 1] : undefined;

        const isCacheHit =
          cachedSessionStats !== null
          && cachedEntriesLength === entriesLength
          && cachedLastEntry === lastEntry
          && cachedBranchLength === branchLength
          && cachedLastBranchEntry === lastBranchEntry;

        if (isCacheHit) {
          return cachedSessionStats;
        }

        cachedSessionStats = computeSessionStats(entries, branchEntries);
        cachedEntriesLength = entriesLength;
        cachedLastEntry = lastEntry;
        cachedBranchLength = branchLength;
        cachedLastBranchEntry = lastBranchEntry;

        return cachedSessionStats;
      }

      return {
        invalidate() {
          lastFetch = 0; // Force refresh on next render
          cachedSessionStats = null;
          cachedEntriesLength = -1;
          cachedLastEntry = undefined;
          cachedBranchLength = -1;
          cachedLastBranchEntry = undefined;
        },
        render(width: number): string[] {
          // --- Line 1: cwd + jj info ---
          let pwd = process.cwd();
          const home = process.env.HOME || process.env.USERPROFILE;
          if (home && pwd.startsWith(home)) {
            pwd = `~${pwd.slice(home.length)}`;
          }

          // Workspace indicator (yellow, between cwd and change ID)
          const wsName = getWsName();
          const safeWsName = wsName ? sanitizeFooterText(wsName) : "";
          if (safeWsName) {
            pwd += " " + theme.fg("warning", `⎇ ${safeWsName}`);
          }

          const jj = getInfo();
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
            // Fall back to git branch if not a jj repo or jj failed
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
          const sessionStats = getSessionStats();
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
            statsLine,
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
}
