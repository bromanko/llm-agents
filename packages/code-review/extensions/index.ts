/**
 * Interactive Code Review Extension
 *
 * /review <language> [types...]  — Run review skills and iterate findings
 *
 * Examples:
 *   /review gleam             — all gleam review skills (code, security, performance, test)
 *   /review gleam code        — only gleam-code-review
 *   /review fsharp security test — fsharp-security-review + fsharp-test-review
 *
 * Flow:
 *   1. Discovers matching review skills
 *   2. Reads code (via jj diff / git diff or user-specified scope)
 *   3. Runs each skill via complete() with a spinner
 *   4. Parses structured findings from LLM output
 *   5. Presents findings one-at-a-time in an inline TUI
 *   6. User picks: Fix / Fix with instructions / Skip / Stop
 *   7. "Fix" queues targeted follow-up user messages while you keep reviewing
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
} from "@mariozechner/pi-tui";
import * as fs from "node:fs";

import { type Finding, parseFindings } from "../lib/parser.ts";
import { notifyQueueSummary, processFindingActions } from "../lib/fix-flow.js";
import {
  discoverReviewSkills,
  filterSkills,
  getLanguages,
  getSkillsDirs,
  getTypesForLanguage,
  type ReviewSkill,
} from "../lib/skills.ts";

/** Actions the user can take on a finding */
type FindingAction =
  | { type: "fix" }
  | { type: "fix-custom"; instructions: string }
  | { type: "skip" }
  | { type: "stop" };

const SEVERITY_COLORS: Record<string, string> = {
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "muted",
};

export default function (pi: ExtensionAPI) {
  // Discover skills once on load
  const allSkills = discoverReviewSkills(getSkillsDirs());
  const languages = getLanguages(allSkills);

  pi.registerCommand("review", {
    description:
      "Run code review skills and iterate through findings interactively",

    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const parts = prefix.split(/\s+/);

      // First arg: language
      if (parts.length <= 1) {
        const items = languages.map((l) => ({ value: l, label: l }));
        const filtered = items.filter((i) =>
          i.value.startsWith(parts[0] || ""),
        );
        return filtered.length > 0 ? filtered : null;
      }

      // Subsequent args: review types for chosen language
      const lang = parts[0];
      const typedSoFar = parts.slice(1);
      const lastPart = typedSoFar[typedSoFar.length - 1] || "";
      const alreadyChosen = typedSoFar.slice(0, -1);

      const available = getTypesForLanguage(allSkills, lang).filter(
        (t) => !alreadyChosen.includes(t),
      );
      const items = available.map((t) => ({
        value: [...parts.slice(0, -1), t].join(" "),
        label: t,
      }));
      const filtered = items.filter((i) =>
        i.label.startsWith(lastPart),
      );
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("review requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      // Parse args
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) {
        const langs = languages.join(", ");
        ctx.ui.notify(
          `Usage: /review <language> [types...]\nLanguages: ${langs}`,
          "warning",
        );
        return;
      }

      const language = parts[0];
      const typeFilter = parts.length > 1 ? parts.slice(1) : undefined;
      const skills = filterSkills(allSkills, language, typeFilter);

      if (skills.length === 0) {
        const available = getTypesForLanguage(allSkills, language);
        if (available.length === 0) {
          ctx.ui.notify(
            `No review skills found for "${language}". Available: ${languages.join(", ")}`,
            "error",
          );
        } else {
          ctx.ui.notify(
            `No matching review types. Available for ${language}: ${available.join(", ")}`,
            "error",
          );
        }
        return;
      }

      ctx.ui.notify(
        `Running ${skills.length} review skill${skills.length > 1 ? "s" : ""}: ${skills.map((s) => s.type).join(", ")}`,
        "info",
      );

      // Gather code context (diff or full project)
      const codeContext = await gatherCodeContext(pi, ctx);
      if (codeContext === null) {
        ctx.ui.notify("No code to review", "warning");
        return;
      }

      // Run each skill and collect findings
      const allFindings = await runReviews(pi, ctx, skills, codeContext);

      if (allFindings === null) {
        ctx.ui.notify("Review cancelled", "info");
        return;
      }

      if (allFindings.length === 0) {
        ctx.ui.notify("No issues found! 🎉", "success");
        return;
      }

      // Sort: HIGH first, then MEDIUM, then LOW
      const severityOrder: Record<string, number> = {
        HIGH: 0,
        MEDIUM: 1,
        LOW: 2,
      };
      allFindings.sort(
        (a, b) =>
          (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
      );

      ctx.ui.notify(
        `Found ${allFindings.length} issue${allFindings.length > 1 ? "s" : ""}. Let's go through them.`,
        "info",
      );

      const result = await processFindingActions({
        pi,
        ctx,
        findings: allFindings,
        showFinding: (finding: Finding, index: number, total: number) =>
          showFinding(ctx, finding, index, total),
        buildFixMessage,
      });

      if (result.stoppedAt !== null) {
        ctx.ui.notify(
          `Stopped at finding ${result.stoppedAt + 1}/${allFindings.length}`,
          "info",
        );
      }

      notifyQueueSummary(ctx, result);

      ctx.ui.notify("Review complete", "info");
    },
  });
}

