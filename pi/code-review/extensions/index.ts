/**
 * Interactive Code Review Extension
 *
 * /review <language> [types...] [-r|--revisions <range>] [--fix <level>] [--report <level>]
 *
 * Examples:
 *   /review gleam                      — all gleam review skills on range @
 *   /review gleam code -r main..@      — only gleam-code-review for range main..@
 *   /review fsharp security --fix high — auto-fix HIGH findings in current range
 *   pi -p "/review gleam --report all" — print the full review report to stdout
 *
 * Flow:
 *   1. Discovers matching review skills
 *   2. Reads code for the requested range (jj first, git fallback)
 *   3. Runs each skill via complete() with a spinner
 *   4. Parses findings from LLM output
 *   5. If --report is set, prints a deterministic markdown report in print mode
 *   6. Else if --fix is set, auto-queues fixes by severity threshold
 *   7. Otherwise presents findings one-at-a-time in an inline TUI
 *   8. User picks: Fix / Fix with instructions / Skip / Stop
 */

import type { UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import * as fs from "node:fs";

import { type Finding, parseFindings } from "../lib/parser.ts";
import {
  formatQueueError,
  type NotificationLevel,
  notifyQueueSummary,
  processFindingActions,
  queueFixFollowUp,
} from "../lib/fix-flow.ts";
import {
  gatherRangeDiff,
  parseReviewArgs,
  REVIEW_USAGE,
  type FixLevel,
} from "../lib/review-range.ts";
import {
  discoverReviewSkills,
  extractFilesFromDiff,
  filterDiffByExtensions,
  filterSkills,
  getLanguageExtensions,
  getLanguages,
  getSkillsDirs,
  getTypesForLanguage,
  type ReviewSkill,
} from "../lib/skills.ts";

/** Content block with type "text" from the LLM response. */
type TextContent = { type: "text"; text: string };

/** Actions the user can take on a finding */
type FindingAction =
  | { type: "fix" }
  | { type: "fix-custom"; instructions: string }
  | { type: "skip" }
  | { type: "stop" };

/** Result from runReviews — includes raw response text for diagnostics */
type ReviewResult =
  | { ok: true; findings: Finding[]; totalResponseLength: number }
  | { ok: false; cancelled: true }
  | { ok: false; cancelled: false; error: string };

/** Context available to review functions from the extension framework. */
export interface ReviewContext {
  hasUI: boolean;
  model?: {
    provider?: string;
    id?: string;
    name?: string;
    [key: string]: unknown;
  } | string;
  cwd?: string;
  modelRegistry?: {
    find?(provider: string, modelId: string): unknown;
    getAll?(): unknown[];
    getApiKey?(model: unknown): Promise<string | null | undefined>;
    getApiKeyAndHeaders?(model: unknown): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
    getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  };
  ui: {
    notify(message: string, level: NotificationLevel): void;
    custom<T>(factory: (...args: any[]) => any): Promise<T>;
  };
}

const SEVERITY_COLORS: Record<string, string> = {
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "muted",
};

const MIN_RESPONSE_FOR_SUSPICION = 200;
const REVIEW_PARSE_WARNING =
  "Review completed but no findings could be parsed — the response may not have used the expected format. Try again or check the diff format.";
const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

function severityRank(s: Finding["severity"]): number {
  return SEVERITY_ORDER[s] ?? 99;
}

type ReviewOutputMode = "interactive" | "print" | "json";

type PiAiRuntime = {
  complete: (
    model: unknown,
    input: { systemPrompt: string; messages: UserMessage[] },
    options: {
      apiKey?: string;
      headers?: Record<string, string>;
      signal?: AbortSignal;
    },
  ) => Promise<{
    content: Array<{ type: string; text?: string }>;
    stopReason?: string;
  }>;
};

type CodingAgentRuntime = {
  BorderedLoader: new (tui: any, theme: any, message: string) => {
    onAbort: (() => void) | null;
    signal: AbortSignal;
  };
};

type TuiRuntime = {
  Key: Record<string, string>;
  matchesKey: (data: string, key: string) => boolean;
  truncateToWidth: (text: string, width: number) => string;
};

let piAiRuntimePromise: Promise<PiAiRuntime> | null = null;
let codingAgentRuntimePromise: Promise<CodingAgentRuntime> | null = null;
let tuiRuntimePromise: Promise<TuiRuntime> | null = null;

async function getPiAiRuntime(): Promise<PiAiRuntime> {
  if (!piAiRuntimePromise) {
    piAiRuntimePromise = import("@mariozechner/pi-ai").then(
      ({ complete }) => ({ complete }),
    );
  }
  return piAiRuntimePromise;
}

async function getCodingAgentRuntime(): Promise<CodingAgentRuntime> {
  if (!codingAgentRuntimePromise) {
    codingAgentRuntimePromise = import("@mariozechner/pi-coding-agent").then(
      ({ BorderedLoader }) => ({ BorderedLoader }),
    );
  }
  return codingAgentRuntimePromise;
}

async function getTuiRuntime(): Promise<TuiRuntime> {
  if (!tuiRuntimePromise) {
    tuiRuntimePromise = import("@mariozechner/pi-tui").then(
      ({ Key, matchesKey, truncateToWidth }) => ({
        Key,
        matchesKey,
        truncateToWidth,
      }),
    );
  }
  return tuiRuntimePromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function resolveReviewModelObject(ctx: ReviewContext): unknown | null {
  if (!ctx.model) return null;

  const sessionModel = ctx.model;
  if (
    isRecord(sessionModel)
    && isNonEmptyString(sessionModel.provider)
    && isNonEmptyString(sessionModel.id)
  ) {
    let registryModel = ctx.modelRegistry?.find?.(sessionModel.provider, sessionModel.id);

    if (!registryModel && ctx.modelRegistry?.getAll) {
      registryModel = ctx.modelRegistry.getAll().find((entry) => {
        if (!isRecord(entry)) return false;
        return entry.provider === sessionModel.provider && entry.id === sessionModel.id;
      });
    }

    return registryModel ?? sessionModel;
  }

  return sessionModel;
}

export async function resolveReviewRequestAuth(
  ctx: ReviewContext,
  model: unknown,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  const registry = ctx.modelRegistry;
  if (!registry || !model) return {};

  try {
    if (typeof registry.getApiKeyAndHeaders === "function") {
      const result = await registry.getApiKeyAndHeaders(model);
      if (result && typeof result === "object" && "ok" in result && result.ok) {
        return {
          apiKey: isNonEmptyString(result.apiKey) ? result.apiKey : undefined,
          headers: result.headers,
        };
      }
    }

    if (typeof registry.getApiKey === "function") {
      const key = await registry.getApiKey(model);
      if (isNonEmptyString(key)) {
        return { apiKey: key };
      }
    }

    const provider =
      isRecord(model) && isNonEmptyString(model.provider)
        ? model.provider
        : isRecord(ctx.model) && isNonEmptyString(ctx.model.provider)
          ? ctx.model.provider
          : undefined;

    if (provider && typeof registry.getApiKeyForProvider === "function") {
      const key = await registry.getApiKeyForProvider(provider);
      if (isNonEmptyString(key)) {
        return { apiKey: key };
      }
    }
  } catch {
    // Swallow auth-resolution failures and proceed without explicit auth.
  }

  return {};
}

type RawStdoutWriter = (text: string) => void;

type OutputGuardModuleLoader = () => Promise<unknown>;

let rawStdoutWriterPromise: Promise<RawStdoutWriter> | null = null;
let reviewStdoutFallbackWarned = false;

const defaultOutputGuardModuleLoader: OutputGuardModuleLoader = async () => {
  const packageEntryUrl = import.meta.resolve("@mariozechner/pi-coding-agent");
  const outputGuardUrl = new URL("./core/output-guard.js", packageEntryUrl).href;
  return import(outputGuardUrl);
};

let outputGuardModuleLoader: OutputGuardModuleLoader = defaultOutputGuardModuleLoader;

function formatReviewStdoutError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resetReviewStdoutStateForTests(): void {
  rawStdoutWriterPromise = null;
  reviewStdoutFallbackWarned = false;
  outputGuardModuleLoader = defaultOutputGuardModuleLoader;
}

export function setOutputGuardModuleLoaderForTests(
  loader: OutputGuardModuleLoader | null,
): void {
  outputGuardModuleLoader = loader ?? defaultOutputGuardModuleLoader;
  rawStdoutWriterPromise = null;
  reviewStdoutFallbackWarned = false;
}

async function getRawStdoutWriter(): Promise<RawStdoutWriter> {
  if (!rawStdoutWriterPromise) {
    rawStdoutWriterPromise = outputGuardModuleLoader()
      .then((module) => {
        if (!isRecord(module) || typeof module.writeRawStdout !== "function") {
          throw new Error("output-guard module missing writeRawStdout export");
        }
        return module.writeRawStdout as RawStdoutWriter;
      })
      .catch((error) => {
        rawStdoutWriterPromise = null;
        throw error;
      });
  }

  return rawStdoutWriterPromise;
}

function warnReviewStdoutFallback(error: unknown): void {
  if (reviewStdoutFallbackWarned) return;
  reviewStdoutFallbackWarned = true;

  const reason = formatReviewStdoutError(error).trim();
  process.stderr.write(
    `[review] Raw stdout unavailable; falling back to process.stdout. Output may appear on stderr in print mode${reason ? ` (${reason})` : ""}.\n`,
  );
}

export async function writeReviewStdout(text: string): Promise<void> {
  try {
    const writeRawStdout = await getRawStdoutWriter();
    writeRawStdout(text);
  } catch (error) {
    warnReviewStdoutFallback(error);
    process.stdout.write(text);
  }
}

export function detectReviewOutputMode(argv: string[] = process.argv): ReviewOutputMode {
  const hasJson = argv.some((arg, i) => arg === "--mode" && argv[i + 1] === "json");
  const hasPrint = argv.includes("-p") || argv.includes("--print");

  if (hasJson && hasPrint) {
    throw new Error("Cannot combine --mode json with -p/--print");
  }
  if (hasJson) return "json";
  if (hasPrint) return "print";
  return "interactive";
}

export function buildFindingsReport(
  findings: Finding[],
  options: {
    language: string;
    range: string;
    threshold: FixLevel;
    totalFindings: number;
  },
): string {
  const lines = [
    "# Review report",
    "",
    `Language: ${options.language}`,
    `Range: ${options.range}`,
    `Threshold: ${options.threshold}`,
    `Findings: ${findings.length} of ${options.totalFindings} matched`,
    "",
  ];

  if (findings.length === 0) {
    lines.push(`No findings matched --report ${options.threshold}.`, "");
    return lines.join("\n");
  }

  let findingNumber = 0;
  let currentSeverity: Finding["severity"] | null = null;

  for (const finding of findings) {
    if (finding.severity !== currentSeverity) {
      if (currentSeverity !== null) {
        lines.push("");
      }
      currentSeverity = finding.severity;
      lines.push(`## ${finding.severity}`, "");
    }

    findingNumber += 1;
    lines.push(`### ${findingNumber}. ${finding.title}`);
    if (finding.file) {
      lines.push(`File: ${finding.file}`);
    }
    lines.push(`Skill: ${finding.skill}`);
    if (finding.effort) {
      lines.push(`Effort: ${finding.effort}`);
    }
    lines.push("", `Issue:\n${finding.issue}`, "", `Suggested fix:\n${finding.suggestion}`, "");
  }

  return lines.join("\n");
}

export type ReviewDependencies = {
  skills?: ReviewSkill[];
  parseReviewArgs?: typeof parseReviewArgs;
  gatherRangeDiff?: typeof gatherRangeDiff;
  runReviews?: typeof runReviews;
  processFindingActions?: typeof processFindingActions;
  showFinding?: typeof showFinding;
  buildFixMessage?: typeof buildFixMessage;
  queueFixFollowUp?: typeof queueFixFollowUp;
  detectOutputMode?: () => ReviewOutputMode;
  reportPresenter?: (report: string) => void | Promise<void>;
  reportErrorWriter?: (message: string) => void;
};

export function registerReviewCommand(
  pi: ExtensionAPI,
  deps: ReviewDependencies = {},
) {
  const allSkills = deps.skills ?? discoverReviewSkills(getSkillsDirs());
  const languages = getLanguages(allSkills);

  const parseArgs = deps.parseReviewArgs ?? parseReviewArgs;
  const getRangeDiff = deps.gatherRangeDiff ?? gatherRangeDiff;
  const runReviewSkills = deps.runReviews ?? runReviews;
  const processActions = deps.processFindingActions ?? processFindingActions;
  const showFindingUI = deps.showFinding ?? showFinding;
  const buildFixPrompt = deps.buildFixMessage ?? buildFixMessage;
  const queueFix = deps.queueFixFollowUp ?? queueFixFollowUp;
  const detectOutputMode = deps.detectOutputMode ?? (() => detectReviewOutputMode());
  const reportPresenter = deps.reportPresenter ?? ((report: string) => writeReviewStdout(report));
  const reportErrorWriter = deps.reportErrorWriter
    ?? ((message: string) => process.stderr.write(message + "\n"));

  pi.registerCommand("review", {
    description:
      "Run code review skills and iterate through findings interactively",

    getArgumentCompletions(prefix: string): AutocompleteItem[] | null {
      const parts = prefix.split(/\s+/);

      if (parts.length <= 1) {
        const items = languages.map((l) => ({ value: l, label: l }));
        const filtered = items.filter((i) =>
          i.value.startsWith(parts[0] || ""),
        );
        return filtered.length > 0 ? filtered : null;
      }

      const flagTokenIndex = parts.findIndex((part) => part.startsWith("-"));
      if (flagTokenIndex !== -1) {
        return null;
      }

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
      const filtered = items.filter((i) => i.label.startsWith(lastPart));
      return filtered.length > 0 ? filtered : null;
    },

    handler: async (args, ctx) => {
      const parsed = parseArgs(args);
      const outputMode = detectOutputMode();
      const isPrintReportMode = Boolean(parsed.options.reportLevel && outputMode === "print");
      const notify = (message: string, level: NotificationLevel) => {
        if (isPrintReportMode) {
          if (level === "error" || level === "warning") {
            reportErrorWriter(message);
          }
          // info/success suppressed in print mode
          return;
        }
        ctx.ui.notify(message, level);
      };

      if (parsed.error) {
        const langs = languages.join(", ");
        notify(`${parsed.error}\nLanguages: ${langs}`, "warning");
        return;
      }

      if (!parsed.language) {
        const langs = languages.join(", ");
        notify(`${REVIEW_USAGE}\nLanguages: ${langs}`, "warning");
        return;
      }

      if (parsed.options.reportLevel) {
        if (outputMode === "json") {
          notify(
            "--report requires print mode (-p). It cannot be used in JSON mode.",
            "error",
          );
          return;
        }
        if (outputMode !== "print") {
          notify(
            `--report requires print mode. Run: pi -p \"/review ${args.trim() || parsed.language}\"`,
            "error",
          );
          return;
        }
      } else if (!ctx.hasUI) {
        notify("review requires interactive terminal", "error");
        return;
      }

      if (!ctx.model) {
        notify("No model selected", "error");
        return;
      }

      const language = parsed.language;
      const typeFilter = parsed.types.length > 0 ? parsed.types : undefined;
      const skills = filterSkills(allSkills, language, typeFilter);

      if (skills.length === 0) {
        const available = getTypesForLanguage(allSkills, language);
        if (available.length === 0) {
          notify(
            `No review skills found for "${language}". Available: ${languages.join(", ")}`,
            "error",
          );
        } else {
          notify(
            `No matching review types. Available for ${language}: ${available.join(", ")}`,
            "error",
          );
        }
        return;
      }

      notify(
        `Running ${skills.length} review skill${skills.length > 1 ? "s" : ""}: ${skills.map((s) => s.type).join(", ")} (range: ${parsed.options.range})`,
        "info",
      );

      const rangeResult = await getRangeDiff(pi, ctx, parsed.options.range);
      if (rangeResult.error) {
        notify(rangeResult.error, "error");
        return;
      }

      const fullDiff = rangeResult.diff;
      if (fullDiff === null) {
        notify(
          `No code changes found for range ${parsed.options.range}`,
          "warning",
        );
        return;
      }

      const langExtensions = getLanguageExtensions(language);
      const codeContext = langExtensions
        ? filterDiffByExtensions(fullDiff, langExtensions)
        : fullDiff;

      if (codeContext === null) {
        notify(
          `No ${language} files found in range ${parsed.options.range}`,
          "warning",
        );
        return;
      }

      const reviewFiles = extractFilesFromDiff(codeContext);
      if (reviewFiles.length > 0) {
        const fileList = reviewFiles.map((f) => `  ${f}`).join("\n");
        notify(
          `Reviewing ${reviewFiles.length} file${reviewFiles.length > 1 ? "s" : ""}:\n${fileList}`,
          "info",
        );
      }

      const reviewResult = await runReviewSkills(ctx, skills, codeContext);

      if (!reviewResult.ok) {
        if (reviewResult.cancelled) {
          notify("Review cancelled", "info");
        } else {
          notify(`Review failed: ${reviewResult.error}`, "error");
        }
        return;
      }

      const { findings: allFindings, totalResponseLength } = reviewResult;

      if (allFindings.length === 0) {
        if (parsed.options.reportLevel) {
          if (totalResponseLength >= MIN_RESPONSE_FOR_SUSPICION) {
            reportErrorWriter(REVIEW_PARSE_WARNING);
            return;
          }

          await reportPresenter(buildFindingsReport([], {
            language,
            range: parsed.options.range,
            threshold: parsed.options.reportLevel,
            totalFindings: 0,
          }));
          return;
        }

        if (totalResponseLength >= MIN_RESPONSE_FOR_SUSPICION) {
          notify(REVIEW_PARSE_WARNING, "warning");
        } else {
          notify("No issues found! \u{1F389}", "success");
        }
        return;
      }

      const dedupedFindings = deduplicateFindings(allFindings);

      dedupedFindings.sort(
        (a, b) => severityRank(a.severity) - severityRank(b.severity),
      );

      const duplicateCount = allFindings.length - dedupedFindings.length;
      if (duplicateCount > 0) {
        notify(
          `Merged ${duplicateCount} duplicate finding${duplicateCount > 1 ? "s" : ""} across review types.`,
          "info",
        );
      }

      notify(
        `Found ${dedupedFindings.length} issue${dedupedFindings.length > 1 ? "s" : ""}.`,
        "info",
      );

      if (parsed.options.reportLevel) {
        const reportLevel = parsed.options.reportLevel;
        const matchedFindings = dedupedFindings.filter((finding) =>
          matchesFixThreshold(finding.severity, reportLevel),
        );

        const report = buildFindingsReport(matchedFindings, {
          language,
          range: parsed.options.range,
          threshold: reportLevel,
          totalFindings: dedupedFindings.length,
        });
        await reportPresenter(report);
        return;
      }

      if (parsed.options.fixLevel) {
        const autoFixResult = await queueAutoFixes({
          pi,
          ctx,
          findings: dedupedFindings,
          fixLevel: parsed.options.fixLevel,
          buildFixMessage: buildFixPrompt,
          queueFixFollowUp: queueFix,
        });

        notifyQueueSummary(ctx, autoFixResult);

        if (autoFixResult.skippedCount > 0) {
          notify(
            `Skipped ${autoFixResult.skippedCount} finding${autoFixResult.skippedCount > 1 ? "s" : ""} below --fix ${parsed.options.fixLevel}.`,
            "info",
          );
        }

        notify("Review complete", "info");
        return;
      }

      notify("Let's go through them.", "info");

      const result = await processActions({
        pi,
        ctx,
        findings: dedupedFindings,
        showFinding: (finding: Finding, index: number, total: number) =>
          showFindingUI(ctx, finding, index, total),
        buildFixMessage: buildFixPrompt,
      });

      if (result.stoppedAt !== null) {
        notify(
          `Stopped at finding ${result.stoppedAt + 1}/${dedupedFindings.length}`,
          "info",
        );
      }
      notifyQueueSummary(ctx, result);
      notify("Review complete", "info");
    },
  });
}

export default function(pi: ExtensionAPI) {
  registerReviewCommand(pi);
}

type AutoFixQueueResult = {
  queuedFixCount: number;
  queueFailures: number;
  skippedCount: number;
};

type BuildFixMessageFn = (
  finding: Finding,
  customInstructions?: string,
) => string;

type QueueFixFollowUpFn = typeof queueFixFollowUp;

export function matchesFixThreshold(
  severity: Finding["severity"],
  fixLevel: FixLevel,
): boolean {
  if (fixLevel === "all" || fixLevel === "low") {
    return true;
  }

  if (fixLevel === "medium") {
    return severity === "HIGH" || severity === "MEDIUM";
  }

  return severity === "HIGH";
}

/** Maximum number of findings in a single bulk fix message. */
const MAX_BULK_FINDINGS = 20;

/** Maximum character length for a bulk fix message. */
const MAX_MESSAGE_LENGTH = 50_000;

async function queueAutoFixes({
  pi,
  ctx,
  findings,
  fixLevel,
  buildFixMessage,
  queueFixFollowUp,
}: {
  pi: ExtensionAPI;
  ctx: ReviewContext;
  findings: Finding[];
  fixLevel: FixLevel;
  buildFixMessage: BuildFixMessageFn;
  queueFixFollowUp: QueueFixFollowUpFn;
}): Promise<AutoFixQueueResult> {
  let selectedFindings: Finding[] = [];
  let skippedCount = 0;

  for (const finding of findings) {
    if (matchesFixThreshold(finding.severity, fixLevel)) {
      selectedFindings.push(finding);
    } else {
      skippedCount += 1;
    }
  }

  if (selectedFindings.length === 0) {
    return {
      queuedFixCount: 0,
      queueFailures: 0,
      skippedCount,
    };
  }

  if (selectedFindings.length > MAX_BULK_FINDINGS) {
    const truncatedCount = selectedFindings.length - MAX_BULK_FINDINGS;
    selectedFindings = selectedFindings.slice(0, MAX_BULK_FINDINGS);
    ctx.ui.notify(
      `Truncated bulk fix to ${MAX_BULK_FINDINGS} findings (${truncatedCount} omitted).`,
      "warning",
    );
  }

  let message = buildBulkFixMessage(selectedFindings, buildFixMessage);

  if (message.length > MAX_MESSAGE_LENGTH) {
    message = message.slice(0, MAX_MESSAGE_LENGTH).trimEnd() + "\n";
    ctx.ui.notify(
      `Bulk fix message truncated to ${MAX_MESSAGE_LENGTH} characters.`,
      "warning",
    );
  }

  const queueResult = await queueFixFollowUp(pi, message);

  if (queueResult.ok) {
    return {
      queuedFixCount: 1,
      queueFailures: 0,
      skippedCount,
    };
  }

  const reason = formatQueueError(queueResult.error);
  ctx.ui.notify(
    `Failed to queue auto-fix batch${reason ? ` (${reason})` : ""}`,
    "error",
  );

  return {
    queuedFixCount: 0,
    queueFailures: 1,
    skippedCount,
  };
}

/**
 * Build the system prompt for a review skill, including context about
 * previously reported findings to avoid duplicates.
 */
export function buildSystemPrompt(
  skillContent: string,
  existingFindings: Finding[],
): string {
  const existingFindingsSummary = summarizeExistingFindings(existingFindings);

  let prompt = "You are a code reviewer. Follow these instructions precisely.\n\n";
  prompt += skillContent + "\n\n";
  if (existingFindingsSummary) {
    prompt +=
      "Findings already reported by other review types (do NOT repeat these; only report genuinely new issues):\n";
    prompt += existingFindingsSummary + "\n\n";
  }
  prompt +=
    "IMPORTANT: Output findings in the exact format specified. Each finding MUST start with ### [SEVERITY] on its own line.";
  return prompt;
}

/**
 * Extract concatenated text from an LLM response content array,
 * filtering for text content blocks only.
 */
export function extractResponseText(
  content: Array<{ type: string; text?: string }>,
): string {
  return content
    .filter((c): c is TextContent => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Execute the review skills against the code context.
 * Used by both the interactive spinner path and headless print mode.
 */
export async function executeReviewSkills(
  ctx: ReviewContext,
  skills: ReviewSkill[],
  codeContext: string,
  complete: PiAiRuntime["complete"],
  options: {
    signal?: AbortSignal;
    onSkillStart?: (skill: ReviewSkill, index: number, total: number) => void;
  } = {},
): Promise<ReviewResult> {
  const findings: Finding[] = [];
  let totalResponseLength = 0;
  const model = resolveReviewModelObject(ctx);

  if (!model) {
    return {
      ok: false,
      cancelled: false,
      error: "No model selected",
    };
  }

  const { apiKey, headers } = await resolveReviewRequestAuth(ctx, model);

  // Skills run sequentially so each skill's system prompt can include
  // findings from prior skills, enabling cross-skill deduplication.
  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i]!;
    options.onSkillStart?.(skill, i, skills.length);

    const skillContent = await fs.promises.readFile(skill.path, "utf-8");
    const systemPrompt = buildSystemPrompt(skillContent, findings);

    const userMessage: UserMessage = {
      role: "user",
      content: [
        {
          type: "text",
          text:
            "Please review the following code changes:\n\n```diff\n"
            + codeContext
            + "\n```",
        },
      ],
      timestamp: Date.now(),
    };

    const response = await complete(
      model,
      { systemPrompt, messages: [userMessage] },
      { apiKey, headers, signal: options.signal },
    );

    if (response.stopReason === "aborted") {
      return { ok: false, cancelled: true };
    }

    const responseText = extractResponseText(response.content);
    totalResponseLength += responseText.length;
    findings.push(...parseFindings(responseText, skill.name));
  }

  return { ok: true, findings, totalResponseLength };
}

/**
 * Run all review skills against the code context.
 * Shows a spinner when UI is available and runs headlessly otherwise.
 */
async function runReviews(
  ctx: ReviewContext,
  skills: ReviewSkill[],
  codeContext: string,
): Promise<ReviewResult> {
  const { complete } = await getPiAiRuntime();

  if (!ctx.hasUI) {
    try {
      return await executeReviewSkills(ctx, skills, codeContext, complete);
    } catch (err) {
      console.error("Review failed:", err);
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, cancelled: false, error: message };
    }
  }

  const { BorderedLoader } = await getCodingAgentRuntime();

  const result = await ctx.ui.custom<ReviewResult>(
    (tui: any, theme: any, _kb: any, done: (v: ReviewResult) => void) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Running ${skills.length} review${skills.length > 1 ? "s" : ""}...`,
      );
      loader.onAbort = () => done({ ok: false, cancelled: true });

      executeReviewSkills(ctx, skills, codeContext, complete, {
        signal: loader.signal,
        onSkillStart: (skill, index, total) => {
          (loader as any).loader?.setMessage?.(
            `[${index + 1}/${total}] Running ${skill.name}...`,
          );
        },
      })
        .then(done)
        .catch((err) => {
          console.error("Review failed:", err);
          const message = err instanceof Error ? err.message : String(err);
          done({ ok: false, cancelled: false, error: message });
        });

      return loader;
    },
  );
  return result;
}

/**
 * Show a single finding in an inline TUI and get the user's action.
 * Accepts an optional pre-loaded TuiRuntime to avoid repeated dynamic imports.
 */
async function showFinding(
  ctx: ReviewContext,
  finding: Finding,
  index: number,
  total: number,
  tuiRuntime?: TuiRuntime,
): Promise<FindingAction> {
  const { Key, matchesKey, truncateToWidth } =
    tuiRuntime ?? (await getTuiRuntime());

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
        const add = (s: string) => lines.push(truncateToWidth(s, width));
        const blank = () => lines.push("");

        // Top border
        add(theme.fg("accent", "\u2500".repeat(width)));

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
          add(
            ` ${theme.fg("dim", "File:")} ${theme.fg("accent", finding.file)}`,
          );
        }
        if (finding.category) {
          add(
            ` ${theme.fg("dim", "Category:")} ${theme.fg("muted", finding.category)}  ${theme.fg("dim", "Skill:")} ${theme.fg("muted", finding.skill)}`,
          );
        } else {
          add(
            ` ${theme.fg("dim", "Skill:")} ${theme.fg("muted", finding.skill)}`,
          );
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
          const prefix = selected ? theme.fg("accent", "> ") : "  ";
          const color = selected ? "accent" : "text";
          add(
            `${prefix}${theme.fg(color, `${i + 1}. ${options[i].label}`)}`,
          );
        }

        // Custom instructions input
        if (inputMode) {
          blank();
          add(
            ` ${theme.fg("muted", "Instructions:")} ${theme.fg("text", inputBuffer)}${theme.fg("accent", "\u2588")}`,
          );
          add(theme.fg("dim", " Enter to submit \u2022 Esc to cancel"));
        }

        blank();

        // Help text
        if (!inputMode) {
          add(
            theme.fg(
              "dim",
              " \u2191\u2193 navigate \u2022 Enter select \u2022 Esc skip",
            ),
          );
        }
        // Bottom border
        add(theme.fg("accent", "\u2500".repeat(width)));

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
  let message = "Please fix the following code review finding:\n\n";
  message += `**${finding.severity}: ${finding.title}**\n`;
  if (finding.file) {
    message += `File: ${finding.file}\n`;
  }
  message += "\nIssue: " + finding.issue + "\n";
  message += "\nSuggested fix: " + finding.suggestion + "\n";

  if (customInstructions) {
    message += "\nAdditional instructions: " + customInstructions + "\n";
  }
  return message;
}

export function buildBulkFixMessage(
  findings: Finding[],
  buildFixMessage: BuildFixMessageFn,
): string {
  const parts: string[] = [
    "Please fix all of the following code review findings in one pass.",
    "Address them in order. Keep behavior unchanged except for the fixes.",
    "",
  ];

  for (let i = 0; i < findings.length; i++) {
    const finding = findings[i]!;
    parts.push(`--- Finding ${i + 1}/${findings.length} ---`);
    parts.push(buildFixMessage(finding).trimEnd());
    parts.push("");
  }

  return parts.join("\n").trimEnd() + "\n";
}

/**
 * Summarize existing findings to reduce duplicate reports from later review skills.
 */
function summarizeExistingFindings(findings: Finding[]): string {
  if (findings.length === 0) return "";

  return findings
    .slice(0, 30)
    .map((f) => {
      const location = f.file ? ` (${stripLineFromFile(f.file)})` : "";
      return `- [${f.severity}] ${f.title}${location}`;
    })
    .join("\n");
}

/**
 * Merge duplicate findings reported by multiple review skills.
 */
function deduplicateFindings(findings: Finding[]): Finding[] {
  const byKey = new Map<string, Finding>();

  for (const finding of findings) {
    const key = [
      normalize(stripLineFromFile(finding.file || "")),
      normalize(finding.title),
      normalize(finding.issue),
    ].join("|");

    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, finding);
      continue;
    }

    byKey.set(key, mergeFindings(existing, finding));
  }

  return [...byKey.values()];
}

function mergeFindings(a: Finding, b: Finding): Finding {
  const skillSet = new Set(
    [a.skill, b.skill]
      .flatMap((s) => s.split(","))
      .map((s) => s.trim())
      .filter(Boolean),
  );

  return {
    ...a,
    severity: moreSevere(a.severity, b.severity),
    skill: [...skillSet].join(", "),
    suggestion:
      b.suggestion.length > a.suggestion.length ? b.suggestion : a.suggestion,
    issue: b.issue.length > a.issue.length ? b.issue : a.issue,
    effort: moreEffort(a.effort, b.effort),
  };
}

function moreSevere(
  a: Finding["severity"],
  b: Finding["severity"],
): Finding["severity"] {
  const order: Record<Finding["severity"], number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
  };
  return order[a] <= order[b] ? a : b;
}

function moreEffort(
  a: Finding["effort"],
  b: Finding["effort"],
): Finding["effort"] {
  const order: Record<NonNullable<Finding["effort"]>, number> = {
    trivial: 0,
    small: 1,
    medium: 2,
    large: 3,
  };

  if (!a) return b;
  if (!b) return a;
  return order[a] >= order[b] ? a : b;
}

function stripLineFromFile(file: string): string {
  return file.replace(/:\d+(?::\d+)?$/, "");
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
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
