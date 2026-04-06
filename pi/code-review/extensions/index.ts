/**
 * Interactive Code Review Extension
 *
 * /review <language> [types...] [-r|--revisions <range>] [--fix <level>]
 *
 * Examples:
 *   /review gleam                     — all gleam review skills on range @
 *   /review gleam code -r main..@     — only gleam-code-review for range main..@
 *   /review fsharp security --fix high — auto-fix HIGH findings in current range
 *
 * Flow:
 *   1. Discovers matching review skills
 *   2. Reads code for the requested range (jj first, git fallback)
 *   3. Runs each skill via complete() with a spinner
 *   4. Parses findings from LLM output
 *   5. If --fix is set, auto-queues fixes by severity threshold
 *   6. Otherwise presents findings one-at-a-time in an inline TUI
 *   7. User picks: Fix / Fix with instructions / Skip / Stop
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
      if (result.ok) {
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

export type ReviewDependencies = {
  skills?: ReviewSkill[];
  parseReviewArgs?: typeof parseReviewArgs;
  gatherRangeDiff?: typeof gatherRangeDiff;
  runReviews?: typeof runReviews;
  processFindingActions?: typeof processFindingActions;
  showFinding?: typeof showFinding;
  buildFixMessage?: typeof buildFixMessage;
  queueFixFollowUp?: typeof queueFixFollowUp;
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
      if (!ctx.hasUI) {
        ctx.ui.notify("review requires interactive terminal", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const parsed = parseArgs(args);
      if (parsed.error) {
        const langs = languages.join(", ");
        ctx.ui.notify(`${parsed.error}\nLanguages: ${langs}`, "warning");
        return;
      }

      if (!parsed.language) {
        const langs = languages.join(", ");
        ctx.ui.notify(`${REVIEW_USAGE}\nLanguages: ${langs}`, "warning");
        return;
      }

      const language = parsed.language;
      const typeFilter = parsed.types.length > 0 ? parsed.types : undefined;
      const skills = filterSkills(allSkills, language, typeFilter);

      if (skills.length === 0) {
        const available = getTypesForLanguage(allSkills, language);
        if (available.length === 0) {
          ctx.ui.notify(
            `No review skills found for "${language}". Available: ${languages.join(", ")}`,
            "error",
          );
        } else {
          ctx.ui.notify(
            `No matching review types. Available for ${language}: ${available.join(", ")}`,
            "error",
          );
        }
        return;
      }

      ctx.ui.notify(
        `Running ${skills.length} review skill${skills.length > 1 ? "s" : ""}: ${skills.map((s) => s.type).join(", ")} (range: ${parsed.options.range})`,
        "info",
      );

      const rangeResult = await getRangeDiff(pi, ctx, parsed.options.range);
      if (rangeResult.error) {
        ctx.ui.notify(rangeResult.error, "error");
        return;
      }

      const fullDiff = rangeResult.diff;
      if (fullDiff === null) {
        ctx.ui.notify(
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
        ctx.ui.notify(
          `No ${language} files found in range ${parsed.options.range}`,
          "warning",
        );
        return;
      }

      const reviewFiles = extractFilesFromDiff(codeContext);
      if (reviewFiles.length > 0) {
        const fileList = reviewFiles.map((f) => `  ${f}`).join("\n");
        ctx.ui.notify(
          `Reviewing ${reviewFiles.length} file${reviewFiles.length > 1 ? "s" : ""}:\n${fileList}`,
          "info",
        );
      }

      const reviewResult = await runReviewSkills(pi, ctx, skills, codeContext);

      if (!reviewResult.ok) {
        if (reviewResult.cancelled) {
          ctx.ui.notify("Review cancelled", "info");
        } else {
          ctx.ui.notify(`Review failed: ${reviewResult.error}`, "error");
        }
        return;
      }

      const { findings: allFindings, totalResponseLength } = reviewResult;

      if (allFindings.length === 0) {
        const MIN_RESPONSE_FOR_SUSPICION = 200;
        if (totalResponseLength >= MIN_RESPONSE_FOR_SUSPICION) {
          ctx.ui.notify(
            "Review completed but no findings could be parsed — the response may not have used the expected format. Try again or check the diff format.",
            "warning",
          );
        } else {
          ctx.ui.notify("No issues found! \u{1F389}", "success");
        }
        return;
      }

      const dedupedFindings = deduplicateFindings(allFindings);

      const severityOrder: Record<string, number> = {
        HIGH: 0,
        MEDIUM: 1,
        LOW: 2,
      };
      dedupedFindings.sort(
        (a, b) =>
          (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3),
      );

      const duplicateCount = allFindings.length - dedupedFindings.length;
      if (duplicateCount > 0) {
        ctx.ui.notify(
          `Merged ${duplicateCount} duplicate finding${duplicateCount > 1 ? "s" : ""} across review types.`,
          "info",
        );
      }

      ctx.ui.notify(
        `Found ${dedupedFindings.length} issue${dedupedFindings.length > 1 ? "s" : ""}.`,
        "info",
      );

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
          ctx.ui.notify(
            `Skipped ${autoFixResult.skippedCount} finding${autoFixResult.skippedCount > 1 ? "s" : ""} below --fix ${parsed.options.fixLevel}.`,
            "info",
          );
        }

        ctx.ui.notify("Review complete", "info");
        return;
      }

      ctx.ui.notify("Let's go through them.", "info");

      const result = await processActions({
        pi,
        ctx,
        findings: dedupedFindings,
        showFinding: (finding: Finding, index: number, total: number) =>
          showFindingUI(ctx, finding, index, total),
        buildFixMessage: buildFixPrompt,
      });

      if (result.stoppedAt !== null) {
        ctx.ui.notify(
          `Stopped at finding ${result.stoppedAt + 1}/${dedupedFindings.length}`,
          "info",
        );
      }
      notifyQueueSummary(ctx, result);
      ctx.ui.notify("Review complete", "info");
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
 * Run all review skills against the code context.
 * Shows a spinner while processing.
 */
