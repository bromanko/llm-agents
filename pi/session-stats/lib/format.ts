import type { SessionStatsReport } from "./types.ts";

const numFmt = new Intl.NumberFormat("en-US");

function fmtTokens(n: number): string {
  return numFmt.format(n);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function formatReport(report: SessionStatsReport): string[] {
  const lines: string[] = [];

  lines.push(`Session stats - ${report.range.label} (local time)`);
  lines.push(`Sessions scanned: ${report.sessionsScanned}`);
  lines.push(`Sessions matched: ${report.sessionsMatched}`);
  lines.push(`Assistant messages counted: ${report.messagesCounted}`);

  if (report.duplicatesCollapsed > 0) {
    lines.push(
      `Duplicate copied messages collapsed: ${report.duplicatesCollapsed}`,
    );
  }

  if (report.warningCount > 0) {
    lines.push(
      `Warnings: ${report.warningCount} file(s) could not be read`,
    );
  }

  lines.push("");
  lines.push("Tokens");

  const tokenRows: [string, string][] = [
    ["input:", fmtTokens(report.totals.input)],
    ["output:", fmtTokens(report.totals.output)],
    ["cache read:", fmtTokens(report.totals.cacheRead)],
    ["cache write:", fmtTokens(report.totals.cacheWrite)],
    ["total:", fmtTokens(report.totals.total)],
  ];

  const maxLabelLen = Math.max(...tokenRows.map(([l]) => l.length));
  const maxValueLen = Math.max(...tokenRows.map(([, v]) => v.length));

  for (const [label, value] of tokenRows) {
    lines.push(
      `  ${label.padEnd(maxLabelLen)}  ${value.padStart(maxValueLen)}`,
    );
  }

  lines.push("");
  lines.push("Cost");
  lines.push(`  total: ${fmtCost(report.totals.costTotal)}`);

  if (report.breakdown) {
    lines.push("");
    lines.push(`Breakdown: ${report.breakdown.kind}`);

    const rows = report.breakdown.rows;
    if (rows.length > 0) {
      const maxLbl = Math.max(...rows.map((r) => r.label.length));
      const maxTok = Math.max(
        ...rows.map((r) => fmtTokens(r.tokensTotal).length),
      );

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        lines.push(
          `  ${String(i + 1).padStart(2)}. ${r.label.padEnd(maxLbl)}  ${fmtTokens(r.tokensTotal).padStart(maxTok)}  ${fmtCost(r.costTotal)}`,
        );
      }

      if (report.breakdown.omittedCount > 0) {
        lines.push(
          `  ... ${report.breakdown.omittedCount} additional rows omitted`,
        );
      }
    }
  } else if (report.defaultTopProjects.length > 0) {
    lines.push("");
    lines.push("Top projects");

    const rows = report.defaultTopProjects;
    const maxLbl = Math.max(...rows.map((r) => r.label.length));
    const maxTok = Math.max(
      ...rows.map((r) => fmtTokens(r.tokensTotal).length),
    );

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${r.label.padEnd(maxLbl)}  ${fmtTokens(r.tokensTotal).padStart(maxTok)}  ${fmtCost(r.costTotal)}`,
      );
    }
  }

  return lines;
}
