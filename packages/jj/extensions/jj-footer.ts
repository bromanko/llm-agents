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
import { execSync } from "node:child_process";
import { isJjRepo } from "../lib/utils.ts";

/**
 * Detect the current jj workspace name.
 * Returns null if in the default workspace or not in a workspace.
 */
function detectWorkspaceName(cwd: string): string | null {
	try {
		const ourChangeId = execSync(
			`jj log -r '@' -T 'change_id' --no-graph`,
			{ cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
		).trim();

		const listOutput = execSync(
			`jj workspace list -T 'name ++ ":" ++ self.target().change_id() ++ "\\n"'`,
			{ cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
		).trim();

		for (const line of listOutput.split("\n")) {
			const sep = line.indexOf(":");
			if (sep === -1) continue;
			const name = line.slice(0, sep);
			const changeId = line.slice(sep + 1);
			if (changeId === ourChangeId && name !== "default") {
				return name;
			}
		}
	} catch {
		// Not in a workspace or jj not available
	}
	return null;
}

interface JjInfo {
	uniquePrefix: string;
	rest: string;
	description: string;
	empty: boolean;
	insertions: number;
	deletions: number;
}

function getJjInfo(cwd: string): JjInfo | null {
	try {
		// Get change ID parts and description
		const logOutput = execSync(
			`jj log -r '@' -T 'concat(change_id.shortest(0), "|", change_id.short(), "|", description.first_line(), "|", if(empty, "empty", "dirty"))' --no-graph`,
			{ cwd, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
		).trim();

		const [uniquePrefix, fullShort, description, emptyFlag] = logOutput.split("|");

		// The rest is the portion of the short ID after the unique prefix
		const rest = fullShort.slice(uniquePrefix.length);

		// Get diff stats for working copy
		let insertions = 0;
		let deletions = 0;
		try {
			const statOutput = execSync(`jj diff --stat`, {
				cwd,
				encoding: "utf-8",
				timeout: 3000,
				stdio: ["pipe", "pipe", "pipe"],
			}).trim();

			// Parse the summary line: "N files changed, X insertions(+), Y deletions(-)"
			const match = statOutput.match(/(\d+) insertions?\(\+\).*?(\d+) deletions?\(-\)/);
			if (match) {
				insertions = parseInt(match[1], 10);
				deletions = parseInt(match[2], 10);
			}
		} catch {
			// diff stats are best-effort
		}

		return {
			uniquePrefix,
			rest,
			description: description || "",
			empty: emptyFlag === "empty",
			insertions,
			deletions,
		};
	} catch {
		return null;
	}
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		if (!isJjRepo(ctx.cwd)) return;

		const wsName = detectWorkspaceName(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData) => {
			// Poll for jj changes periodically
			let cachedJjInfo: JjInfo | null = null;
			let lastFetch = 0;
			const CACHE_MS = 3000;

			function getInfo(): JjInfo | null {
				const now = Date.now();
				if (now - lastFetch > CACHE_MS) {
					cachedJjInfo = getJjInfo(ctx.cwd);
					lastFetch = now;
				}
				return cachedJjInfo;
			}

			return {
				invalidate() {
					lastFetch = 0; // Force refresh on next render
				},
				render(width: number): string[] {
					const state = ctx.sessionManager as any;
					const entries = ctx.sessionManager.getEntries();

					// --- Line 1: cwd + jj info ---
					let pwd = process.cwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home && pwd.startsWith(home)) {
						pwd = `~${pwd.slice(home.length)}`;
					}

					// Workspace indicator (yellow, between cwd and change ID)
					if (wsName) {
						pwd += " " + theme.fg("warning", `⎇ ${wsName}`);
					}

					const jj = getInfo();
					if (jj) {
						// Style change ID like jj log: unique prefix highlighted, rest dimmed
						const changeId =
							theme.fg("accent", theme.bold(jj.uniquePrefix)) + theme.fg("dim", jj.rest);

						let jjParts = changeId;

						if (jj.description) {
							jjParts += " " + theme.fg("muted", jj.description);
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
					if (sessionName) {
						pwd = `${pwd} • ${sessionName}`;
					}

					// --- Line 2: token stats + model (replicate default behavior) ---
					let totalInput = 0;
					let totalOutput = 0;
					let totalCacheRead = 0;
					let totalCacheWrite = 0;
					let totalCost = 0;

					for (const entry of entries) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const m = entry.message as AssistantMessage;
							totalInput += m.usage.input;
							totalOutput += m.usage.output;
							totalCacheRead += m.usage.cacheRead;
							totalCacheWrite += m.usage.cacheWrite;
							totalCost += m.usage.cost.total;
						}
					}

					// Context percentage from last non-aborted assistant message
					const branchEntries = ctx.sessionManager.getBranch();
					const messages = branchEntries
						.filter((e) => e.type === "message")
						.map((e) => (e as any).message);
					const lastAssistant = messages
						.slice()
						.reverse()
						.find((m: any) => m.role === "assistant" && m.stopReason !== "aborted");

					const contextTokens = lastAssistant
						? lastAssistant.usage.input +
							lastAssistant.usage.output +
							lastAssistant.usage.cacheRead +
							lastAssistant.usage.cacheWrite
						: 0;
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

					let statsLeft = statsParts.join(" ");
					const statsLeftWidth = visibleWidth(statsLeft);

					// Model + thinking level on the right
					const modelName = ctx.model?.id || "no-model";
					let rightSide = modelName;
					if (ctx.model?.reasoning) {
						const thinkingLevel = (ctx as any).thinkingLevel || pi.getThinkingLevel();
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
						statsLine = statsLeft + padding + rightSide;
					} else {
						const availableForRight = width - statsLeftWidth - 2;
						if (availableForRight > 3) {
							const plainRight = rightSide.replace(/\x1b\[[0-9;]*m/g, "");
							const truncated = plainRight.substring(0, availableForRight);
							const padding = " ".repeat(width - statsLeftWidth - truncated.length);
							statsLine = statsLeft + padding + truncated;
						} else {
							statsLine = statsLeft;
						}
					}

					const dimStatsLeft = theme.fg("dim", statsLeft);
					const remainder = statsLine.slice(statsLeft.length);
					const dimRemainder = theme.fg("dim", remainder);

					const lines = [
						truncateToWidth(theme.fg("dim", pwd), width),
						dimStatsLeft + dimRemainder,
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