async function runReviews(
  pi: ExtensionAPI,
  ctx: ReviewContext,
  skills: ReviewSkill[],
  codeContext: string,
): Promise<ReviewResult> {
  const [{ complete }, { BorderedLoader }] = await Promise.all([
    getPiAiRuntime(),
    getCodingAgentRuntime(),
  ]);

  const result = await ctx.ui.custom<ReviewResult>(
    (tui: any, theme: any, _kb: any, done: (v: ReviewResult) => void) => {
      const loader = new BorderedLoader(
        tui,
        theme,
        `Running ${skills.length} review${skills.length > 1 ? "s" : ""}...`,
      );
      loader.onAbort = () => done({ ok: false, cancelled: true });

      const doReviews = async () => {
        const findings: Finding[] = [];
        let totalResponseLength = 0;
        const model = resolveReviewModelObject(ctx);

        if (!model) {
          return {
            ok: false as const,
            cancelled: false as const,
            error: "No model selected",
          };
        }

        const { apiKey, headers } = await resolveReviewRequestAuth(ctx, model);

        for (let i = 0; i < skills.length; i++) {
          const skill = skills[i];

          // Update the inner loader's message to show progress
          // The loader field is the CancellableLoader/Loader which has setMessage()
          (loader as any).loader?.setMessage?.(
            `[${i + 1}/${skills.length}] Running ${skill.name}...`,
          );

          const skillContent = fs.readFileSync(skill.path, "utf-8");

          const systemPrompt = buildSystemPrompt(skillContent, findings);

          const userMessage: UserMessage = {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Please review the following code changes:\n\n```diff\n" +
                  codeContext +
                  "\n```",
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            model,
            { systemPrompt, messages: [userMessage] },
            { apiKey, headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") {
            return { ok: false as const, cancelled: true as const };
          }

          const responseText = extractResponseText(response.content);

          totalResponseLength += responseText.length;
          findings.push(...parseFindings(responseText, skill.name));
        }

        return { ok: true as const, findings, totalResponseLength };
      };

      doReviews()
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
