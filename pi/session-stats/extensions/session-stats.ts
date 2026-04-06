import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import { parseCommandArgs } from "../lib/command-args.ts";
import { resolveDateRange } from "../lib/date-range.ts";
import { scanSessionFiles } from "../lib/scan-sessions.ts";
import { aggregateUsage } from "../lib/aggregate.ts";
import { formatReport } from "../lib/format.ts";
import * as path from "node:path";
import * as fs from "node:fs";

const RANGE_COMPLETIONS: AutocompleteItem[] = [
  { value: "today", label: "today", description: "Today's usage" },
  { value: "yesterday", label: "yesterday", description: "Yesterday's usage" },
  {
    value: "last 7 days",
    label: "last 7 days",
    description: "Past 7 days (default)",
  },
  {
    value: "last 30 days",
    label: "last 30 days",
    description: "Past 30 days",
  },
  { value: "this week", label: "this week", description: "Since Monday" },
  {
    value: "last week",
    label: "last week",
    description: "Previous Monday–Sunday",
  },
  { value: "this month", label: "this month", description: "Since the 1st" },
  {
    value: "last month",
    label: "last month",
    description: "Previous calendar month",
  },
  {
    value: "all time",
    label: "all time",
    description: "All saved sessions",
  },
];

const BREAKDOWN_COMPLETIONS: AutocompleteItem[] = [
  { value: "by day", label: "by day", description: "Group by day" },
  {
    value: "by project",
    label: "by project",
    description: "Group by project",
  },
  { value: "by model", label: "by model", description: "Group by model" },
];

const HELP_TEXT = [
  "/session-stats [range] [by day|project|model]",
  "",
  "Ranges:",
  "  today, yesterday, last 7 days, last 30 days,",
  "  this week, last week, this month, last month,",
  "  all time, YYYY-MM-DD..YYYY-MM-DD",
  "",
  "Examples:",
  "  /session-stats",
  "  /session-stats today",
  "  /session-stats last 7 days by project",
  "  /session-stats 2026-04-01..2026-04-06 by day",
  "  /session-stats all time by model",
  "",
  "Notes:",
  "  Scans all saved sessions across all projects.",
  "  Only saved sessions are counted.",
  "  Ranges are in local time.",
  "  Does not invoke a model.",
];

/**
 * Factory for creating a bordered text overlay with a title bar, body, and
 * footer. Used by both the help overlay and the results overlay to avoid
 * duplicating the border-drawing / input-handling logic.
 */
