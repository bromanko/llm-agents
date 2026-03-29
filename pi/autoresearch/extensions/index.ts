/**
 * Autoresearch Extension — Autonomous goal-directed iteration for pi.
 *
 * Inspired by Karpathy's autoresearch and the generalized Claude Autoresearch skill.
 * Applies constraint-driven autonomous iteration to any measurable task:
 * Modify → Verify → Keep/Discard → Repeat.
 *
 * Commands:
 *   /autoresearch [config]   — Start the autonomous loop
 *   /autoresearch:plan       — Interactive setup wizard
 *   /autoresearch:status     — Show current progress
 *   /autoresearch:stop       — Stop the loop
 *
 * Custom tools:
 *   autoresearch_log         — LLM logs an iteration result
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildProtocol } from "./protocol.ts";
import {
  formatDelta,
  formatLoggedMetric,
  formatMetric,
  isBetter,
  parseInlineConfig,
} from "./utils.ts";
import {
  ITERATION_STATUSES,
} from "./types.ts";
import type {
  AutoresearchConfig,
  AutoresearchState,
  Direction,
  IterationResult,
  IterationStatus,
  ResultCounts,
} from "./types.ts";

export { formatDelta, formatMetric, parseInlineConfig } from "./utils.ts";
export { ITERATION_STATUSES } from "./types.ts";
export type {
  AutoresearchConfig,
  AutoresearchState,
  Direction,
  IterationResult,
  IterationStatus,
  ResultCounts,
} from "./types.ts";

const KEPT_STATUSES = new Set<IterationStatus>(["keep", "keep (reworked)"]);
const SKIPPED_STATUSES = new Set<IterationStatus>(["no-op", "hook-blocked"]);
const EMPTY_COUNTS: ResultCounts = { keeps: 0, discards: 0, crashes: 0, skipped: 0 };
const MAX_PERSISTED_RESULTS = 64;

type JsonSchema =
  | { type: "string"; enum?: readonly string[]; description?: string }
  | { type: "number"; minimum?: number; exclusiveMinimum?: number; description?: string }
  | { type: "boolean"; description?: string }
  | { type: "array"; items: JsonSchema; description?: string }
  | {
    type: "object";
    properties: Record<string, JsonSchema>;
    required?: readonly string[];
    additionalProperties?: boolean;
    description?: string;
  };

interface AutoresearchLogParams {
  iteration: number;
  commit: string;
  metric: number;
  status: IterationStatus;
  description: string;
}

const autoresearchLogParameters: JsonSchema = {
  type: "object",
  properties: {
    iteration: { type: "number", minimum: 0, description: "Iteration number (0 for baseline)" },
    commit: { type: "string", description: "Git commit hash (short, 7 chars). Use '-' if no commit." },
    metric: { type: "number", description: "Metric value from the verify command output. Use 0 for crashes." },
    status: { type: "string", enum: ITERATION_STATUSES },
    description: { type: "string", description: "Short description of what was tried" },
  },
  required: ["iteration", "commit", "metric", "status", "description"],
  additionalProperties: false,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidDirection(value: unknown): value is Direction {
  return value === "higher" || value === "lower";
}

function isValidIterationStatus(value: unknown): value is IterationStatus {
  return typeof value === "string" && ITERATION_STATUSES.includes(value as IterationStatus);
}

function isValidAutoresearchConfig(value: unknown): value is AutoresearchConfig {
  if (!isPlainObject(value)) return false;
  if (typeof value.goal !== "string") return false;
  if (!Array.isArray(value.scope) || !value.scope.every((entry) => typeof entry === "string")) return false;
  if (typeof value.metric !== "string") return false;
  if (!isValidDirection(value.direction)) return false;
  if (typeof value.verify !== "string") return false;
  if (value.guard !== undefined && typeof value.guard !== "string") return false;
  if (value.maxIterations !== undefined && (!isFiniteNumber(value.maxIterations) || value.maxIterations <= 0)) return false;
  return true;
}

function isValidIterationResult(value: unknown): value is IterationResult {
  if (!isPlainObject(value)) return false;
  if (!isFiniteNumber(value.iteration) || value.iteration < 0) return false;
  if (typeof value.commit !== "string") return false;
  if (!isFiniteNumber(value.metric)) return false;
  if (!isFiniteNumber(value.delta)) return false;
  if (!isValidIterationStatus(value.status)) return false;
  if (typeof value.description !== "string") return false;
  return true;
}

function isValidResultCounts(value: unknown): value is ResultCounts {
  if (!isPlainObject(value)) return false;
  return (
    isFiniteNumber(value.keeps) && value.keeps >= 0 &&
    isFiniteNumber(value.discards) && value.discards >= 0 &&
    isFiniteNumber(value.crashes) && value.crashes >= 0 &&
    isFiniteNumber(value.skipped) && value.skipped >= 0
  );
}

function isValidAutoresearchState(value: unknown): value is AutoresearchState {
  if (!isPlainObject(value)) return false;
  if (!isValidAutoresearchConfig(value.config)) return false;
  if (typeof value.running !== "boolean") return false;
  if (!isFiniteNumber(value.currentIteration) || value.currentIteration < 0) return false;
  if (!isFiniteNumber(value.baseline)) return false;
  if (!isFiniteNumber(value.bestMetric)) return false;
  if (!Array.isArray(value.results) || !value.results.every(isValidIterationResult)) return false;
  if (value.counts !== undefined && !isValidResultCounts(value.counts)) return false;
  if (value.bestResult !== undefined && !isValidIterationResult(value.bestResult)) return false;
  return true;
}

function isValidAutoresearchLogParams(value: unknown): value is AutoresearchLogParams {
  if (!isPlainObject(value)) return false;
  if (!isFiniteNumber(value.iteration) || value.iteration < 0) return false;
  if (typeof value.commit !== "string" || value.commit.trim().length === 0) return false;
  if (!isFiniteNumber(value.metric)) return false;
  if (!isValidIterationStatus(value.status)) return false;
  if (typeof value.description !== "string" || value.description.trim().length === 0) return false;
  return true;
}

function emptyCounts(): ResultCounts {
  return { ...EMPTY_COUNTS };
}

function countResult(counts: ResultCounts, result: IterationResult): ResultCounts {
  const next = { ...counts };
  if (isKeepStatus(result.status)) {
    next.keeps += 1;
  } else if (result.status === "discard") {
    next.discards += 1;
  } else if (result.status === "crash") {
    next.crashes += 1;
  } else if (isSkippedStatus(result.status)) {
    next.skipped += 1;
  }
  return next;
}

function getResultCounts(state: AutoresearchState): ResultCounts {
  return state.counts ?? summarizeResults(state.results);
}

function getBestKeptResult(state: AutoresearchState): IterationResult | undefined {
  return state.bestResult ?? findBestKeptResult(state.results, state.config.direction);
}

function createPersistedState(current: AutoresearchState): AutoresearchState {
  return {
    ...current,
    results: current.results.slice(-MAX_PERSISTED_RESULTS),
    counts: getResultCounts(current),
    bestResult: getBestKeptResult(current),
  };
}

function hydrateState(restored: AutoresearchState): AutoresearchState {
  return {
    ...restored,
    counts: restored.counts ?? summarizeResults(restored.results),
    bestResult: restored.bestResult ?? findBestKeptResult(restored.results, restored.config.direction),
  };
}

function toolError(message: string) {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    details: {},
  };
}

function validateLoggedIteration(state: AutoresearchState, params: AutoresearchLogParams): string | null {
  if (state.results.length === 0) {
    if (params.status !== "baseline") {
      return "Baseline must be established before logging iterations.";
    }
    if (params.iteration !== 0) {
      return 'Status "baseline" is only valid for iteration 0.';
    }
  } else {
    if (params.status === "baseline") {
      return 'Status "baseline" can only be logged once.';
    }

    const expectedIteration = state.currentIteration + 1;
    if (params.iteration !== expectedIteration) {
      return `Expected iteration ${expectedIteration}, received ${params.iteration}.`;
    }
  }

  if (state.config.maxIterations !== undefined && params.iteration > state.config.maxIterations) {
    return `Iteration ${params.iteration} exceeds configured maxIterations ${state.config.maxIterations}.`;
  }

  if (params.status === "crash" && params.metric !== 0) {
    return 'Status "crash" requires metric 0.';
  }

  return null;
}

export function isKeepStatus(status: IterationStatus): boolean {
  return KEPT_STATUSES.has(status);
}

export function isSkippedStatus(status: IterationStatus): boolean {
  return SKIPPED_STATUSES.has(status);
}

export function getStatusIcon(status: IterationStatus): string {
  if (status === "baseline") return "📊";
  if (isKeepStatus(status)) return "✅";
  if (status === "crash") return "💥";
  return "❌";
}

export function formatResultMetric(result: IterationResult): string {
  return result.status === "crash" ? "crash" : formatMetric(result.metric);
}

export function summarizeResults(results: IterationResult[]): ResultCounts {
  return results.reduce<ResultCounts>((counts, result) => countResult(counts, result), emptyCounts());
}

export function findBestKeptResult(
  results: IterationResult[],
  direction: Direction,
): IterationResult | undefined {
  let best: IterationResult | undefined;

  for (const result of results) {
    if (!isKeepStatus(result.status)) continue;
    if (!best || isBetter(result.metric, best.metric, direction)) {
      best = result;
    }
  }

  return best;
}

function parsePositiveIteration(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function autoresearchExtension(pi: ExtensionAPI): void {
  let state: AutoresearchState | null = null;
  let resultLoggedThisCycle = false;

  // ─── State helpers ─────────────────────────────────────────────────────

  function persistState(): void {
    if (state) {
      pi.appendEntry("autoresearch-state", createPersistedState(state));
    }
  }

  function restoreState(ctx: ExtensionContext): void {
    state = null;

    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry?.type !== "custom" || entry.customType !== "autoresearch-state") continue;
      if (!entry.data || !isValidAutoresearchState(entry.data)) continue;
      state = hydrateState(entry.data);
      break;
    }
  }

  // ─── UI helpers ────────────────────────────────────────────────────────

  function updateUI(ctx: ExtensionContext): void {
    if (!state) {
      ctx.ui.setStatus("autoresearch", undefined);
      ctx.ui.setWidget("autoresearch", undefined);
      return;
    }

    const th = ctx.ui.theme;
    if (state.running) {
      const counts = getResultCounts(state);
      const iterLabel = state.config.maxIterations !== undefined
        ? `${state.currentIteration}/${state.config.maxIterations}`
        : `${state.currentIteration}`;

      ctx.ui.setStatus(
        "autoresearch",
        th.fg("accent", `🔬 iter ${iterLabel}`) +
        th.fg("muted", ` | best ${formatMetric(state.bestMetric)}`) +
        th.fg("success", ` | ${counts.keeps}✓`) +
        th.fg("error", ` ${counts.discards}✗`) +
        (counts.crashes > 0 ? th.fg("warning", ` ${counts.crashes}💥`) : ""),
      );

      const recent = state.results.slice(-8);
      if (recent.length > 0) {
        const lines = [th.fg("accent", th.bold("  Autoresearch Progress"))];
        lines.push(th.fg("muted", `  Goal: ${state.config.goal}`));
        lines.push(
          th.fg("muted", `  Baseline: ${formatMetric(state.baseline)} → Best: ${formatMetric(state.bestMetric)}`),
        );
        lines.push("");
        for (const result of recent) {
          const desc =
            result.description.length > 50 ? `${result.description.slice(0, 47)}...` : result.description;
          lines.push(
            `  ${getStatusIcon(result.status)} ${th.fg("muted", `#${result.iteration}`)} ${th.fg("dim", formatResultMetric(result))} ${th.fg("dim", desc)}`,
          );
        }
        ctx.ui.setWidget("autoresearch", lines);
      } else {
        ctx.ui.setWidget("autoresearch", undefined);
      }
    } else {
      ctx.ui.setStatus("autoresearch", th.fg("dim", "🔬 stopped"));
      ctx.ui.setWidget("autoresearch", undefined);
    }
  }

  function printSummary(): void {
    if (!state) return;

    const counts = getResultCounts(state);
    const baselineDelta = state.bestMetric - state.baseline;
    const direction = state.config.direction;
    const summary = [
      `=== Autoresearch Complete (${state.currentIteration} iterations) ===`,
      `Goal: ${state.config.goal}`,
      `Baseline: ${formatMetric(state.baseline)} → Best: ${formatMetric(state.bestMetric)} (${formatDelta(baselineDelta, direction)})`,
      `Keeps: ${counts.keeps} | Discards: ${counts.discards} | Crashes: ${counts.crashes}${counts.skipped > 0 ? ` | Skipped: ${counts.skipped}` : ""}`,
    ].join("\n");

    const bestResult = getBestKeptResult(state);

    if (bestResult) {
      pi.sendMessage(
        {
          customType: "autoresearch-summary",
          content: `${summary}\nBest iteration: #${bestResult.iteration} — ${bestResult.description}`,
          display: true,
        },
        { triggerTurn: false },
      );
    } else {
      pi.sendMessage(
        {
          customType: "autoresearch-summary",
          content: `${summary}\nNo improvements found.`,
          display: true,
        },
        { triggerTurn: false },
      );
    }
  }

  // ─── Interactive setup wizard ──────────────────────────────────────────

  async function runSetupWizard(ctx: ExtensionContext): Promise<AutoresearchConfig | null> {
    if (!ctx.hasUI) {
      ctx.ui.notify("Setup wizard requires interactive mode", "error");
      return null;
    }

    let detectedFiles: string[] = [];
    try {
      const { stdout: filesOutput } = await pi.exec("find", [
        ".",
        "-maxdepth",
        "3",
        "-name",
        "package.json",
        "-o",
        "-name",
        "Makefile",
        "-o",
        "-name",
        "Cargo.toml",
        "-o",
        "-name",
        "pyproject.toml",
        "-o",
        "-name",
        "go.mod",
      ]);
      detectedFiles = filesOutput
        .trim()
        .split("\n")
        .filter((file: string) => file.length > 0);
    } catch {
      detectedFiles = [];
    }

    const hasNode = detectedFiles.some((file) => file.includes("package.json"));
    const hasPython = detectedFiles.some((file) => file.includes("pyproject.toml"));
    const hasRust = detectedFiles.some((file) => file.includes("Cargo.toml"));
    const hasGo = detectedFiles.some((file) => file.includes("go.mod"));

    const goal = await ctx.ui.input("What do you want to improve?", "e.g., Increase test coverage to 90%");
    if (!goal?.trim()) return null;

    let defaultScope = "src/**/*";
    if (hasRust) defaultScope = "src/**/*.rs";
    else if (hasGo) defaultScope = "**/*.go";
    else if (hasPython) defaultScope = "**/*.py";
    else if (hasNode) defaultScope = "src/**/*.ts";

    const scopeInput = await ctx.ui.input("Which files can be modified? (glob pattern)", defaultScope);
    if (!scopeInput?.trim()) return null;
    const scope = scopeInput
      .split(",")
      .map((segment: string) => segment.trim())
      .filter((segment: string) => segment.length > 0);

    const metricOptions = [
      "Test coverage % (higher is better)",
      "Bundle size KB (lower is better)",
      "Error count (lower is better)",
      "Benchmark time ms (lower is better)",
      "Test pass count (higher is better)",
      "Custom metric...",
    ];
    const metricChoice = await ctx.ui.select("What number tells you if it got better?", metricOptions);
    if (!metricChoice) return null;

    let metric: string;
    let direction: "higher" | "lower";

    if (metricChoice.includes("Custom")) {
      const customMetric = await ctx.ui.input("Describe the metric:", "e.g., Lighthouse performance score");
      if (!customMetric?.trim()) return null;
      metric = customMetric;

      const dirChoice = await ctx.ui.select("Direction?", ["Higher is better", "Lower is better"]);
      if (!dirChoice) return null;
      direction = dirChoice.startsWith("Higher") ? "higher" : "lower";
    } else {
      metric = metricChoice.split("(")[0].trim();
      direction = metricChoice.includes("higher") ? "higher" : "lower";
    }

    let defaultVerify = "";
    if (hasNode) defaultVerify = "npm test -- --coverage 2>&1 | grep 'All files' | awk '{print $4}'";
    else if (hasPython) {
      defaultVerify = "pytest --cov=src --cov-report=term 2>&1 | grep TOTAL | awk '{print $4}'";
    } else if (hasRust) {
      defaultVerify = "cargo test 2>&1 | grep -oP '\\d+ passed' | grep -oP '\\d+'";
    } else if (hasGo) {
      defaultVerify = "go test -count=1 ./... 2>&1 | grep -c '^ok'";
    }

    const verify = await ctx.ui.input(
      "Command that outputs the metric number:",
      defaultVerify || "e.g., npm test -- --coverage | grep 'All files' | awk '{print $4}'",
    );
    if (!verify?.trim()) return null;

    const guardOptions: string[] = [];
    if (hasNode) guardOptions.push("npm test", "npx tsc --noEmit", "npm run build");
    if (hasPython) guardOptions.push("pytest", "mypy src/");
    if (hasRust) guardOptions.push("cargo test", "cargo clippy");
    if (hasGo) guardOptions.push("go test ./...", "go vet ./...");
    guardOptions.push("Custom command...", "Skip — no guard");

    const guardChoice = await ctx.ui.select("Safety command that must always pass? (prevents regressions)", guardOptions);
    if (!guardChoice) return null;

    let guard: string | undefined;
    if (guardChoice.startsWith("Skip")) {
      guard = undefined;
    } else if (guardChoice.startsWith("Custom")) {
      const customGuard = await ctx.ui.input("Guard command:", "e.g., npm test");
      if (customGuard === undefined) return null;
      guard = customGuard.trim() || undefined;
    } else {
      guard = guardChoice;
    }

    const iterChoice = await ctx.ui.select("How many iterations?", [
      "Unlimited (run until interrupted)",
      "5 iterations",
      "10 iterations",
      "25 iterations",
      "50 iterations",
      "Custom...",
    ]);
    if (!iterChoice) return null;

    let maxIterations: number | undefined;
    if (iterChoice.startsWith("Unlimited")) {
      maxIterations = undefined;
    } else if (iterChoice.startsWith("Custom")) {
      const custom = await ctx.ui.input("Number of iterations:", "25");
      if (custom === undefined) return null;
      maxIterations = parsePositiveIteration(custom) ?? 25;
    } else {
      maxIterations = parsePositiveIteration(iterChoice);
    }

    const configSummary = [
      `Goal: ${goal}`,
      `Scope: ${scope.join(", ")}`,
      `Metric: ${metric} (${direction} is better)`,
      `Verify: ${verify}`,
      guard ? `Guard: ${guard}` : "Guard: none",
      maxIterations !== undefined ? `Iterations: ${maxIterations}` : "Iterations: unlimited",
    ].join("\n");

    const confirmed = await ctx.ui.confirm("Launch autoresearch?", configSummary);
    if (!confirmed) return null;

    return { goal, scope, metric, direction, verify, guard, maxIterations };
  }

  // ─── Loop management ───────────────────────────────────────────────────

  function startLoop(config: AutoresearchConfig, ctx: ExtensionContext): void {
    state = {
      config,
      running: true,
      currentIteration: 0,
      baseline: 0,
      bestMetric: 0,
      results: [],
      counts: emptyCounts(),
      bestResult: undefined,
    };
    persistState();
    updateUI(ctx);

    const protocol = buildProtocol(config);
    pi.sendUserMessage(protocol, { deliverAs: "followUp" });
  }

  function stopLoop(ctx: ExtensionContext): void {
    if (!state) return;
    state.running = false;
    printSummary();
    persistState();
    updateUI(ctx);
  }

  function continueLoop(ctx: ExtensionContext): void {
    if (!state || !state.running) return;

    if (state.config.maxIterations !== undefined && state.currentIteration >= state.config.maxIterations) {
      stopLoop(ctx);
      return;
    }

    const lastResult = state.results[state.results.length - 1];
    const lastStatus = lastResult ? `Last: ${lastResult.status} (${lastResult.description})` : "";
    const iterLabel = state.config.maxIterations !== undefined
      ? `${state.currentIteration + 1}/${state.config.maxIterations}`
      : `${state.currentIteration + 1}`;

    const prompt = [
      `Continue the autoresearch loop. Iteration ${iterLabel}.`,
      `Current best: ${formatMetric(state.bestMetric)} (baseline: ${formatMetric(state.baseline)}).`,
      lastStatus,
      "",
      "Follow the protocol: Review → Ideate → Modify → Commit → Verify → Decide → Log with autoresearch_log tool.",
      "Make ONE focused change. Commit before verifying. Log results. Do NOT ask if you should continue.",
    ].join("\n");

    pi.sendUserMessage(prompt, { deliverAs: "followUp" });
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  pi.registerCommand("autoresearch", {
    description: "Start autonomous goal-directed iteration loop",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (state?.running) {
        ctx.ui.notify("Autoresearch is already running. Use /autoresearch:stop to stop it.", "warning");
        return;
      }

      let inGitRepo = false;
      try {
        const gitCheck = await pi.exec("git", ["rev-parse", "--git-dir"]);
        inGitRepo = gitCheck.code === 0;
      } catch {
        inGitRepo = false;
      }

      if (!inGitRepo) {
        ctx.ui.notify("Not a git repository. Run 'git init' first.", "error");
        return;
      }

      const { stdout: dirty } = await pi.exec("git", ["status", "--porcelain"]);
      if (dirty.trim()) {
        const proceed = await ctx.ui.confirm(
          "Dirty working tree",
          "There are uncommitted changes. Autoresearch works best with a clean tree. Continue anyway?",
        );
        if (!proceed) return;
      }

      if (args?.trim()) {
        const config = parseInlineConfig(args);
        if (config) {
          startLoop(config, ctx);
          return;
        }
      }

      const config = await runSetupWizard(ctx);
      if (config) {
        startLoop(config, ctx);
      }
    },
  });

  pi.registerCommand("autoresearch:plan", {
    description: "Interactive autoresearch setup wizard (does not start the loop)",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const config = await runSetupWizard(ctx);
      if (config) {
        const configStr = [
          `Goal: ${config.goal}`,
          `Scope: ${config.scope.join(", ")}`,
          `Metric: ${config.metric} (${config.direction} is better)`,
          `Verify: ${config.verify}`,
          config.guard ? `Guard: ${config.guard}` : undefined,
          config.maxIterations !== undefined ? `Iterations: ${config.maxIterations}` : undefined,
        ]
          .filter(Boolean)
          .join("\n");

        const launch = await ctx.ui.confirm("Configuration ready", `${configStr}\n\nLaunch now?`);
        if (launch) {
          startLoop(config, ctx);
        } else {
          ctx.ui.notify("Configuration saved. Use /autoresearch to launch.", "info");
        }
      }
    },
  });

  pi.registerCommand("autoresearch:status", {
    description: "Show autoresearch progress",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!state) {
        ctx.ui.notify("No autoresearch session. Use /autoresearch to start.", "info");
        return;
      }

      const counts = getResultCounts(state);
      const lines = [
        `Status: ${state.running ? "RUNNING" : "STOPPED"}`,
        `Goal: ${state.config.goal}`,
        `Iteration: ${state.currentIteration}${state.config.maxIterations !== undefined ? `/${state.config.maxIterations}` : ""}`,
        `Baseline: ${formatMetric(state.baseline)} → Best: ${formatMetric(state.bestMetric)}`,
        `Keeps: ${counts.keeps} | Discards: ${counts.discards} | Crashes: ${counts.crashes}${counts.skipped > 0 ? ` | Skipped: ${counts.skipped}` : ""}`,
        "",
        "Recent results:",
        ...state.results.slice(-10).map((result) => {
          return `  ${getStatusIcon(result.status)} #${result.iteration} ${formatResultMetric(result)} ${result.status} — ${result.description}`;
        }),
      ];

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("autoresearch:stop", {
    description: "Stop the autoresearch loop",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (!state?.running) {
        ctx.ui.notify("Autoresearch is not running.", "info");
        return;
      }
      stopLoop(ctx);
      ctx.ui.notify("Autoresearch stopped.", "info");
    },
  });

  // ─── Log tool (LLM calls this to record iteration results) ─────────────

  pi.registerTool({
    name: "autoresearch_log",
    label: "Autoresearch Log",
    description:
      "Log an autoresearch iteration result. Call this after each iteration to record whether the change was kept, discarded, or crashed. The extension will automatically continue the loop.",
    promptSnippet: "Log autoresearch iteration results (metric, status, description)",
    promptGuidelines: [
      "Call autoresearch_log after each autoresearch iteration to record the result.",
      "Always provide the metric value from the verify command output.",
      'Use status "baseline" for the first run, "keep" for improvements, "discard" for regressions, "crash" for failures.',
    ],
    parameters: autoresearchLogParameters,

    async execute(
      _toolCallId: string,
      params: unknown,
      _signal: AbortSignal | undefined,
      _onUpdate: (() => void) | undefined,
      ctx: ExtensionContext,
    ) {
      if (!state) {
        return toolError("No autoresearch session active.");
      }

      if (!state.running) {
        return toolError("Autoresearch is not running.");
      }

      if (!isValidAutoresearchLogParams(params)) {
        return toolError("Invalid autoresearch_log parameters.");
      }

      const validationError = validateLoggedIteration(state, params);
      if (validationError) {
        return toolError(validationError);
      }

      const previousCounts = getResultCounts(state);
      const delta = params.iteration === 0 ? 0 : params.metric - state.baseline;
      const result: IterationResult = {
        iteration: params.iteration,
        commit: params.commit,
        metric: params.metric,
        delta,
        status: params.status,
        description: params.description,
      };

      state.results.push(result);
      state.currentIteration = params.iteration;
      state.counts = countResult(previousCounts, result);
      resultLoggedThisCycle = true;

      if (params.status === "baseline") {
        state.baseline = params.metric;
        state.bestMetric = params.metric;
        state.bestResult = undefined;
      }

      if (isKeepStatus(params.status) && isBetter(params.metric, state.bestMetric, state.config.direction)) {
        state.bestMetric = params.metric;
        state.bestResult = result;
      }

      persistState();
      updateUI(ctx);

      const counts = getResultCounts(state);
      const remaining = state.config.maxIterations !== undefined
        ? Math.max(state.config.maxIterations - state.currentIteration, 0)
        : "∞";

      const response = [
        `Iteration #${params.iteration} logged: ${params.status}`,
        `Metric: ${formatLoggedMetric(result, state.config.direction)}`,
        `Best: ${formatMetric(state.bestMetric)} | Keeps: ${counts.keeps} | Discards: ${counts.discards} | Remaining: ${remaining}`,
      ].join("\n");

      return {
        content: [{ type: "text", text: response }],
        details: { result, state: createPersistedState(state) },
      };
    },
  });

  // ─── Protocol injection ────────────────────────────────────────────────

  pi.on("before_agent_start", async (_event: { systemPrompt: string }) => {
    if (!state?.running) return;

    if (state.currentIteration === 0 && state.results.length === 0) {
      return {
        systemPrompt:
          _event.systemPrompt +
          "\n\n" +
          [
            "## Active Autoresearch Session",
            "",
            "An autoresearch loop is active. You are an autonomous researcher.",
            `Goal: ${state.config.goal}`,
            `Scope: ${state.config.scope.join(", ")}`,
            `Metric: ${state.config.metric} (${state.config.direction} is better)`,
            `Verify: ${state.config.verify}`,
            state.config.guard ? `Guard: ${state.config.guard}` : "",
            state.config.maxIterations !== undefined ? `Max iterations: ${state.config.maxIterations}` : "Mode: unlimited",
            "",
            "CRITICAL: Use the autoresearch_log tool to record each iteration result.",
            "CRITICAL: Do NOT ask if you should continue. The loop is autonomous.",
            "CRITICAL: Make ONE focused change per iteration.",
          ].join("\n"),
      };
    }
  });

  // ─── Loop continuation ─────────────────────────────────────────────────

  pi.on("agent_start", async () => {
    resultLoggedThisCycle = false;
  });

  pi.on("agent_end", async (_event: unknown, ctx: ExtensionContext) => {
    if (!state?.running) return;

    if (resultLoggedThisCycle) {
      resultLoggedThisCycle = false;
      continueLoop(ctx);
    }
  });

  // ─── Session lifecycle ─────────────────────────────────────────────────

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    restoreState(ctx);
    if (state) {
      if (state.running) {
        state.running = false;
        persistState();
        ctx.ui.notify(
          "Autoresearch session restored (stopped). Use /autoresearch to resume or /autoresearch:status to review.",
          "info",
        );
      }
      updateUI(ctx);
    } else {
      updateUI(ctx);
    }
  });

  pi.on("session_switch", async (_event: unknown, ctx: ExtensionContext) => {
    restoreState(ctx);
    updateUI(ctx);
  });

  pi.on("session_fork", async (_event: unknown, ctx: ExtensionContext) => {
    restoreState(ctx);
    updateUI(ctx);
  });
}

