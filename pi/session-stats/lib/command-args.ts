import type { SessionStatsCommand, BreakdownKind } from "./types.ts";

const VALID_BREAKDOWNS = new Set<BreakdownKind>(["day", "project", "model"]);

export function parseCommandArgs(raw: string): SessionStatsCommand {
  const trimmed = raw.trim();

  if (trimmed === "--help" || trimmed === "help") {
    return { help: true, rangeExpression: "", breakdown: undefined };
  }

  let remaining = trimmed;
  let breakdown: BreakdownKind | undefined;

  const byMatch = remaining.match(/\s+by\s+(\S+)\s*$/i);
  if (byMatch) {
    const kind = byMatch[1].toLowerCase();
    if (!VALID_BREAKDOWNS.has(kind as BreakdownKind)) {
      throw new Error(
        `Unknown breakdown: '${kind}'. Valid options: day, project, model`,
      );
    }
    breakdown = kind as BreakdownKind;
    remaining = remaining.slice(0, byMatch.index!).trim();
  }

  const rangeExpression = remaining || "last 7 days";

  return { help: false, rangeExpression, breakdown };
}
