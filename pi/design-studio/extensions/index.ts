import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { StringEnum } from "@mariozechner/pi-ai";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import {
  formatModelRef,
  loadDesignStudioConfig,
  nextAvailableSavePath,
  type NormalizedConfig,
  type NormalizedModelRef,
  type NormalizedProfile,
  THINKING_LEVELS,
  type ThinkingLevel,
} from "./config.ts";
import { composeFinalDesignDocument, parseCritique } from "./debate-utils.ts";

type DesignPhase = "idle" | "intake" | "awaiting_approval" | "debating";

interface DesignBrief {
  problem?: string;
  goals: string[];
  nonGoals: string[];
  users: string[];
  requirements: string[];
  featureSet: string[];
  constraints: string[];
  integrations: string[];
  risks: string[];
  assumptions: string[];
  openQuestions: string[];
  successCriteria: string[];
}

interface PreviousSessionModel {
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
}

interface DesignState {
  active: boolean;
  phase: DesignPhase;
  topic: string;
  profileName: string;
  profile: NormalizedProfile | null;
  brief: DesignBrief;
  missingInfo: string[];
  summary?: string;
  lastCheckpointAction?: "ask_user" | "request_phase_approval" | "start_debate" | "hold";
  previousSessionModel?: PreviousSessionModel;
}

interface DebateResult {
  output: string;
  stderr: string;
  exitCode: number;
}

const STATE_ENTRY = "design-studio-state";
const RESULT_MESSAGE_TYPE = "design-studio-result";
const DEFAULT_BRIEF: DesignBrief = {
  goals: [],
  nonGoals: [],
  users: [],
  requirements: [],
  featureSet: [],
  constraints: [],
  integrations: [],
  risks: [],
  assumptions: [],
  openQuestions: [],
  successCriteria: [],
};

const FACILITATOR_PROMPT = `You are the design facilitator for an active /design workflow.

Responsibilities:
- Help the user define a software feature/component at a high level.
- Focus on goals, non-goals, feature set, architecture boundaries, constraints, risks, integrations, and success criteria.
- Ask focused questions. Prefer one cluster of related questions at a time.
- Do NOT write the final design doc during intake.
- Do NOT create an execution plan.
- Maintain structured state by calling the design_checkpoint tool exactly once in every reply.

Use design_checkpoint like this:
- nextAction="ask_user" when you still need more information.
- nextAction="request_phase_approval" when you think the brief is sufficient and want the user to confirm moving to debate.
- nextAction="start_debate" only after the user has clearly approved proceeding.
- nextAction="hold" when summarizing or acknowledging without changing phase.

When you request approval, explicitly summarize remaining assumptions and ask the user whether to proceed to the debate phase.
When the user approves, acknowledge briefly and call design_checkpoint with nextAction="start_debate". The extension will run the debate for you. Do not simulate the debate yourself.`;

const ARCHITECT_A_PROMPT = `You are Architect A in a design debate.

Your job:
- Produce the strongest practical high-level design doc you can from the supplied brief.
- Optimize for clarity, explicit trade-offs, and implementation realism.
- Cover component boundaries, data flow, APIs/interfaces, operational concerns, failure modes, and alternatives considered.
- Do not produce an execution plan.
- Output clean markdown only.

Required sections:
1. Title
2. Problem Statement
3. Goals
4. Non-Goals
5. Proposed Architecture
6. Component Responsibilities
7. Interfaces / APIs
8. Data Flow
9. Feature Set
10. Operational Considerations
11. Risks and Trade-Offs
12. Alternatives Considered
13. Open Questions`;

const ARCHITECT_B_PROMPT = `You are Architect B in a design debate.

Your job:
- Review the proposed design skeptically.
- Find unclear boundaries, hidden assumptions, missing failure handling, weak trade-off analysis, scaling risks, security/privacy gaps, and overlooked alternatives.
- Be firm but constructive.
- If the draft is good enough, accept it.

Output format:
## Verdict: ACCEPT|REJECT

## Summary
Short explanation of your verdict.

## Critical Objections
- Bullet list. If none, say "- None".

## Suggested Revisions
- Bullet list. If none, say "- None".

Only output markdown.`;

