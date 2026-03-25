import type { ControlledGit } from "./git.ts";
import type { CommitCommandArgs, CommitProposal, CommitSnapshot, SplitCommitPlan } from "./types.ts";
import type { ModelCandidate } from "./model-resolver.ts";
import { isCompatibleProvider, resolveCommitModel } from "./model-resolver.ts";
import { formatCommitMessage } from "./message.ts";
import { computeDependencyOrder, validateSplitPlan } from "./validation.ts";

export interface PipelineContext {
  git: ControlledGit;
  cwd: string;
  args: CommitCommandArgs;
  snapshot: CommitSnapshot;
  availableModels: ModelCandidate[];
  configuredModel?: ModelCandidate;
  sessionModel?: ModelCandidate;
  hasApiKey: (model: ModelCandidate) => Promise<boolean>;
  runAgenticSession?: (input: AgenticSessionInput) => Promise<AgenticSessionResult>;
  onProgress?: (message: string) => void;
}

export interface AgenticSessionInput {
  cwd: string;
  git: ControlledGit;
  model: ModelCandidate;
  snapshot: CommitSnapshot;
  userContext?: string;
}

export interface AgenticSessionResult {
  proposal?: CommitProposal;
  splitPlan?: SplitCommitPlan;
  debugPath?: string;
}

export interface PipelineResult {
  committed: boolean;
  summary: string;
  warnings: string[];
  messages: string[];
}

export async function runCommitPipeline(ctx: PipelineContext): Promise<PipelineResult> {
  const warnings: string[] = [];
  const messages: string[] = [];
  const progress = ctx.onProgress ?? (() => { });

  if (ctx.snapshot.files.length === 0) {
    return { committed: false, summary: "Nothing to commit.", warnings, messages };
  }

  progress("Resolving model...");
  const modelResult = await resolveCommitModel({
    availableModels: ctx.availableModels,
    configuredModel: ctx.configuredModel,
    sessionModel: ctx.sessionModel,
    hasApiKey: ctx.hasApiKey,
  });
  warnings.push(...modelResult.warnings);

  let proposal: CommitProposal | undefined;
  let splitPlan: SplitCommitPlan | undefined;
  let agenticDebugPath: string | undefined;

  const runAgenticAttempt = async (model: ModelCandidate): Promise<void> => {
    if (!ctx.runAgenticSession) return;

    progress(`Planning commits with ${model.name}...`);
    try {
      const result = await ctx.runAgenticSession({
        cwd: ctx.cwd,
        git: ctx.git,
        model,
        snapshot: ctx.snapshot,
        userContext: ctx.args.context,
      });
      proposal = result.proposal;
      splitPlan = result.splitPlan;
      agenticDebugPath = result.debugPath ?? agenticDebugPath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Agentic session failed: ${message}`);
    }
  };

  if (modelResult.model && ctx.runAgenticSession) {
    await runAgenticAttempt(modelResult.model);

    const shouldRetryWithSessionModel =
      !proposal
      && !splitPlan
      && ctx.sessionModel
      && isCompatibleProvider(ctx.sessionModel)
      && (ctx.sessionModel.provider !== modelResult.model.provider || ctx.sessionModel.id !== modelResult.model.id);

    if (shouldRetryWithSessionModel && await ctx.hasApiKey(ctx.sessionModel)) {
      warnings.push(
        `Primary model ${modelResult.model.provider}/${modelResult.model.id} produced no usable commit plan; retrying with session model ${ctx.sessionModel.provider}/${ctx.sessionModel.id}.`,
      );
      await runAgenticAttempt(ctx.sessionModel);
    }
  }

  if (!proposal && !splitPlan) {
    if (!modelResult.model) {
      return {
        committed: false,
        summary: "No compatible git-commit model is available. Configure ~/.pi/agent/git-commit.json or .pi/git-commit.json, or switch the session model.",
        warnings,
        messages,
      };
    }

    const debugSuffix = agenticDebugPath ? ` Debug output saved to ${agenticDebugPath}` : "";
    warnings.push(`Model response could not be converted into a valid commit plan.${debugSuffix}`);
    return {
      committed: false,
      summary: "No commit proposal could be generated. Check model configuration and try again.",
      warnings,
      messages,
    };
  }

  if (splitPlan) {
    const validation = validateSplitPlan(splitPlan, ctx.snapshot);
    warnings.push(...validation.warnings.map((warning) => `Split plan warning: ${warning}`));
    if (validation.errors.length > 0) {
      return {
        committed: false,
        summary:
          "Invalid split commit plan; no commits were created.\n"
          + validation.errors.map((error) => `- ${error}`).join("\n"),
        warnings,
        messages,
      };
    }
  }

  if (ctx.args.dryRun) {
    return executeDryRun(proposal, splitPlan, warnings, messages);
  }

  if (splitPlan) {
    return executeSplitCommit(ctx.git, ctx.snapshot, splitPlan, warnings, messages, progress);
  }

  if (proposal) {
    return executeSingleCommit(ctx.git, proposal, warnings, messages, progress);
  }

  return { committed: false, summary: "No proposal generated.", warnings, messages };
}

function executeDryRun(
  proposal: CommitProposal | undefined,
  splitPlan: SplitCommitPlan | undefined,
  warnings: string[],
  messages: string[],
): PipelineResult {
  if (splitPlan) {
    const lines = ["Split commit plan (dry run):"];
    for (let i = 0; i < splitPlan.commits.length; i++) {
      const commit = splitPlan.commits[i];
      const message = formatCommitMessage(commit.type, commit.scope, commit.summary, commit.details);
      messages.push(message);
      lines.push(`\nCommit ${i + 1}:`);
      lines.push(message);
      lines.push(
        `Changes: ${commit.changes
          .map((change) =>
            change.hunks.type === "all"
              ? `${change.path} (all)`
              : `${change.path} (hunks ${change.hunks.indices.join(", ")})`
          )
          .join(", ")}`,
      );
    }
    return { committed: false, summary: lines.join("\n"), warnings, messages };
  }

  if (proposal) {
    const message = formatCommitMessage(proposal.type, proposal.scope, proposal.summary, proposal.details);
    messages.push(message);
    return {
      committed: false,
      summary: `Generated commit message:\n${message}`,
      warnings,
      messages,
    };
  }

  return { committed: false, summary: "No proposal generated.", warnings, messages };
}

async function executeSingleCommit(
  git: ControlledGit,
  proposal: CommitProposal,
  warnings: string[],
  messages: string[],
  progress: (message: string) => void,
): Promise<PipelineResult> {
  const message = formatCommitMessage(proposal.type, proposal.scope, proposal.summary, proposal.details);
  messages.push(message);
  progress("Creating commit...");
  await git.commit(message);
  return { committed: true, summary: "Commit created.", warnings, messages };
}

async function executeSplitCommit(
  git: ControlledGit,
  snapshot: CommitSnapshot,
  plan: SplitCommitPlan,
  warnings: string[],
  messages: string[],
  progress: (message: string) => void,
): Promise<PipelineResult> {
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
  await git.resetStaging();

  for (const index of order) {
    const commit = plan.commits[index];
    const message = formatCommitMessage(commit.type, commit.scope, commit.summary, commit.details);
    messages.push(message);
    progress(`Commit ${index + 1}: ${commit.summary}`);
    await git.stageSnapshotChanges(snapshot, commit.changes);
    await git.commit(message);
    await git.resetStaging();
  }

  return {
    committed: true,
    summary: `Created ${plan.commits.length} split commits.`,
    warnings,
    messages,
  };
}
