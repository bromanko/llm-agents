import type { UsageRecord, ResolvedDateRange } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isUsageLike(
  value: unknown,
): value is {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { total: number };
} {
  if (!isRecord(value)) return false;
  if (!isNumber(value.input)) return false;
  if (!isNumber(value.output)) return false;
  if (!isNumber(value.cacheRead)) return false;
  if (!isNumber(value.cacheWrite)) return false;
  if (!isNumber(value.totalTokens)) return false;
  if (!isRecord(value.cost)) return false;
  return isNumber(value.cost.total);
}

function formatDayKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function computeFingerprint(
  timestamp: number,
  provider: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  costTotal: number,
): string {
  return `${timestamp}|${provider}|${model}|${input}|${output}|${cacheRead}|${cacheWrite}|${costTotal}`;
}

export function extractUsageRecords(
  entries: unknown[],
  sessionFile: string,
  projectPath: string,
  range?: ResolvedDateRange,
): UsageRecord[] {
  const records: UsageRecord[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type !== "message") continue;

    const message = entry.message;
    if (!isRecord(message)) continue;
    if (message.role !== "assistant") continue;

    const usage = message.usage;
    if (!isUsageLike(usage)) continue;

    const timestamp = message.timestamp;
    if (!isNumber(timestamp)) continue;

    if (range && (timestamp < range.startMs || timestamp >= range.endMsExclusive)) continue;

    const provider = isString(message.provider) ? message.provider : "";
    const model = isString(message.model) ? message.model : "";

    const fingerprint = computeFingerprint(
      timestamp,
      provider,
      model,
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.cost.total,
    );

    records.push({
      fingerprint,
      sessionFile,
      projectPath,
      provider,
      model,
      timestampMs: timestamp,
      dayKey: formatDayKey(timestamp),
      tokens: {
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        total: usage.totalTokens,
      },
      costTotal: usage.cost.total,
    });
  }

  return records;
}
