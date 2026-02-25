/**
 * Pipeline orchestration for jj-commit.
 *
 * This module coordinates:
 * 1. Model resolution (preferred Sonnet 4.6 → session → deterministic fallback)
 * 2. Optional jj absorb pre-pass
 * 3. Agentic commit analysis (or deterministic fallback)
 * 4. Changelog detection and application
 * 5. Commit execution (single or split)
 * 6. Optional bookmark + push
 */

import type { ControlledJj } from "./jj.ts";
import type { CommitCommandArgs, CommitProposal, SplitCommitPlan } from "./types.ts";
import { resolveCommitModel } from "./model-resolver.ts";
import type { ModelCandidate } from "./model-resolver.ts";
import { generateFallbackProposal } from "./fallback.ts";
import { formatCommitMessage } from "./message.ts";
import { computeDependencyOrder, validateSplitPlan } from "./validation.ts";
import { detectChangelogBoundaries, parseUnreleasedSection, applyChangelogEntries } from "./changelog.ts";
import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PipelineContext {
  jj: ControlledJj;
  cwd: string;
  args: CommitCommandArgs;

  /** All models available in the registry */
  availableModels: ModelCandidate[];
  /** Currently active session model */
  sessionModel?: ModelCandidate;
  /** Check if an API key exists */
  hasApiKey: (model: ModelCandidate) => Promise<boolean>;

  /**
   * Run the agentic commit session — injected by the extension layer.
   * Returns a proposal (single or split) and optional changelog entries.
   * Null means the agent could not produce a proposal.
   */
  runAgenticSession?: (input: AgenticSessionInput) => Promise<AgenticSessionResult>;

  /** Callback for progress output */
  onProgress?: (message: string) => void;
}

export interface AgenticSessionInput {
  cwd: string;
  jj: ControlledJj;
  model: ModelCandidate;
  changedFiles: string[];
  diff: string;
  stat: string;
  changelogTargets: string[];
  userContext?: string;
}

export interface AgenticSessionResult {
  proposal?: CommitProposal;
  splitPlan?: SplitCommitPlan;
  changelogEntries?: Array<{
    path: string;
    entries: Record<string, string[]>;
  }>;
}

export interface PipelineResult {
  /** Whether the pipeline actually committed anything */
  committed: boolean;
  /** Summary of what happened */
  summary: string;
  /** Warnings accumulated during execution */
  warnings: string[];
  /** The commit message(s) used */
  messages: string[];
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

export async function runCommitPipeline(ctx: PipelineContext): Promise<PipelineResult> {
  const { jj, args } = ctx;
  const warnings: string[] = [];
  const messages: string[] = [];
  const progress = ctx.onProgress ?? (() => {});

  // 1. Check for changes
  progress("Checking working copy...");
  let changedFiles = await jj.getChangedFiles();
  if (changedFiles.length === 0) {
    return { committed: false, summary: "Nothing to commit.", warnings, messages };
  }

  // 2. Optional absorb pre-pass
  if (!args.noAbsorb) {
    progress("Running jj absorb...");
    try {
      const absorbResult = await jj.absorb();
      if (absorbResult.changed) {
        progress(`Absorb applied: ${absorbResult.output}`);
        // Re-check changed files after absorb
        changedFiles = await jj.getChangedFiles();
        if (changedFiles.length === 0) {
          return {
            committed: false,
            summary: "All changes were absorbed into ancestor commits.",
            warnings,
            messages,
          };
        }
      }
    } catch {
      warnings.push("jj absorb failed; continuing without absorb.");
    }
  }

  // 3. Resolve model
  progress("Resolving model...");
  const modelResult = await resolveCommitModel({
    availableModels: ctx.availableModels,
    sessionModel: ctx.sessionModel,
    hasApiKey: ctx.hasApiKey,
  });
  warnings.push(...modelResult.warnings);

  // 4. Detect changelog targets
  let changelogTargets: string[] = [];
  if (!args.noChangelog) {
    progress("Detecting changelog targets...");
    const boundaries = await detectChangelogBoundaries(ctx.cwd, changedFiles);
    changelogTargets = boundaries.map((b) => b.changelogPath);
    if (changelogTargets.length > 0) {
      progress(`Found changelog targets: ${changelogTargets.join(", ")}`);
    }
  }

  // 5. Get proposal — agentic or fallback
  let proposal: CommitProposal | undefined;
  let splitPlan: SplitCommitPlan | undefined;
  let changelogResults: AgenticSessionResult["changelogEntries"];

  if (modelResult.model && ctx.runAgenticSession) {
    progress(`Planning commits with ${modelResult.model.name}...`);
    try {
      // Diff/stat can be expensive in large repositories; only fetch when
      // we actually run agentic analysis.
      const diff = await jj.getDiffGit();
      const stat = await jj.getStat();

      const agenticResult = await ctx.runAgenticSession({
        cwd: ctx.cwd,
        jj,
        model: modelResult.model,
        changedFiles,
        diff,
        stat,
        changelogTargets,
        userContext: args.context,
      });
      proposal = agenticResult.proposal;
      splitPlan = agenticResult.splitPlan;
      changelogResults = agenticResult.changelogEntries;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Agentic session failed: ${msg}. Using deterministic fallback.`);
    }
  }

  // Deterministic fallback if no proposal
  if (!proposal && !splitPlan) {
    progress("Using deterministic fallback...");
    proposal = generateFallbackProposal(changedFiles);
    warnings.push(...proposal.warnings);
  }

  // Validate split plans before any changelog/file mutations or execution.
  if (splitPlan) {
    const splitValidation = validateSplitPlan(splitPlan, changedFiles);
    warnings.push(...splitValidation.warnings.map((w) => `Split plan warning: ${w}`));

    if (splitValidation.errors.length > 0) {
      warnings.push(
        `Split plan validation failed with ${splitValidation.errors.length} error(s).`,
      );
      return {
        committed: false,
        summary:
          "Invalid split commit plan; no commits were created.\n" +
          splitValidation.errors.map((e) => `- ${e}`).join("\n"),
        warnings,
        messages,
      };
    }
  }

  // 6. Apply changelog entries (existing files only)
  if (!args.noChangelog && changelogResults && changelogResults.length > 0) {
    progress("Applying changelog entries...");

    const updateOne = async (entry: { path: string; entries: Record<string, string[]> }) => {
      try {
        try {
          await fs.access(entry.path);
        } catch {
          warnings.push(`Changelog path does not exist: ${entry.path} — skipping.`);
          return;
        }

        const content = await fs.readFile(entry.path, "utf-8");
        const lines = content.split("\n");
        const unreleased = parseUnreleasedSection(lines);
        const updated = applyChangelogEntries(lines, unreleased, entry.entries);
        if (!args.dryRun) {
          await fs.writeFile(entry.path, updated);
        }
        progress(`Updated ${entry.path}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warnings.push(`Changelog update failed for ${entry.path}: ${msg}`);
      }
    };

    await runWithConcurrency(changelogResults, 4, updateOne);
  }

