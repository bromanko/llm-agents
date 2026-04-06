export type BreakdownKind = "day" | "project" | "model";

export interface SessionStatsCommand {
  help: boolean;
  rangeExpression: string;
  breakdown?: BreakdownKind;
}

export interface ResolvedDateRange {
  label: string;
  startMs: number;
  endMsExclusive: number;
}

export interface UsageRecord {
  fingerprint: string;
  sessionFile: string;
  projectPath: string;
  provider: string;
  model: string;
  timestampMs: number;
  dayKey: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  costTotal: number;
}

export interface GroupedStatRow {
  label: string;
  tokensTotal: number;
  costTotal: number;
  messageCount: number;
}

export interface SessionStatsReport {
  range: ResolvedDateRange;
  sessionsScanned: number;
  sessionsMatched: number;
  messagesCounted: number;
  duplicatesCollapsed: number;
  warningCount: number;
  totals: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
    costTotal: number;
  };
  defaultTopProjects: GroupedStatRow[];
  breakdown?: {
    kind: BreakdownKind;
    rows: GroupedStatRow[];
    omittedCount: number;
  };
}
