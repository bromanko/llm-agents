/**
 * Pure utility functions for the autoresearch extension.
 * No pi runtime dependencies — safe to import from tests.
 */

import type { AutoresearchConfig, Direction, IterationResult } from "./types.ts";

export function isBetter(current: number, baseline: number, direction: Direction): boolean {
  return direction === "higher" ? current > baseline : current < baseline;
}

export function formatMetric(value: number): string {
  return value === 0 ? "0" : value.toFixed(6);
}

export function formatDelta(delta: number, direction: Direction): string {
  const sign = delta > 0 ? "+" : "";
  const formatted = `${sign}${delta.toFixed(6)}`;
  const good = direction === "higher" ? delta > 0 : delta < 0;
  return good ? `${formatted} ✓` : formatted;
}

export function formatLoggedMetric(result: IterationResult, direction: Direction): string {
  if (result.status === "crash") return "crash";
  return `${formatMetric(result.metric)} (${formatDelta(result.delta, direction)})`;
}

/**
 * Parse inline configuration text into an AutoresearchConfig.
 *
 * Expected format (one key:value per line):
 *   Goal: Increase test coverage
 *   Scope: src/**\/*.ts
 *   Metric: coverage %
 *   Direction: higher
 *   Verify: npm test --coverage
 *   Guard: npm test
 *   Iterations: 25
 *
 * Returns null if required fields (Goal, Verify) are missing.
 */
export function parseInlineConfig(text: string): AutoresearchConfig | null {
  const lines = text.split("\n").map((l) => l.trim());
  const get = (key: string): string | undefined => {
    const line = lines.find((l) => l.toLowerCase().startsWith(`${key.toLowerCase()}:`));
    return line?.slice(key.length + 1).trim();
  };

  const goal = get("goal");
  const scopeStr = get("scope");
  const metric = get("metric");
  const verify = get("verify");

  if (!goal || !verify) return null;

  const directionStr = get("direction");
  const direction: Direction =
    directionStr?.toLowerCase().includes("lower") ? "lower" : "higher";

  const scope = scopeStr
    ? scopeStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
    : ["src/**/*"];

  const guard = get("guard");
  const iterStr = get("iterations");
  const maxIterations = iterStr ? parseInt(iterStr, 10) : undefined;

  return {
    goal,
    scope,
    metric: metric ?? "metric",
    direction,
    verify,
    guard: guard || undefined,
    maxIterations: maxIterations && !isNaN(maxIterations) && maxIterations > 0 ? maxIterations : undefined,
  };
}