/**
 * Gather code to review — checks jj, then git, for diffs.
 * Returns the diff text or null if nothing found.
 */
async function gatherCodeContext(
  pi: ExtensionAPI,
  ctx: { cwd: string },
): Promise<string | null> {
  // Try jj first
  const jjResult = await pi.exec("jj", ["diff"], {
    timeout: 10000,
  });
  if (jjResult.code === 0 && jjResult.stdout.trim().length > 0) {
    return jjResult.stdout;
  }

  // Try git
  const gitResult = await pi.exec("git", ["diff"], {
    timeout: 10000,
  });
  if (gitResult.code === 0 && gitResult.stdout.trim().length > 0) {
    return gitResult.stdout;
  }

  // Try git staged
  const gitStagedResult = await pi.exec("git", ["diff", "--cached"], {
    timeout: 10000,
  });
  if (
    gitStagedResult.code === 0 &&
    gitStagedResult.stdout.trim().length > 0
  ) {
    return gitStagedResult.stdout;
  }

  return null;
}

/**
 * Run all review skills against the code context.
 * Shows a spinner while processing.
 */
async function runReviews(
  pi: ExtensionAPI,
  ctx: any,
  skills: ReviewSkill[],
  codeContext: string,
): Promise<Finding[] | null> {
  const result = await ctx.ui.custom<Finding[] | null>(
    (tui: any, theme: any, _kb: any, done: (v: Finding[] | null) => void) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Running ${skills.length} review${skills.length > 1 ? "s" : ""}...`,
      );
      loader.onAbort = () => done(null);

      const doReviews = async () => {
        const findings: Finding[] = [];

        for (let i = 0; i < skills.length; i++) {
          const skill = skills[i];

          // Update the inner loader's message to show progress
          // The loader field is the CancellableLoader/Loader which has setMessage()
          (loader as any).loader?.setMessage?.(
            `[${i + 1}/${skills.length}] Running ${skill.name}...`,
          );

          const skillContent = fs.readFileSync(skill.path, "utf-8");
          const apiKey = await ctx.modelRegistry.getApiKey(ctx.model!);

          const systemPrompt = `You are a code reviewer. Follow these instructions precisely.

${skillContent}

IMPORTANT: Output findings in the exact format specified. Each finding MUST start with ### [SEVERITY] on its own line.`;

          const userMessage: UserMessage = {
            role: "user",
            content: [
              {
                type: "text",
                text: `Please review the following code changes:\n\n\`\`\`diff\n${codeContext}\n\`\`\``,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            ctx.model!,
            { systemPrompt, messages: [userMessage] },
            { apiKey, signal: loader.signal },
          );

          if (response.stopReason === "aborted") {
            return null;
          }

          const responseText = response.content
            .filter(
              (c: any): c is { type: "text"; text: string } =>
                c.type === "text",
            )
            .map((c: any) => c.text)
            .join("\n");

          findings.push(...parseFindings(responseText, skill.name));
        }

        return findings;
      };

      doReviews()
        .then(done)
        .catch((err) => {
          console.error("Review failed:", err);
          done(null);
        });

      return loader;
    },
  );

  return result;
}

/**
 * Show a single finding in an inline TUI and get the user's action.
 */
