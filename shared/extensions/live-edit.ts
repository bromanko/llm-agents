/**
 * Editor Mode Experiment v3 — Widget approach
 *
 * Uses a widget above the editor to display the file content.
 * The transcript area shows LLM responses naturally.
 * No rendering conflicts since everything is in Pi's normal pipeline.
 *
 * Commands:
 *   /live-edit [filepath]  - Open a file in editor mode
 *   /live-edit-close       - Close editor mode
 *   /goto <line>      - Scroll file view to a specific line
 *   /view <lines>     - Set how many lines the file widget shows
 *
 * The LLM is given context about the open file via before_agent_start,
 * and the widget updates live via fs.watch when the file changes on disk.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import { highlightCode, getLanguageFromPath } from "@mariozechner/pi-coding-agent";

import { truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

interface EditorState {
	active: boolean;
	filePath: string;
	fileContent: string;
	scrollOffset: number;
	viewLines: number;
	fileChangeCount: number;
	watcher: fs.FSWatcher | null;
}

const state: EditorState = {
	active: false,
	filePath: "",
	fileContent: "",
	scrollOffset: 0,
	viewLines: 25,
	fileChangeCount: 0,
	watcher: null,
};

// Store reference for widget re-render
let widgetTui: TUI | null = null;

function readFile(): boolean {
	try {
		state.fileContent = fs.readFileSync(state.filePath, "utf-8");
		return true;
	} catch (e) {
		state.fileContent = `(error reading file: ${e})`;
		return false;
	}
}

function startWatching() {
	stopWatching();
	try {
		state.watcher = fs.watch(state.filePath, (_eventType) => {
			try {
				const newContent = fs.readFileSync(state.filePath, "utf-8");
				if (newContent !== state.fileContent) {
					state.fileContent = newContent;
					state.fileChangeCount++;
					updateWidget();
				}
			} catch {}
		});
	} catch {}
}

function stopWatching() {
	if (state.watcher) {
		state.watcher.close();
		state.watcher = null;
	}
}

function updateWidget() {
	// This is called to re-set the widget, which triggers Pi to re-render it
	if (!state.active || !widgetTui) return;
	widgetTui.requestRender();
}

// Trigger phrases that auto-submit dictated text.
// Matched case-insensitively at the end of the input after trimming.
// Punctuation is stripped before matching since dictation often adds periods.
const SUBMIT_TRIGGERS = ["send it", "go go go", "do it"];

export default function (pi: ExtensionAPI) {
	// =========================================================================
	// Dictation: poll editor text for trigger phrase and auto-submit
	// =========================================================================
	let dictationCtx: { ui: { getEditorText: () => string; setEditorText: (s: string) => void } } | null = null;
	let pollInterval: ReturnType<typeof setInterval> | null = null;

	function startDictationPoll() {
		if (pollInterval) return;
		pollInterval = setInterval(() => {
			if (!state.active || !dictationCtx) return;
			const raw = dictationCtx.ui.getEditorText();
			const text = raw.trim();
			if (!text) return;

			// Strip trailing punctuation that dictation might add
			const lower = text.toLowerCase().replace(/[.,!?]+$/, "").trimEnd();

			for (const trigger of SUBMIT_TRIGGERS) {
				if (lower.endsWith(trigger)) {
					const cleaned = text.slice(0, lower.lastIndexOf(trigger)).trim();
					if (cleaned) {
						dictationCtx.ui.setEditorText("");
						pi.sendUserMessage(cleaned);
					}
					return;
				}
			}
		}, 500); // Check every 500ms
	}

	function stopDictationPoll() {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		dictationCtx = ctx;
		startDictationPoll();
	});

	pi.on("session_shutdown", async () => {
		stopDictationPoll();
		dictationCtx = null;
	});

	// Also strip trigger phrase if user submits manually with Enter
	pi.on("input", async (event, _ctx) => {
		if (!state.active) return;
		const text = event.text.trim();
		const lower = text.toLowerCase().replace(/[.,!?]+$/, "").trimEnd();

		for (const trigger of SUBMIT_TRIGGERS) {
			if (lower.endsWith(trigger)) {
				const cleaned = text.slice(0, lower.lastIndexOf(trigger)).trim();
				if (cleaned) {
					return { action: "transform" as const, text: cleaned };
				}
			}
		}
	});

	// =========================================================================
	// Inject file context into LLM system prompt
	// =========================================================================
	pi.on("before_agent_start", async (event, _ctx) => {
		if (!state.active) return;

		const fileInfo = [
			`\n\n## Editor Mode — Active File`,
			``,
			`You are in editor mode. The user is working on a single file:`,
			`- **Path**: ${state.filePath}`,
			`- **Lines**: ${state.fileContent.split("\n").length}`,
			``,
			`The user's instructions relate to this file. Use the \`edit\` and \`write\` tools to modify it.`,
			`When the user asks to make changes, apply them to this specific file.`,
			``,
			`### Current file content:`,
			"```",
			state.fileContent,
			"```",
		].join("\n");

		return {
			systemPrompt: event.systemPrompt + fileInfo,
		};
	});

	// =========================================================================
	// /open command
	// =========================================================================
	pi.registerCommand("live-edit", {
		description: "Open a file in editor mode",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const filePath = args.trim();
			if (!filePath) {
				ctx.ui.notify("Usage: /live-edit <filepath>", "warning");
				return;
			}

			const resolved = path.resolve(ctx.cwd, filePath);

			// Create if doesn't exist
			if (!fs.existsSync(resolved)) {
				const ok = await ctx.ui.confirm(
					"File not found",
					`Create ${resolved}?`,
				);
				if (!ok) return;
				fs.mkdirSync(path.dirname(resolved), { recursive: true });
				fs.writeFileSync(resolved, "");
			}

			// Set up state
			state.active = true;
			state.filePath = resolved;
			state.scrollOffset = 0;
			state.fileChangeCount = 0;
			readFile();
			startWatching();

			// Set up the widget below the editor input
			ctx.ui.setWidget("editor-file", (tui, theme) => {
				widgetTui = tui;
				return {
					render(width: number): string[] {
						return renderFileWidget(width, theme);
					},
					invalidate() {},
				};
			}, { placement: "belowEditor" });

			ctx.ui.notify(`Opened: ${state.filePath}`, "info");
		},
	});

	// =========================================================================
	// /close command
	// =========================================================================
	pi.registerCommand("live-edit-close", {
		description: "Close editor mode",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			if (!state.active) {
				ctx.ui.notify("No file open", "warning");
				return;
			}

			stopWatching();
			state.active = false;
			state.filePath = "";
			state.fileContent = "";

			ctx.ui.setWidget("editor-file", undefined);
			ctx.ui.notify("Editor mode closed", "info");
		},
	});

	// =========================================================================
	// /goto command — scroll to a line
	// =========================================================================
	pi.registerCommand("goto", {
		description: "Scroll file view to a specific line",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			if (!state.active) {
				ctx.ui.notify("No file open", "warning");
				return;
			}

			const line = parseInt(args.trim(), 10);
			if (isNaN(line) || line < 1) {
				ctx.ui.notify("Usage: /goto <line-number>", "warning");
				return;
			}

			const totalLines = state.fileContent.split("\n").length;
			// Center the target line in the view
			state.scrollOffset = Math.max(
				0,
				Math.min(line - Math.floor(state.viewLines / 2), totalLines - state.viewLines),
			);
			updateWidget();
			ctx.ui.notify(`Scrolled to line ${line}`, "info");
		},
	});

	// =========================================================================
	// /view command — set visible line count
	// =========================================================================
	pi.registerCommand("view", {
		description: "Set number of visible file lines (e.g. /view 30)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const count = parseInt(args.trim(), 10);
			if (isNaN(count) || count < 5 || count > 80) {
				ctx.ui.notify("Usage: /view <5-80>", "warning");
				return;
			}

			state.viewLines = count;
			updateWidget();
			ctx.ui.notify(`File view: ${count} lines`, "info");
		},
	});

	// =========================================================================
	// Scroll shortcuts
	// =========================================================================
	// =========================================================================
	// Cycle widget height: 20% → 50% → 80%
	// =========================================================================
	const heightPresets = [0.2, 0.5, 0.8];
	let currentPreset = 0; // start at 20%

	pi.registerShortcut("f2", {
		description: "Cycle file view height (20% / 50% / 80%)",
		handler: async (ctx) => {
			if (!state.active) return;
			currentPreset = (currentPreset + 1) % heightPresets.length;
			const termHeight = process.stdout.rows || 40;
			const pct = heightPresets[currentPreset]!;
			state.viewLines = Math.max(5, Math.min(80, Math.floor(termHeight * pct) - 2)); // -2 for borders
			updateWidget();
			ctx.ui.notify(`File view: ${Math.round(pct * 100)}% (${state.viewLines} lines)`, "info");
		},
	});

	pi.registerShortcut("ctrl+shift+up", {
		description: "Scroll file view up",
		handler: async (_ctx) => {
			if (!state.active) return;
			state.scrollOffset = Math.max(0, state.scrollOffset - 3);
			updateWidget();
		},
	});

	pi.registerShortcut("ctrl+shift+down", {
		description: "Scroll file view down",
		handler: async (_ctx) => {
			if (!state.active) return;
			const totalLines = state.fileContent.split("\n").length;
			state.scrollOffset = Math.min(
				Math.max(0, totalLines - state.viewLines),
				state.scrollOffset + 3,
			);
			updateWidget();
		},
	});

	// =========================================================================
	// Auto-scroll to edit location when LLM edits the file
	// =========================================================================
	pi.on("tool_result", async (event, _ctx) => {
		if (!state.active) return;

		// Check if this tool modified our file
		if (
			(event.toolName === "edit" || event.toolName === "write") &&
			event.input &&
			typeof event.input === "object" &&
			"path" in event.input
		) {
			const toolPath = path.resolve(String(event.input.path));
			if (toolPath === state.filePath) {
				// Re-read and update
				readFile();

				// For edits, try to scroll to the edited region
				if (event.toolName === "edit" && "oldText" in event.input) {
					const oldText = String(event.input.oldText);
					const newText = String(event.input.newText);
					// Find where the new text is in the file
					const idx = state.fileContent.indexOf(newText);
					if (idx !== -1) {
						const lineNum = state.fileContent.substring(0, idx).split("\n").length;
						state.scrollOffset = Math.max(0, lineNum - Math.floor(state.viewLines / 2));
					}
				}

				updateWidget();
			}
		}
	});

	// =========================================================================
	// Cleanup on shutdown
	// =========================================================================
	pi.on("session_shutdown", async () => {
		stopWatching();
	});
}

// =============================================================================
// File widget renderer
// =============================================================================
function renderFileWidget(width: number, theme: Theme): string[] {
	if (!state.active) return [];

	const lines: string[] = [];
	// Syntax-highlight the file content
	// highlightCode works for programming languages but not markdown,
	// so we use a custom highlighter for .md files
	const lang = getLanguageFromPath(state.filePath);
	const highlightedLines = lang === "markdown"
		? highlightMarkdownLines(state.fileContent.split("\n"), theme)
		: highlightCode(state.fileContent, lang);
	const totalLines = highlightedLines.length;
	const maxLineNumWidth = String(totalLines).length;

	// Top border with file info
	const fileName = path.basename(state.filePath);
	const dirName = path.dirname(state.filePath);
	const lineRange = `L${state.scrollOffset + 1}-${Math.min(state.scrollOffset + state.viewLines, totalLines)}/${totalLines}`;
	const scrollPct =
		totalLines <= state.viewLines
			? "all"
			: `${Math.round((state.scrollOffset / Math.max(1, totalLines - state.viewLines)) * 100)}%`;

	const headerLeft = theme.fg("accent", ` ${fileName} `) + theme.fg("dim", `${dirName}`);
	const headerRight = theme.fg("dim", `${lineRange} (${scrollPct}) `);
	const headerFill = Math.max(0, width - visibleWidth(headerLeft) - visibleWidth(headerRight) - 2);

	lines.push(
		theme.fg("border", "┌") +
		headerLeft +
		theme.fg("border", "─".repeat(headerFill)) +
		headerRight +
		theme.fg("border", "┐"),
	);

	// File content
	const visibleLines = highlightedLines.slice(state.scrollOffset, state.scrollOffset + state.viewLines);
	const innerWidth = width - 2; // borders

	for (let i = 0; i < state.viewLines; i++) {
		if (i < visibleLines.length) {
			const lineNum = String(state.scrollOffset + i + 1).padStart(maxLineNumWidth, " ");
			const lineContent = visibleLines[i] || "";
			const formatted =
				theme.fg("dim", ` ${lineNum} │ `) +
				truncateToWidth(lineContent, innerWidth - maxLineNumWidth - 5);
			lines.push(theme.fg("border", "│") + padLine(formatted, innerWidth, theme) + theme.fg("border", "│"));
		} else {
			// Empty line below file content
			const tilde = theme.fg("dim", ` ${"~".padStart(maxLineNumWidth, " ")}   `);
			lines.push(theme.fg("border", "│") + padLine(tilde, innerWidth, theme) + theme.fg("border", "│"));
		}
	}

	// Bottom border with scroll hints
	const hint = theme.fg("dim", ` Ctrl+Shift+↑↓: scroll │ F2: resize │ /goto <line> │ /live-edit-close `);
	const hintFill = Math.max(0, width - visibleWidth(hint) - 2);
	lines.push(
		theme.fg("border", "└") +
		hint +
		theme.fg("border", "─".repeat(hintFill)) +
		theme.fg("border", "┘"),
	);

	return lines;
}

function padLine(str: string, targetWidth: number, theme: Theme): string {
	const vis = visibleWidth(str);
	if (vis >= targetWidth) return truncateToWidth(str, targetWidth);
	return str + " ".repeat(targetWidth - vis);
}

// =============================================================================
// Markdown highlighter — fills the gap that cli-highlight doesn't cover
// =============================================================================
function highlightMarkdownLines(lines: string[], theme: Theme): string[] {
	let inCodeBlock = false;

	return lines.map((line) => {
		if (line.trimStart().startsWith("```")) {
			inCodeBlock = !inCodeBlock;
			return theme.fg("mdCodeBlockBorder", line);
		}
		if (inCodeBlock) return theme.fg("mdCodeBlock", line);
		if (/^(#{1,6})\s+/.test(line)) return theme.fg("mdHeading", theme.bold(line));
		if (/^(-{3,}|_{3,}|\*{3,})\s*$/.test(line)) return theme.fg("mdHr", line);
		if (line.trimStart().startsWith(">")) {
			return theme.fg("mdQuoteBorder", ">") + theme.fg("mdQuote", line.slice(line.indexOf(">") + 1));
		}
		const listMatch = line.match(/^(\s*)([-*+]|\d+\.)\s/);
		if (listMatch) {
			const pre = listMatch[1]! + listMatch[2]!;
			return theme.fg("mdListBullet", pre) + " " + inlineMd(line.slice(pre.length + 1), theme);
		}
		return inlineMd(line, theme);
	});
}

function inlineMd(text: string, theme: Theme): string {
	text = text.replace(/\*\*(.+?)\*\*/g, (_m, p1) => theme.bold(p1));
	text = text.replace(/__(.+?)__/g, (_m, p1) => theme.bold(p1));
	text = text.replace(/\*(.+?)\*/g, (_m, p1) => theme.italic(p1));
	text = text.replace(/_(.+?)_/g, (_m, p1) => theme.italic(p1));
	text = text.replace(/`([^`]+)`/g, (_m, p1) => theme.fg("mdCode", p1));
	text = text.replace(
		/\[([^\]]+)\]\(([^)]+)\)/g,
		(_m, label, url) => theme.fg("mdLink", `[${label}]`) + theme.fg("mdLinkUrl", `(${url})`),
	);
	return text;
}


