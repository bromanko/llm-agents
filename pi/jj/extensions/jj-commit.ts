/**
 * /jj-commit — agentic commit workflow for jujutsu repositories.
 *
 * Analyzes working-copy changes, generates conventional commit messages using
 * a model (preferred: Sonnet 4.6, fallback: session model),
 * optionally splits unrelated changes into multiple commits, updates existing
 * changelogs, and can push via bookmark.
 *
 * Flags:
 *   --dry-run       Preview commit plan without mutating
 *   --push          Push after committing (defaults bookmark to "main")
 *   --bookmark <n>  Bookmark name for push
 *   --no-changelog  Skip changelog detection/updates
 *   --no-absorb     Skip jj absorb pre-pass
 *   --context <t>   Additional context for the model
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { isJjRepo } from "../lib/utils.ts";
import { ControlledJj } from "../lib/commit/jj.ts";
import { runCommitPipeline, pushWithBookmark } from "../lib/commit/pipeline.ts";
import type { PipelineContext } from "../lib/commit/pipeline.ts";
import type { CommitCommandArgs } from "../lib/commit/types.ts";
import type { ModelCandidate } from "../lib/commit/model-resolver.ts";
import type { InferenceContext } from "../lib/commit/inference.ts";
import {
  buildCommitPrompt,
  parseModelResponse,
  runModelInference,
} from "../lib/commit/inference.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Re-export inference API for tests and external consumers
export {
  buildCommitPrompt,
  parseModelResponse,
  runModelInference,
  setCompleteFn,
  setCompleteFnImporter,
} from "../lib/commit/inference.ts";
export type {
  CompleteFn,
  CompleteFnImporter,
  CompletionBlock,
  CompleteInput,
  CompleteOptions,
} from "../lib/commit/inference.ts";

interface JjCommitCommandDeps {
  isJjRepo: (cwd: string) => boolean;
  ControlledJj: new (cwd: string) => ControlledJj;
  runCommitPipeline: typeof runCommitPipeline;
  pushWithBookmark: typeof pushWithBookmark;
}

const defaultDeps: JjCommitCommandDeps = {
  isJjRepo,
  ControlledJj,
  runCommitPipeline,
  pushWithBookmark,
};

function modelKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

export function registerJjCommitCommand(
  pi: ExtensionAPI,
  deps: JjCommitCommandDeps = defaultDeps,
): void {
  pi.registerCommand("jj-commit", {
    description:
      "Analyze jj working copy and create well-structured commits with AI-generated messages",
    handler: createJjCommitHandler(pi, deps),
  });
}

export function createJjCommitHandler(
  pi: ExtensionAPI,
  deps: JjCommitCommandDeps = defaultDeps,
) {
  return async (argsStr: string | undefined, ctx: any) => {
    if (!deps.isJjRepo(ctx.cwd)) {
      ctx.ui.notify("Not a jujutsu repository.", "error");
      return;
    }

    // Parse command arguments
    const args = parseArgs(argsStr ?? "");

    const jj = new deps.ControlledJj(ctx.cwd);

    // Build model candidates from the pi model registry
    const availableModels: ModelCandidate[] = [];
    const registryModelByKey = new Map<string, any>();
    let sessionModel: ModelCandidate | undefined;

    if (ctx.modelRegistry) {
      // Use getAll() rather than getAvailable() to include models
      // authenticated via OAuth (e.g. pi-sub-bar).  getAvailable() is a
      // fast check that skips OAuth token refresh and may omit valid models.
      // The hasApiKey callback below performs the full auth check per candidate.
      const models = ctx.modelRegistry.getAll();
      for (const m of models) {
        availableModels.push({
          provider: m.provider,
          id: m.id,
          name: m.name,
        });
        registryModelByKey.set(modelKey(m.provider, m.id), m);
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
        // If this is the active session model it is provably authenticated
        // (the user is already talking through it), so skip the API key check.
        // This handles OAuth-based auth (e.g. pi-sub-bar) where getApiKey()
        // returns empty even for working models.
        if (
          sessionModel &&
          model.provider === sessionModel.provider &&
          model.id === sessionModel.id
        ) {
          return true;
        }

        // Try the fast-path map first (built from getAll), then fall back to
        // a full registry lookup.
        const found =
          registryModelByKey.get(key) ??
          ctx.modelRegistry.find(model.provider, model.id);
        if (!found) return false;
        try {
          const apiKey = await ctx.modelRegistry.getApiKey(found);
          return apiKey !== undefined && apiKey !== null && apiKey !== "";
        } catch {
          return false;
        }
      })();

      apiKeyPresenceCache.set(key, checkPromise);
      return checkPromise;
    };

    // Progress callback
    const onProgress = (message: string) => {
      ctx.ui.notify(message, "info");
    };

    // Build pipeline context
    const pipelineCtx: PipelineContext = {
      jj,
      cwd: ctx.cwd,
      args,
      availableModels,
      sessionModel,
      hasApiKey,
      onProgress,
      runAgenticSession: createAgenticSession(ctx),
    };

    // Run the pipeline
    const result = await deps.runCommitPipeline(pipelineCtx);

    // Show warnings
    for (const warning of result.warnings) {
      ctx.ui.notify(`⚠ ${warning}`, "warning");
    }

    // Recovery guidance is useful for real failures, but noisy for no-op outcomes.
    const shouldShowRecoveryGuidance =
      !result.committed
      && !args.dryRun
      && result.summary !== "Nothing to commit."
      && result.summary !== "All changes were absorbed into ancestor commits.";

    if (shouldShowRecoveryGuidance) {
      ctx.ui.notify(
        "To inspect operations: jj op log\nTo undo last operation: jj op undo",
        "info",
      );
    }

    // Show summary
    ctx.ui.notify(result.summary, "info");

    // Show commit messages
    if (result.messages.length > 0) {
      for (const msg of result.messages) {
        ctx.ui.notify(msg, "info");
      }
    }

    // Push if requested
    if (args.push && result.committed) {
      const bookmark = args.bookmark ?? "main";
      const pushResult = await deps.pushWithBookmark(jj, bookmark, onProgress);
      if (pushResult.success) {
        ctx.ui.notify(`Pushed bookmark '${bookmark}' to remote.`, "info");
      } else {
        ctx.ui.notify(
          `Push failed: ${pushResult.error}\n\nTo retry manually:\n  jj bookmark set ${bookmark} -r @-\n  jj git push --bookmark ${bookmark}`,
          "error",
        );
      }
    }
  };
}

export default function(pi: ExtensionAPI) {
  registerJjCommitCommand(pi);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

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
    noChangelog: false,
    noAbsorb: false,
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].value;

    if (token.startsWith("--bookmark=")) {
      const bookmark = token.slice("--bookmark=".length);
      if (bookmark.length > 0) {
        result.bookmark = bookmark;
      }
      continue;
    }

    switch (token) {
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--push":
        result.push = true;
        break;
      case "--bookmark": {
        const next = tokens[i + 1]?.value;
        if (next && !next.startsWith("--")) {
          result.bookmark = next;
          i += 1;
        }
        break;
      }
      case "--no-changelog":
        result.noChangelog = true;
        break;
      case "--no-absorb":
        result.noAbsorb = true;
        break;
      case "--context": {
        const nextToken = tokens[i + 1];
        if (nextToken) {
          result.context = argsStr.slice(nextToken.start);
        }
        i = tokens.length; // consume rest
        break;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Agentic session factory
// ---------------------------------------------------------------------------

function createAgenticSession(
  ctx: InferenceContext,
): PipelineContext["runAgenticSession"] {
  return async (input) => {
    const prompt = buildCommitPrompt(input);

    try {
      const result = await runModelInference(ctx, input.model, prompt);
      if (result) {
        const parsed = parseModelResponse(result, input.changedFiles);
        if (!parsed.proposal && !parsed.splitPlan) {
          // Write failed response to a temp file for debugging
          try {
            const debugDir = join(tmpdir(), "pi-jj-commit-debug");
            mkdirSync(debugDir, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const debugPath = join(debugDir, `failed-response-${timestamp}.txt`);
            writeFileSync(debugPath, `Model: ${input.model.provider}::${input.model.id}\nChanged files: ${input.changedFiles.join(", ")}\n\n--- Raw Response ---\n${result}`);
            ctx.logger?.debug?.(
              `Model response could not be parsed into a commit plan. Raw response saved to: ${debugPath}`,
            );
            return { debugPath };
          } catch {
            // Best-effort — don't let debug logging break the pipeline
          }
        }
        return parsed;
      }
    } catch {
      // Fall through to no result
    }

    return {};
  };
}