function createBorderedTextOverlay(
  tuiMod: {
    Text: new (text: string, px: number, py: number) => {
      render(width: number): string[];
      invalidate(): void;
    };
    truncateToWidth(
      text: string,
      width: number,
      ellipsis: string,
      left: boolean,
    ): string;
    visibleWidth(text: string): number;
    matchesKey(data: string, key: string): boolean;
  },
  theme: { fg(style: string, text: string): string },
  title: string,
  bodyText: string,
  done: (value: undefined) => void,
) {
  const content = new tuiMod.Text(bodyText, 1, 1);
  const footer = new tuiMod.Text(
    theme.fg("dim", "Press Enter or Esc to close"),
    1,
    0,
  );

  const padLine = (line: string, width: number) => {
    const truncated = tuiMod.truncateToWidth(line, width, "...", true);
    return (
      truncated +
      " ".repeat(Math.max(0, width - tuiMod.visibleWidth(truncated)))
    );
  };

  return {
    render: (width: number) => {
      const innerW = Math.max(1, width - 2);
      const border = (s: string) => theme.fg("border", s);
      const titleText = tuiMod.truncateToWidth(
        title,
        Math.max(1, innerW - 4),
        "",
        true,
      );
      const leftSegment = "─ ";
      const middleGap = " ";
      const rightRuleWidth = Math.max(
        0,
        innerW -
        tuiMod.visibleWidth(leftSegment) -
        tuiMod.visibleWidth(titleText) -
        tuiMod.visibleWidth(middleGap),
      );

      const lines: string[] = [];
      lines.push(
        border(`╭${leftSegment}`) +
        theme.fg("accent", titleText) +
        border(`${middleGap}${"─".repeat(rightRuleWidth)}╮`),
      );

      for (const line of content.render(innerW)) {
        lines.push(border("│") + padLine(line, innerW) + border("│"));
      }

      lines.push(border("│") + " ".repeat(innerW) + border("│"));

      for (const line of footer.render(innerW)) {
        lines.push(border("│") + padLine(line, innerW) + border("│"));
      }

      lines.push(border(`╰${"─".repeat(innerW)}╯`));
      return lines;
    },
    invalidate: () => {
      content.invalidate();
      footer.invalidate();
    },
    handleInput: (data: string) => {
      if (
        tuiMod.matchesKey(data, "enter") ||
        tuiMod.matchesKey(data, "escape")
      ) {
        done(undefined);
      }
    },
  };
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("session-stats", {
    description: "Show token usage and cost across all saved sessions",
    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const lower = prefix.toLowerCase().trim();

      // Already has a complete breakdown — no more completions
      if (/\bby\s+(day|project|model)\s*$/i.test(prefix)) {
        return null;
      }

      // Typing "by " — offer breakdown kinds
      if (/\bby\s*$/i.test(prefix)) {
        return BREAKDOWN_COMPLETIONS;
      }

      // Offer range completions
      const items = [...RANGE_COMPLETIONS, ...BREAKDOWN_COMPLETIONS].filter(
        (c) =>
          !lower ||
          c.value.toLowerCase().startsWith(lower) ||
          c.value.toLowerCase().includes(lower),
      );

      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseCommandArgs(args);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(msg, "error");
        return;
      }

      if (command.help) {
        if (!ctx.hasUI) {
          ctx.ui.notify(HELP_TEXT.join("\n"), "info");
          return;
        }

        const tuiMod = await import("@mariozechner/pi-tui");

        await ctx.ui.custom<void>(
          (_tui, theme, _kb, done) => {
            return createBorderedTextOverlay(
              tuiMod,
              theme,
              "session-stats help",
              HELP_TEXT.join("\n"),
              done,
            );
          },
          { overlay: true },
        );
        return;
      }

      if (!ctx.hasUI) {
        ctx.ui.notify("session-stats requires interactive mode", "error");
        return;
      }

      let range;
      try {
        range = resolveDateRange(command.rangeExpression);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(msg, "error");
        return;
      }

      const piMod = await import("@mariozechner/pi-coding-agent");
      const tuiMod = await import("@mariozechner/pi-tui");

      const sessionsRoot = path.join(piMod.getAgentDir(), "sessions");
      const loader = {
        loadEntriesFromFile: async (filePath: string) => {
          try {
            const content = await fs.promises.readFile(filePath, "utf-8");
            return piMod.parseSessionEntries(content);
          } catch {
            return [];
          }
        },
        migrateSessionEntries: piMod.migrateSessionEntries,
      };

      const capturedRange = range;
      const capturedCommand = command;

      const result = await ctx.ui.custom<string[] | null>(
        (tui, theme, _kb, done) => {
          const borderedLoader = new piMod.BorderedLoader(
            tui,
            theme,
            "Scanning sessions...",
          );
          borderedLoader.onAbort = () => done(null);

          const run = async () => {
            // Yield to let the loader render before the async scan
            await new Promise((resolve) => setTimeout(resolve, 0));

            const scanResult = await scanSessionFiles(
              sessionsRoot,
              (scanned, total) => {
                borderedLoader.message = `Scanning sessions: ${scanned}/${total}...`;
                tui.requestRender();
              },
              loader,
              capturedRange,
            );

            const report = aggregateUsage(
              scanResult.records,
              capturedRange,
              scanResult.filesScanned,
              capturedCommand.breakdown,
            );
            report.warningCount = scanResult.warningCount;

            return formatReport(report);
          };

          run()
            .then(done)
            .catch((err) => {
              const msg =
                err instanceof Error ? err.message : String(err);
              console.error("session-stats error:", msg);
              done(null);
            });

          return borderedLoader;
        },
        { overlay: true },
      );

      if (result === null) return;

      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
          return createBorderedTextOverlay(
            tuiMod,
            theme,
            `Session Stats — ${capturedRange.label}`,
            result.join("\n"),
            done,
          );
        },
        { overlay: true },
      );
    },
  });
}