async function showFinding(
  ctx: any,
  finding: Finding,
  index: number,
  total: number,
): Promise<FindingAction> {
  return ctx.ui.custom<FindingAction>(
    (tui: any, theme: any, _kb: any, done: (v: FindingAction) => void) => {
      let selectedOption = 0;
      let inputMode = false;
      let inputBuffer = "";
      let cachedLines: string[] | undefined;

      const options = [
        { label: "Fix it", action: { type: "fix" } as FindingAction },
        {
          label: "Fix with custom instructions",
          action: { type: "fix-custom", instructions: "" } as FindingAction,
        },
        { label: "Skip", action: { type: "skip" } as FindingAction },
        {
          label: "Stop reviewing",
          action: { type: "stop" } as FindingAction,
        },
      ];

      function refresh() {
        cachedLines = undefined;
        tui.requestRender();
      }

      function handleInput(data: string) {
        if (inputMode) {
          if (matchesKey(data, Key.escape)) {
            inputMode = false;
            inputBuffer = "";
            refresh();
            return;
          }
          if (matchesKey(data, Key.enter)) {
            const trimmed = inputBuffer.trim();
            if (trimmed) {
              done({ type: "fix-custom", instructions: trimmed });
            } else {
              inputMode = false;
              inputBuffer = "";
              refresh();
            }
            return;
          }
          if (matchesKey(data, Key.backspace)) {
            inputBuffer = inputBuffer.slice(0, -1);
            refresh();
            return;
          }
          // Printable characters
          if (data.length === 1 && data.charCodeAt(0) >= 32) {
            inputBuffer += data;
            refresh();
            return;
          }
          return;
        }

        if (matchesKey(data, Key.up)) {
          selectedOption = Math.max(0, selectedOption - 1);
          refresh();
        } else if (matchesKey(data, Key.down)) {
          selectedOption = Math.min(options.length - 1, selectedOption + 1);
          refresh();
        } else if (matchesKey(data, Key.enter)) {
          if (selectedOption === 1) {
            // Fix with custom instructions — enter input mode
            inputMode = true;
            inputBuffer = "";
            refresh();
          } else {
            done(options[selectedOption].action);
          }
        } else if (matchesKey(data, Key.escape)) {
          done({ type: "skip" });
        }
      }

      function render(width: number): string[] {
        if (cachedLines) return cachedLines;

        const lines: string[] = [];
        const add = (s: string) =>
          lines.push(truncateToWidth(s, width));
        const blank = () => lines.push("");

        // Top border
        add(theme.fg("accent", "─".repeat(width)));

        // Header: severity badge + title + counter
        const severityColor = SEVERITY_COLORS[finding.severity] || "text";
        const counter = theme.fg("dim", `[${index + 1}/${total}]`);
        const badge = theme.fg(
          severityColor,
          theme.bold(` ${finding.severity} `),
        );
        add(
          ` ${badge}  ${theme.fg("text", theme.bold(finding.title))}  ${counter}`,
        );

        // File + category
        if (finding.file) {
          add(` ${theme.fg("dim", "File:")} ${theme.fg("accent", finding.file)}`);
        }
        if (finding.category) {
          add(
            ` ${theme.fg("dim", "Category:")} ${theme.fg("muted", finding.category)}  ${theme.fg("dim", "Skill:")} ${theme.fg("muted", finding.skill)}`,
          );
        } else {
          add(` ${theme.fg("dim", "Skill:")} ${theme.fg("muted", finding.skill)}`);
        }

        blank();

        // Issue
        add(` ${theme.fg("text", theme.bold("Issue:"))}`);
        for (const line of wrapText(finding.issue, width - 3)) {
          add(`   ${theme.fg("text", line)}`);
        }

        blank();

        // Suggestion
        add(` ${theme.fg("text", theme.bold("Suggestion:"))}`);
        for (const line of wrapText(finding.suggestion, width - 3)) {
          add(`   ${theme.fg("text", line)}`);
        }

        // Effort
        if (finding.effort) {
          blank();
          add(
            ` ${theme.fg("dim", "Effort:")} ${theme.fg("muted", finding.effort)}`,
          );
        }

        blank();

        // Options
        for (let i = 0; i < options.length; i++) {
          const selected = i === selectedOption;
          const prefix = selected
            ? theme.fg("accent", "> ")
            : "  ";
          const color = selected ? "accent" : "text";
          add(`${prefix}${theme.fg(color, `${i + 1}. ${options[i].label}`)}`);
        }

        // Custom instructions input
        if (inputMode) {
          blank();
          add(
            ` ${theme.fg("muted", "Instructions:")} ${theme.fg("text", inputBuffer)}${theme.fg("accent", "█")}`,
          );
          add(
            theme.fg("dim", " Enter to submit • Esc to cancel"),
          );
        }

        blank();

        // Help text
        if (!inputMode) {
          add(
            theme.fg("dim", " ↑↓ navigate • Enter select • Esc skip"),
          );
        }

        // Bottom border
        add(theme.fg("accent", "─".repeat(width)));

        cachedLines = lines;
        return lines;
      }

      return {
        render,
        invalidate: () => {
          cachedLines = undefined;
        },
        handleInput,
      };
    },
  );
}

/**
 * Build a fix message for the agent.
 */
function buildFixMessage(
  finding: Finding,
  customInstructions?: string,
): string {
  let message = `Please fix the following code review finding:\n\n`;
  message += `**${finding.severity}: ${finding.title}**\n`;
  if (finding.file) {
    message += `File: ${finding.file}\n`;
  }
  message += `\nIssue: ${finding.issue}\n`;
  message += `\nSuggested fix: ${finding.suggestion}\n`;

  if (customInstructions) {
    message += `\nAdditional instructions: ${customInstructions}\n`;
  }

  return message;
}

/**
 * Simple word-wrap that respects width.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= maxWidth) {
      lines.push(paragraph);
      continue;
    }

    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= maxWidth) {
        current += " " + word;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}
