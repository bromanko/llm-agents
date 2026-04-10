/**
 * /git-commit — AI-assisted Git commit workflow with optional hunk-level splits.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadGitCommitConfig,
  type NormalizedGitCommitConfig,
} from "../lib/commit/config.ts";
import { isGitRepo } from "../lib/utils.ts";
import { ControlledGit } from "../lib/commit/git.ts";
import { runCommitPipeline } from "../lib/commit/pipeline.ts";
import type { PipelineContext } from "../lib/commit/pipeline.ts";
import type { CommitCommandArgs } from "../lib/commit/types.ts";
import type { ModelCandidate } from "../lib/commit/model-resolver.ts";
import type { InferenceContext } from "../lib/commit/inference.ts";
import {
  buildCommitPrompt,
  parseModelResponse,
  runModelInference as runModelInferenceBase,
  runModelInferenceDetailed as runModelInferenceDetailedBase,
} from "../lib/commit/inference.ts";
import { hasModelAuth } from "../../lib/commit/inference-common.ts";

export {
  buildCommitPrompt,
  parseModelResponse,
  setCompleteFn,
  setCompleteFnImporter,
} from "../lib/commit/inference.ts";

export type {
  CompleteFn,
  CompleteFnImporter,
  CompletionBlock,
  CompleteInput,
  CompleteOptions,
  ModelInferenceResult,
} from "../lib/commit/inference.ts";

interface GitCommitCommandDeps {
  isGitRepo: (cwd: string) => boolean;
  loadGitCommitConfig: typeof loadGitCommitConfig;
  ControlledGit: new (cwd: string) => ControlledGit;
  runCommitPipeline: typeof runCommitPipeline;
}

const defaultDeps: GitCommitCommandDeps = {
  isGitRepo,
  loadGitCommitConfig,
  ControlledGit,
  runCommitPipeline,
};

function modelKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

function withWrappedLogger(ctx: InferenceContext): InferenceContext {
  const logger = ctx?.logger;
  if (!logger?.debug) return ctx;

  return {
    ...ctx,
    logger: {
      ...logger,
      debug: (message: string, meta?: unknown) => {
        if (
          message === "runModelInference failed"
          && meta
          && typeof meta === "object"
          && "error" in meta
          && !("err" in meta)
        ) {
          const debugMeta = meta as Record<string, unknown>;
          logger.debug?.(message, {
            ...debugMeta,
            err: new Error(String(debugMeta.error)),
          });
          return;
        }
        logger.debug?.(message, meta);
      },
    },
  };
}

export async function runModelInference(
  ctx: InferenceContext,
  model: ModelCandidate,
  prompt: string,
): Promise<string | null> {
  return runModelInferenceBase(withWrappedLogger(ctx), model, prompt);
}

export async function runModelInferenceDetailed(
  ctx: InferenceContext,
  model: ModelCandidate,
  prompt: string,
) {
  return runModelInferenceDetailedBase(withWrappedLogger(ctx), model, prompt);
}

export function registerGitCommitCommand(
  pi: ExtensionAPI,
  deps: GitCommitCommandDeps = defaultDeps,
): void {
  pi.registerCommand("git-commit", {
    description: "Analyze Git changes and create clean commits with optional hunk-level splits",
    handler: createGitCommitHandler(pi, deps),
  });
}

export function createGitCommitHandler(
  _pi: ExtensionAPI,
  deps: GitCommitCommandDeps = defaultDeps,
) {
  return async (argsStr: string | undefined, ctx: any) => {
    if (!deps.isGitRepo(ctx.cwd)) {
      ctx.ui.notify("Not a Git repository.", "error");
      return;
    }

    const args = parseArgs(argsStr ?? "");

    let gitCommitConfig: NormalizedGitCommitConfig;
    try {
      gitCommitConfig = deps.loadGitCommitConfig(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Invalid git-commit config: ${message}`, "error");
      return;
    }

    const git = new deps.ControlledGit(ctx.cwd);

    let autoStaged = false;
    if (!(await git.hasStagedChanges())) {
      ctx.ui.notify("No staged changes detected; staging all changes for analysis.", "info");
      await git.stageAll();
      autoStaged = true;
    }

    const snapshot = await git.getStagedSnapshot();
    if (snapshot.files.length === 0) {
      if (autoStaged) {
        await git.resetStaging();
      }
      ctx.ui.notify("Nothing to commit.", "info");
      return;
    }

    const availableModels: ModelCandidate[] = [];
    const registryModelByKey = new Map<string, any>();
    let sessionModel: ModelCandidate | undefined;

    if (ctx.modelRegistry) {
      const models = ctx.modelRegistry.getAll();
      for (const model of models) {
        availableModels.push({
          provider: model.provider,
          id: model.id,
          name: model.name,
        });
        registryModelByKey.set(modelKey(model.provider, model.id), model);
      }
    }

    if (ctx.model) {
      sessionModel = {
        provider: ctx.model.provider,
        id: ctx.model.id,
        name: ctx.model.name,
      };
    }

    const apiKeyPresenceCache = new Map<string, Promise<boolean>>();
    const hasApiKey = async (model: ModelCandidate): Promise<boolean> => {
      if (!ctx.modelRegistry) return false;

      const key = modelKey(model.provider, model.id);
      const cached = apiKeyPresenceCache.get(key);
      if (cached) return cached;

      const checkPromise = (async () => {
        if (
          sessionModel
          && model.provider === sessionModel.provider
          && model.id === sessionModel.id
        ) {
          return true;
        }

        const found = registryModelByKey.get(key) ?? ctx.modelRegistry.find(model.provider, model.id);
        if (!found) return false;
        try {
          return await hasModelAuth(ctx.modelRegistry, found);
        } catch {
          return false;
        }
      })();

      apiKeyPresenceCache.set(key, checkPromise);
      return checkPromise;
    };

    const onProgress = (message: string) => {
      ctx.ui.notify(message, "info");
    };

    const pipelineCtx: PipelineContext = {
      git,
      cwd: ctx.cwd,
      args,
      snapshot,
      availableModels,
      configuredModel: gitCommitConfig.model
        ? {
          provider: gitCommitConfig.model.provider,
          id: gitCommitConfig.model.id,
          name: `${gitCommitConfig.model.provider}/${gitCommitConfig.model.id}`,
        }
        : undefined,
      sessionModel,
      hasApiKey,
      onProgress,
      runAgenticSession: createAgenticSession(ctx),
    };

    const result = await deps.runCommitPipeline(pipelineCtx);

    if (autoStaged && !result.committed) {
      await git.resetStaging();
    }

    for (const warning of result.warnings) {
      ctx.ui.notify(`⚠ ${warning}`, "warning");
    }

    const summaryLevel = result.committed || result.summary === "Nothing to commit." ? "info" : "error";
    ctx.ui.notify(result.summary, summaryLevel);

    for (const message of result.messages) {
      ctx.ui.notify(message, "info");
    }

    if (args.push && result.committed) {
      try {
        await git.push();
        ctx.ui.notify("Pushed to remote.", "info");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Push failed: ${message}`, "error");
      }
    }
  };
}

export default function(pi: ExtensionAPI) {
  registerGitCommitCommand(pi);
}

interface ParsedToken {
  value: string;
  start: number;
}

function tokenizeArgs(argsStr: string): ParsedToken[] {
  const tokens: ParsedToken[] = [];
  const re = /\S+/g;
  let match: RegExpExecArray | null = re.exec(argsStr);
  while (match) {
    tokens.push({ value: match[0], start: match.index });
    match = re.exec(argsStr);
  }
  return tokens;
}

export function parseArgs(argsStr: string): CommitCommandArgs {
  const tokens = tokenizeArgs(argsStr);
  const result: CommitCommandArgs = {
    dryRun: false,
    push: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].value;
    switch (token) {
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--push":
        result.push = true;
        break;
      case "--context": {
        const nextToken = tokens[i + 1];
        if (nextToken) {
          result.context = argsStr.slice(nextToken.start);
        }
        i = tokens.length;
        break;
      }
    }
  }

  return result;
}

function createAgenticSession(
  ctx: InferenceContext,
): PipelineContext["runAgenticSession"] {
  return async (input) => {
    const prompt = buildCommitPrompt({
      snapshot: input.snapshot,
      userContext: input.userContext,
    });

    try {
      const inference = await runModelInferenceDetailed(ctx, input.model, prompt);
      if (inference.text) {
        const parsed = parseModelResponse(inference.text);
        if (!parsed.proposal && !parsed.splitPlan) {
          const debugPath = writeDebugFile(input.model, {
            kind: "unparseable-response",
            prompt,
            rawResponse: inference.rawResponse,
            textResponse: inference.text,
          });
          if (debugPath) {
            ctx.logger?.debug?.(
              `Model response could not be parsed into a commit plan. Raw response saved to: ${debugPath}`,
            );
            return { debugPath };
          }
        }
        return parsed;
      }

      const debugPath = writeDebugFile(input.model, {
        kind: "empty-or-error-response",
        prompt,
        rawResponse: inference.rawResponse,
        error: inference.error,
      });
      if (debugPath) {
        ctx.logger?.debug?.(
          `Model inference did not yield usable text. Debug output saved to: ${debugPath}`,
        );
        return { debugPath };
      }
    } catch (error) {
      const debugPath = writeDebugFile(input.model, {
        kind: "agentic-session-exception",
        prompt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (debugPath) {
        return { debugPath };
      }
    }

    return {};
  };
}

function writeDebugFile(
  model: ModelCandidate,
  payload: {
    kind: string;
    prompt: string;
    rawResponse?: unknown;
    textResponse?: string;
    error?: string;
  },
): string | undefined {
  try {
    const debugDir = join(tmpdir(), "pi-git-commit-debug");
    mkdirSync(debugDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const debugPath = join(debugDir, `failed-response-${timestamp}.txt`);
    const rawResponseText = serializeDebugValue(payload.rawResponse);
    writeFileSync(
      debugPath,
      [
        `Model: ${model.provider}::${model.id}`,
        `Kind: ${payload.kind}`,
        payload.error ? `Error: ${payload.error}` : undefined,
        "",
        "--- Prompt ---",
        payload.prompt,
        payload.textResponse ? "\n--- Text Response ---\n" + payload.textResponse : undefined,
        rawResponseText ? "\n--- Raw Response Object ---\n" + rawResponseText : undefined,
      ].filter((part): part is string => typeof part === "string").join("\n"),
    );
    return debugPath;
  } catch {
    return undefined;
  }
}

function serializeDebugValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    try {
      return String(value);
    } catch {
      return undefined;
    }
  }
}