function cloneBrief(brief: DesignBrief): DesignBrief {
  return {
    problem: brief.problem,
    goals: [...brief.goals],
    nonGoals: [...brief.nonGoals],
    users: [...brief.users],
    requirements: [...brief.requirements],
    featureSet: [...brief.featureSet],
    constraints: [...brief.constraints],
    integrations: [...brief.integrations],
    risks: [...brief.risks],
    assumptions: [...brief.assumptions],
    openQuestions: [...brief.openQuestions],
    successCriteria: [...brief.successCriteria],
  };
}

function defaultState(): DesignState {
  return {
    active: false,
    phase: "idle",
    topic: "",
    profileName: "",
    profile: null,
    brief: cloneBrief(DEFAULT_BRIEF),
    missingInfo: [],
  };
}

function mergeUnique(current: string[], incoming?: string[]): string[] {
  if (!incoming || incoming.length === 0) return current;
  const seen = new Set(current.map((item) => item.trim()).filter(Boolean));
  const merged = [...current];
  for (const item of incoming) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}

function mergeBrief(current: DesignBrief, incoming: Partial<DesignBrief>): DesignBrief {
  return {
    problem: incoming.problem?.trim() || current.problem,
    goals: mergeUnique(current.goals, incoming.goals),
    nonGoals: mergeUnique(current.nonGoals, incoming.nonGoals),
    users: mergeUnique(current.users, incoming.users),
    requirements: mergeUnique(current.requirements, incoming.requirements),
    featureSet: mergeUnique(current.featureSet, incoming.featureSet),
    constraints: mergeUnique(current.constraints, incoming.constraints),
    integrations: mergeUnique(current.integrations, incoming.integrations),
    risks: mergeUnique(current.risks, incoming.risks),
    assumptions: mergeUnique(current.assumptions, incoming.assumptions),
    openQuestions: mergeUnique(current.openQuestions, incoming.openQuestions),
    successCriteria: mergeUnique(current.successCriteria, incoming.successCriteria),
  };
}

function formatBriefMarkdown(topic: string, brief: DesignBrief, summary?: string, missingInfo: string[] = []): string {
  const bulletSection = (title: string, items: string[]) => {
    if (items.length === 0) return `## ${title}\n- None`;
    return `## ${title}\n${items.map((item) => `- ${item}`).join("\n")}`;
  };

  const sections = [
    `# Design Brief: ${topic}`,
    summary?.trim() ? `## Working Summary\n${summary.trim()}` : undefined,
    brief.problem ? `## Problem\n${brief.problem}` : "## Problem\n- Not yet captured",
    bulletSection("Goals", brief.goals),
    bulletSection("Non-Goals", brief.nonGoals),
    bulletSection("Users", brief.users),
    bulletSection("Requirements", brief.requirements),
    bulletSection("Feature Set", brief.featureSet),
    bulletSection("Constraints", brief.constraints),
    bulletSection("Integrations", brief.integrations),
    bulletSection("Risks", brief.risks),
    bulletSection("Assumptions", brief.assumptions),
    bulletSection("Open Questions", brief.openQuestions),
    bulletSection("Success Criteria", brief.successCriteria),
    missingInfo.length > 0 ? bulletSection("Remaining Gaps", missingInfo) : undefined,
  ].filter(Boolean);

  return sections.join("\n\n");
}

function formatProfileWidget(state: DesignState): string[] | undefined {
  if (!state.active || !state.profile) return undefined;
  const lines = [
    `Design: ${state.topic}`,
    `Phase: ${state.phase.replace(/_/g, " ")}`,
    `Profile: ${state.profileName}`,
    `A: ${formatModelRef(state.profile.architectA)}`,
    `B: ${formatModelRef(state.profile.architectB)}`,
  ];
  if (state.missingInfo.length > 0) lines.push(`Missing: ${state.missingInfo.join("; ")}`);
  return lines;
}

function sanitizeStateForPersistence(state: DesignState) {
  return {
    active: state.active,
    phase: state.phase,
    topic: state.topic,
    profileName: state.profileName,
    profile: state.profile,
    brief: state.brief,
    missingInfo: state.missingInfo,
    summary: state.summary,
    lastCheckpointAction: state.lastCheckpointAction,
    previousSessionModel: state.previousSessionModel,
  };
}

function describeRole(role: NormalizedModelRef): string {
  return `${role.provider}/${role.model}${role.thinkingLevel ? ` (${role.thinkingLevel})` : ""}`;
}