  // 7. Dry-run or execute
  if (args.dryRun) {
    return executeDryRun(proposal, splitPlan, warnings, messages);
  }

  if (splitPlan) {
    return executeSplitCommit(jj, splitPlan, changelogTargets, warnings, messages, progress);
  }

  if (proposal) {
    return executeSingleCommit(jj, proposal, warnings, messages, progress);
  }

  return { committed: false, summary: "No proposal generated.", warnings, messages };
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(limit, items.length));
  let index = 0;

  const runners = Array.from({ length: width }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      await worker(items[current]);
    }
  });

  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Execution helpers
// ---------------------------------------------------------------------------

function executeDryRun(
  proposal: CommitProposal | undefined,
  splitPlan: SplitCommitPlan | undefined,
  warnings: string[],
  messages: string[],
): PipelineResult {
  if (splitPlan) {
    const lines: string[] = ["Split commit plan (dry run):"];
    for (let i = 0; i < splitPlan.commits.length; i++) {
      const g = splitPlan.commits[i];
      const msg = formatCommitMessage(g.type, g.scope, g.summary, g.details);
      messages.push(msg);
      lines.push(`\nCommit ${i + 1}:`);
      lines.push(msg);
      lines.push(`Files: ${g.files.join(", ")}`);
    }
    return { committed: false, summary: lines.join("\n"), warnings, messages };
  }

  if (proposal) {
    const msg = formatCommitMessage(proposal.type, proposal.scope, proposal.summary, proposal.details);
    messages.push(msg);
    return {
      committed: false,
      summary: `Generated commit message:\n${msg}`,
      warnings,
      messages,
    };
  }

  return { committed: false, summary: "No proposal generated.", warnings, messages };
}

async function executeSingleCommit(
  jj: ControlledJj,
  proposal: CommitProposal,
  warnings: string[],
  messages: string[],
  progress: (msg: string) => void,
): Promise<PipelineResult> {
  const msg = formatCommitMessage(proposal.type, proposal.scope, proposal.summary, proposal.details);
  messages.push(msg);
  progress("Creating commit...");
  await jj.commit(msg);
  return { committed: true, summary: "Commit created.", warnings, messages };
}

async function executeSplitCommit(
  jj: ControlledJj,
  plan: SplitCommitPlan,
  changelogTargets: string[],
  warnings: string[],
  messages: string[],
  progress: (msg: string) => void,
): Promise<PipelineResult> {
  // Compute execution order
  const order = computeDependencyOrder(plan.commits);
  if ("error" in order) {
    return {
      committed: false,
      summary: `Split commit failed: ${order.error}`,
      warnings,
      messages,
    };
  }

  progress(`Creating ${plan.commits.length} split commits...`);

  for (const idx of order) {
    const group = plan.commits[idx];
    const msg = formatCommitMessage(group.type, group.scope, group.summary, group.details);
    messages.push(msg);
    progress(`Commit ${idx + 1}: ${group.summary}`);
    // jj commit with file args commits only those files
    await jj.commit(msg, group.files);
  }

  return {
    committed: true,
    summary: `Created ${plan.commits.length} split commits.`,
    warnings,
    messages,
  };
}

// ---------------------------------------------------------------------------
// Bookmark + push helper
// ---------------------------------------------------------------------------

export async function pushWithBookmark(
  jj: ControlledJj,
  bookmark: string,
  progress: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  try {
    progress(`Setting bookmark '${bookmark}' to @-...`);
    await jj.setBookmark(bookmark, "@-");
    progress(`Pushing bookmark '${bookmark}'...`);
    await jj.pushBookmark(bookmark);
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: msg };
  }
}
