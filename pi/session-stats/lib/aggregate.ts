import type {
  UsageRecord,
  ResolvedDateRange,
  BreakdownKind,
  SessionStatsReport,
  GroupedStatRow,
} from "./types.ts";

function groupBy(
  records: UsageRecord[],
  keyFn: (r: UsageRecord) => string,
): Map<string, UsageRecord[]> {
  const groups = new Map<string, UsageRecord[]>();
  for (const r of records) {
    const key = keyFn(r);
    const arr = groups.get(key);
    if (arr) arr.push(r);
    else groups.set(key, [r]);
  }
  return groups;
}

function buildRows(groups: Map<string, UsageRecord[]>): GroupedStatRow[] {
  const rows: GroupedStatRow[] = [];
  for (const [label, recs] of groups) {
    let tokensTotal = 0;
    let costTotal = 0;
    for (const r of recs) {
      tokensTotal += r.tokens.total;
      costTotal += r.costTotal;
    }
    rows.push({ label, tokensTotal, costTotal, messageCount: recs.length });
  }
  rows.sort(
    (a, b) => b.tokensTotal - a.tokensTotal || a.label.localeCompare(b.label),
  );
  return rows;
}

export function aggregateUsage(
  records: UsageRecord[],
  range: ResolvedDateRange,
  sessionsScanned: number,
  breakdown?: BreakdownKind,
): SessionStatsReport {
  // Filter by date range
  const inRange = records.filter(
    (r) =>
      r.timestampMs >= range.startMs && r.timestampMs < range.endMsExclusive,
  );

  // Deduplicate by fingerprint
  const seen = new Set<string>();
  const unique: UsageRecord[] = [];
  let duplicatesCollapsed = 0;

  for (const r of inRange) {
    if (seen.has(r.fingerprint)) {
      duplicatesCollapsed++;
      continue;
    }
    seen.add(r.fingerprint);
    unique.push(r);
  }

  // Count distinct session files among matched unique records
  const matchedSessions = new Set(unique.map((r) => r.sessionFile));

  // Sum totals
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalTotal = 0;
  let totalCost = 0;

  for (const r of unique) {
    totalInput += r.tokens.input;
    totalOutput += r.tokens.output;
    totalCacheRead += r.tokens.cacheRead;
    totalCacheWrite += r.tokens.cacheWrite;
    totalTotal += r.tokens.total;
    totalCost += r.costTotal;
  }

  // Build breakdown or default top projects
  let breakdownResult: SessionStatsReport["breakdown"];
  let defaultTopProjects: GroupedStatRow[] = [];

  if (breakdown) {
    const keyFn =
      breakdown === "day"
        ? (r: UsageRecord) => r.dayKey
        : breakdown === "project"
          ? (r: UsageRecord) => r.projectPath
          : (r: UsageRecord) => `${r.provider}/${r.model}`;

    const groups = groupBy(unique, keyFn);
    const allRows = buildRows(groups);
    const topRows = allRows.slice(0, 10);
    const omittedCount = Math.max(0, allRows.length - 10);

    breakdownResult = { kind: breakdown, rows: topRows, omittedCount };
  } else {
    const groups = groupBy(unique, (r) => r.projectPath);
    const allRows = buildRows(groups);
    defaultTopProjects = allRows.slice(0, 3);
  }

  return {
    range,
    sessionsScanned,
    sessionsMatched: matchedSessions.size,
    messagesCounted: unique.length,
    duplicatesCollapsed,
    warningCount: 0,
    totals: {
      input: totalInput,
      output: totalOutput,
      cacheRead: totalCacheRead,
      cacheWrite: totalCacheWrite,
      total: totalTotal,
      costTotal: totalCost,
    },
    defaultTopProjects,
    breakdown: breakdownResult,
  };
}
