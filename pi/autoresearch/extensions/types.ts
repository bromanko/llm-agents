/**
 * Shared types for the autoresearch extension.
 * No pi runtime dependencies — safe to import from tests.
 */

export type Direction = "higher" | "lower";

export const ITERATION_STATUSES = [
  "baseline",
  "keep",
  "keep (reworked)",
  "discard",
  "crash",
  "no-op",
  "hook-blocked",
] as const;

export type IterationStatus = typeof ITERATION_STATUSES[number];

export interface AutoresearchConfig {
  goal: string;
  scope: string[];
  metric: string;
  direction: Direction;
  verify: string;
  guard?: string;
  maxIterations?: number; // undefined = unbounded
}

export interface IterationResult {
  iteration: number;
  commit: string;
  metric: number;
  delta: number;
  status: IterationStatus;
  description: string;
}

export interface ResultCounts {
  keeps: number;
  discards: number;
  crashes: number;
  skipped: number;
}

export interface AutoresearchState {
  config: AutoresearchConfig;
  running: boolean;
  currentIteration: number;
  baseline: number;
  bestMetric: number;
  results: IterationResult[];
  counts?: ResultCounts;
  bestResult?: IterationResult;
}