function buildFallbackProfile(ctx: ExtensionContext): { name: string; profile: NormalizedProfile } | null {
  if (!ctx.model) return null;
  const thinkingLevel = ((ctx as { model?: { reasoning?: boolean } }).model?.reasoning ? "medium" : "off") as ThinkingLevel;
  const current = {
    provider: ctx.model.provider,
    model: ctx.model.id,
    thinkingLevel,
  };
  return {
    name: "session-default",
    profile: {
      facilitator: current,
      architectA: current,
      architectB: current,
      maxRounds: 2,
      saveDir: "docs/designs",
    },
  };
}

async function applyRole(pi: ExtensionAPI, ctx: ExtensionContext, role: NormalizedModelRef): Promise<void> {
  const model = ctx.modelRegistry.find(role.provider, role.model);
  if (!model) throw new Error(`Configured model not found: ${formatModelRef(role)}`);
  const success = await pi.setModel(model);
  if (!success) throw new Error(`No API key available for ${formatModelRef(role)}`);
  if (role.thinkingLevel) pi.setThinkingLevel(role.thinkingLevel);
}

function savePathForTopic(cwd: string, profile: NormalizedProfile, topic: string): string {
  return nextAvailableSavePath(path.resolve(cwd, profile.saveDir), topic);
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function writePromptToTempFile(roleName: string, prompt: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-design-studio-"));
  const filePath = path.join(dir, `${roleName.replace(/[^a-z0-9-]+/gi, "_")}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

async function runPiSubprocess(params: {
  roleName: string;
  model: NormalizedModelRef;
  systemPrompt: string;
  task: string;
  cwd: string;
  onChunk?: (text: string) => void;
}): Promise<DebateResult> {
  const promptFile = writePromptToTempFile(params.roleName, params.systemPrompt);
  const modelArg = formatModelRef(params.model);
  const args = [
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--model",
    modelArg,
    "--append-system-prompt",
    promptFile.filePath,
    params.task,
  ];

  return await new Promise<DebateResult>((resolve) => {
    const proc = spawn("pi", args, {
      cwd: params.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let stderr = "";
    let finalOutput = "";

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "message_end" && event.message?.role === "assistant") {
        const text = extractAssistantText(event.message);
        if (text) {
          finalOutput = text;
          params.onChunk?.(text);
        }
      }
    };

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      try {
        fs.unlinkSync(promptFile.filePath);
      } catch {
        // Ignore cleanup errors.
      }
      try {
        fs.rmdirSync(promptFile.dir);
      } catch {
        // Ignore cleanup errors.
      }
      resolve({ output: finalOutput, stderr, exitCode: code ?? 1 });
    });

    proc.on("error", (error) => {
      resolve({ output: finalOutput, stderr: `${stderr}\n${String(error)}`.trim(), exitCode: 1 });
    });
  });
}

function assertDebateResult(result: DebateResult, roleName: string): string {
  if (result.exitCode !== 0) {
    throw new Error(`${roleName} failed with exit code ${result.exitCode}${result.stderr ? `: ${result.stderr.trim()}` : ""}`);
  }
  if (!result.output.trim()) {
    throw new Error(`${roleName} produced no output`);
  }
  return result.output.trim();
}

function chooseProfile(config: NormalizedConfig, ctx: ExtensionContext): { name: string; profile: NormalizedProfile; fromFallback: boolean } {
  if (Object.keys(config.profiles).length > 0) {
    const name = config.defaultProfile ?? Object.keys(config.profiles)[0]!;
    return { name, profile: config.profiles[name]!, fromFallback: false };
  }
  const fallback = buildFallbackProfile(ctx);
  if (!fallback) {
    throw new Error(
      "No design-studio profile configured and no current session model available. Add ~/.pi/agent/design-studio.json or .pi/design-studio.json.",
    );
  }
  return { ...fallback, fromFallback: true };
}

function validateRole(ctx: ExtensionContext, role: NormalizedModelRef, label: string): void {
  if (!ctx.modelRegistry.find(role.provider, role.model)) {
    throw new Error(`${label} model is unavailable: ${formatModelRef(role)}`);
  }
}

export default function designStudioExtension(pi: ExtensionAPI) {
  let state: DesignState = defaultState();
  let config: NormalizedConfig = { defaultProfile: undefined, profiles: {}, saveDir: "docs/designs" };
  let debatePromise: Promise<void> | null = null;

  function persistState() {
    pi.appendEntry(STATE_ENTRY, sanitizeStateForPersistence(state));
  }

  function updateUi(ctx: ExtensionContext) {
    if (!state.active) {
      ctx.ui.setStatus("design-studio", undefined);
      ctx.ui.setWidget("design-studio", undefined);
      return;
    }

    const label =
      state.phase === "debating"
        ? ctx.ui.theme.fg("warning", `design: debating`)
        : ctx.ui.theme.fg("accent", `design: ${state.phase.replace(/_/g, " ")}`);
    ctx.ui.setStatus("design-studio", label);
    ctx.ui.setWidget("design-studio", formatProfileWidget(state));
  }

  async function restorePreviousModelIfNeeded(ctx: ExtensionContext) {
    if (!state.previousSessionModel) return;
    try {
      await applyRole(pi, ctx, state.previousSessionModel);
    } catch (error) {
      ctx.ui.notify(
        `Could not restore previous model: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    state.previousSessionModel = undefined;
  }

  function resetState(ctx: ExtensionContext) {
    state = defaultState();
    persistState();
    updateUi(ctx);
  }

  async function promptToSaveDesign(ctx: ExtensionContext, document: string) {
    if (!state.profile) return;
    const targetPath = savePathForTopic(ctx.cwd, state.profile, state.topic);
    const relativePath = path.relative(ctx.cwd, targetPath) || path.basename(targetPath);
    const shouldSave = await ctx.ui.confirm("Save design?", `Save final design to ${relativePath}?`);
    if (!shouldSave) return;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, document, "utf-8");
    ctx.ui.notify(`Saved design to ${relativePath}`, "info");
  }

  async function runDebate(ctx: ExtensionContext) {
    if (!state.active || state.phase !== "debating" || !state.profile) return;

    const topic = state.topic;
    const briefMarkdown = formatBriefMarkdown(topic, state.brief, state.summary, state.missingInfo);
    const architectAName = describeRole(state.profile.architectA);
    const architectBName = describeRole(state.profile.architectB);

    ctx.ui.notify(`Starting design debate for ${topic}`, "info");
    updateUi(ctx);

    let draft = "";
    let critique = "";
    let accepted = false;
    let acceptedRound = state.profile.maxRounds;

    for (let round = 1; round <= state.profile.maxRounds; round++) {
      ctx.ui.setStatus("design-studio", ctx.ui.theme.fg("warning", `design: A drafting (${round}/${state.profile.maxRounds})`));
      const draftTask =
        round === 1
          ? `Create the initial design document for the following brief.\n\n${briefMarkdown}`
          : `Revise your design using the brief and critique below. Keep the markdown design doc complete and self-contained.\n\n${briefMarkdown}\n\n## Latest Critique\n\n${critique}`;
      const draftResult = await runPiSubprocess({
        roleName: `architect-a-round-${round}`,
        model: state.profile.architectA,
        systemPrompt: ARCHITECT_A_PROMPT,
        task: draftTask,
        cwd: ctx.cwd,
      });
      draft = assertDebateResult(draftResult, `Architect A round ${round}`);

      ctx.ui.setStatus("design-studio", ctx.ui.theme.fg("warning", `design: B reviewing (${round}/${state.profile.maxRounds})`));
      const critiqueTask = `Review the proposed design against this brief.\n\n${briefMarkdown}\n\n## Proposed Design\n\n${draft}`;
      const critiqueResult = await runPiSubprocess({
        roleName: `architect-b-round-${round}`,
        model: state.profile.architectB,
        systemPrompt: ARCHITECT_B_PROMPT,
        task: critiqueTask,
        cwd: ctx.cwd,
      });
      critique = assertDebateResult(critiqueResult, `Architect B round ${round}`);

      const parsed = parseCritique(critique);
      if (parsed.verdict === "ACCEPT") {
        accepted = true;
        acceptedRound = round;
        break;
      }
    }

    const finalDocument = composeFinalDesignDocument({
      topic,
      briefMarkdown,
      finalDraft: draft,
      accepted,
      round: acceptedRound,
      maxRounds: state.profile.maxRounds,
      lastCritique: critique,
      architectA: architectAName,
      architectB: architectBName,
    });

    pi.sendMessage(
      {
        customType: RESULT_MESSAGE_TYPE,
        content: finalDocument,
        display: true,
      },
      { triggerTurn: false },
    );

    await promptToSaveDesign(ctx, finalDocument);
    await restorePreviousModelIfNeeded(ctx);
    resetState(ctx);
  }

  async function startDesign(topic: string, ctx: ExtensionCommandContext) {
    const cleanTopic = topic.trim();
    if (!cleanTopic) {
      ctx.ui.notify("Usage: /design <topic>", "warning");
      return;
    }

    if (state.active) {
      const ok = await ctx.ui.confirm(
        "Replace active design?",
        `Abandon the current design workflow for ${state.topic} and start a new one?`,
      );
      if (!ok) return;
      await restorePreviousModelIfNeeded(ctx);
      resetState(ctx);
    }

    config = loadDesignStudioConfig(ctx.cwd);
    const chosen = chooseProfile(config, ctx);
    validateRole(ctx, chosen.profile.architectA, "Architect A");
    validateRole(ctx, chosen.profile.architectB, "Architect B");
    validateRole(ctx, chosen.profile.facilitator, "Facilitator");

    const previousSessionModel = ctx.model
      ? {
        provider: ctx.model.provider,
        model: ctx.model.id,
        thinkingLevel: (THINKING_LEVELS.includes(pi.getThinkingLevel() as ThinkingLevel)
          ? pi.getThinkingLevel()
          : "off") as ThinkingLevel,
      }
      : undefined;

    await applyRole(pi, ctx, chosen.profile.facilitator);

    state = {
      active: true,
      phase: "intake",
      topic: cleanTopic,
      profileName: chosen.name,
      profile: chosen.profile,
      brief: cloneBrief(DEFAULT_BRIEF),
      missingInfo: [],
      lastCheckpointAction: "ask_user",
      previousSessionModel,
    };
    pi.setSessionName(`Design: ${cleanTopic}`);
    updateUi(ctx);
    persistState();

    if (chosen.fromFallback) {
      ctx.ui.notify(
        "No design-studio profile found. Falling back to the current session model for facilitator and both debaters.",
        "warning",
      );
    }

    ctx.ui.notify(`Design workflow started for ${cleanTopic}`, "info");
    pi.sendUserMessage(
      `Begin a design discovery workflow for: ${cleanTopic}. Gather enough information to produce a high-level design document and feature set. Ask focused questions, keep a structured brief with the design_checkpoint tool, and ask for approval before moving to debate.`,
    );
  }

  pi.registerMessageRenderer(RESULT_MESSAGE_TYPE, (message) => {
    return new Markdown(message.content, 0, 0, getMarkdownTheme());
  });

  pi.registerCommand("design", {
    description: "Start an autonomous design workflow for a feature or component",
    handler: async (args, ctx) => {
      try {
        await startDesign(args, ctx);
      } catch (error) {
        await restorePreviousModelIfNeeded(ctx);
        resetState(ctx);
        ctx.ui.notify(
          `Could not start design workflow: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });

  pi.registerCommand("design-cancel", {
    description: "Cancel the active design workflow and close the design panel",
    handler: async (_args, ctx) => {
      if (!state.active) {
        updateUi(ctx);
        ctx.ui.notify("No active design workflow.", "info");
        return;
      }
      await restorePreviousModelIfNeeded(ctx);
      resetState(ctx);
      ctx.ui.notify("Design workflow canceled.", "info");
    },
  });

  const DesignCheckpointBriefSchema = Type.Object({
    problem: Type.Optional(Type.String()),
    goals: Type.Optional(Type.Array(Type.String())),
    nonGoals: Type.Optional(Type.Array(Type.String())),
    users: Type.Optional(Type.Array(Type.String())),
    requirements: Type.Optional(Type.Array(Type.String())),
    featureSet: Type.Optional(Type.Array(Type.String())),
    constraints: Type.Optional(Type.Array(Type.String())),
    integrations: Type.Optional(Type.Array(Type.String())),
    risks: Type.Optional(Type.Array(Type.String())),
    assumptions: Type.Optional(Type.Array(Type.String())),
    openQuestions: Type.Optional(Type.Array(Type.String())),
    successCriteria: Type.Optional(Type.Array(Type.String())),
  });

  pi.registerTool({
    name: "design_checkpoint",
    label: "Design Checkpoint",
    description: "Persist structured design-intake state and request phase transitions for an active /design workflow.",
    promptSnippet: "Persist the current /design intake summary and phase transition state.",
    promptGuidelines: [
      "When a /design workflow is active, call design_checkpoint exactly once in every reply.",
    ],
    parameters: Type.Object({
      sufficientInfo: Type.Boolean({ description: "Whether the current brief is sufficient to enter debate." }),
      nextAction: StringEnum(["ask_user", "request_phase_approval", "start_debate", "hold"] as const),
      summary: Type.Optional(Type.String({ description: "Short working summary of the current design brief." })),
      missingInfo: Type.Optional(Type.Array(Type.String(), { description: "Remaining gaps or questions." })),
      brief: Type.Optional(DesignCheckpointBriefSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.active) {
        return {
          content: [{ type: "text", text: "No active /design workflow." }],
          details: {},
        };
      }

      state.brief = mergeBrief(state.brief, params.brief ?? {});
      state.summary = params.summary?.trim() || state.summary;
      state.missingInfo = params.missingInfo?.map((item) => item.trim()).filter(Boolean) ?? state.missingInfo;
      state.lastCheckpointAction = params.nextAction;

      if (params.nextAction === "request_phase_approval") {
        state.phase = "awaiting_approval";
      } else if (params.nextAction === "start_debate") {
        state.phase = "debating";
      } else if (state.phase !== "debating") {
        state.phase = "intake";
      }

      persistState();
      updateUi(ctx);
      return {
        content: [
          {
            type: "text",
            text: `Checkpoint recorded. Phase: ${state.phase}. Next action: ${params.nextAction}.`,
          },
        ],
        details: { phase: state.phase, sufficientInfo: params.sufficientInfo },
      };
    },
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("design_checkpoint "));
      text += theme.fg("accent", args.nextAction);
      if (Array.isArray(args.missingInfo) && args.missingInfo.length > 0) {
        text += theme.fg("dim", ` (${args.missingInfo.length} gaps)`);
      }
      return new Text(text, 0, 0);
    },
  });

  pi.on("input", async (_event, ctx) => {
    if (state.active && state.phase === "debating") {
      ctx.ui.notify("Design debate is running. Please wait for it to finish.", "info");
      return { action: "handled" as const };
    }
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.active || state.phase === "debating" || !state.profile) return;
    const briefMarkdown = formatBriefMarkdown(state.topic, state.brief, state.summary, state.missingInfo);
    const facilitatorLine = `Facilitator model: ${describeRole(state.profile.facilitator)}`;
    const phaseLine = `Current phase: ${state.phase}`;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${FACILITATOR_PROMPT}\n\n${facilitatorLine}\n${phaseLine}\n\nCurrent structured brief:\n\n${briefMarkdown}`,
    };
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!state.active || state.phase !== "debating") return;
    if (debatePromise) return;
    debatePromise = runDebate(ctx)
      .catch((error) => {
        state.phase = "awaiting_approval";
        persistState();
        updateUi(ctx);
        ctx.ui.notify(
          `Design debate failed: ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      })
      .finally(() => {
        debatePromise = null;
      });
    await debatePromise;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      config = loadDesignStudioConfig(ctx.cwd);
    } catch (error) {
      config = { defaultProfile: undefined, profiles: {}, saveDir: "docs/designs" };
      ctx.ui.notify(
        `design-studio config error: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
    const entries = ctx.sessionManager.getEntries();
    const saved = entries
      .filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_ENTRY)
      .pop() as { data?: Partial<DesignState> } | undefined;
    if (saved?.data) {
      state = {
        ...defaultState(),
        ...saved.data,
        brief: mergeBrief(cloneBrief(DEFAULT_BRIEF), saved.data.brief ?? {}),
        missingInfo: saved.data.missingInfo ?? [],
      };
      if (state.phase === "debating") {
        state.phase = "awaiting_approval";
        ctx.ui.notify("An earlier design debate was interrupted. Reply to continue when ready.", "warning");
      }
    }
    updateUi(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state.active) persistState();
    updateUi(ctx);
  });
}
