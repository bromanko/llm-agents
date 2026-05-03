/**
 * /recap — on-demand session summary overlay.
 *
 * Shows a concise recap of what the current session is about, what's been
 * accomplished, and where you left off. Runs as an overlay so it doesn't
 * interrupt a running agent.
 *
 * Model resolution order:
 *   1. Configured model from recap.json (global or project)
 *   2. GPT-5 / GPT-5 Mini via openai-codex
 *   3. Current session model
 *
 * Config: ~/.pi/agent/recap.json or .pi/recap.json
 *   { "model": "openai-codex/gpt-5-mini" }
 */

import { complete, type UserMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  BorderedLoader,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import {
  Markdown,
  Text,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { loadRecapConfig } from "../lib/config.ts";
import {
  resolveRecapModel,
  type ModelCandidate,
} from "../lib/model-resolver.ts";
import {
  buildConversationText,
  buildRecapPrompt,
  extractRecapText,
  RECAP_SYSTEM_PROMPT,
} from "../lib/summarize.ts";

function modelKey(provider: string, id: string): string {
  return `${provider}::${id}`;
}

function resolveModelObject(
  ctx: {
    modelRegistry?: {
      find: (provider: string, id: string) => unknown;
      getAll: () => unknown[];
    };
    model?: { provider?: string; id?: string };
  },
  model: ModelCandidate,
): { value: unknown; registryModel: unknown | null } | null {
  let registryModel = ctx.modelRegistry?.find(model.provider, model.id);

  if (!registryModel && ctx.modelRegistry?.getAll) {
    const models = ctx.modelRegistry.getAll();
    registryModel = models.find((m) => {
      if (!m || typeof m !== "object") return false;
      return (
        "provider" in m &&
        "id" in m &&
        (m as { provider?: string }).provider === model.provider &&
        (m as { id?: string }).id === model.id
      );
    });
  }

  if (registryModel) {
    return { value: registryModel, registryModel };
  }

  const sessionModel =
    ctx.model &&
      ctx.model.provider === model.provider &&
      ctx.model.id === model.id
      ? ctx.model
      : undefined;

  if (sessionModel) {
    return { value: sessionModel, registryModel: null };
  }

  return null;
}

type RecapAuth = {
  apiKey?: string;
  headers?: Record<string, string>;
};

type RecapAuthResult =
  | { ok: true; apiKey?: string; headers?: Record<string, string> }
  | { ok: false; error?: string };

type RecapModelRegistry = {
  getApiKey: (model: unknown) => Promise<string | null | undefined>;
  getApiKeyAndHeaders?: (model: unknown) => Promise<RecapAuthResult | null | undefined>;
};

type RecapAuthContext = {
  modelRegistry?: RecapModelRegistry;
};

type RecapGenerationResult =
  | { ok: true; summary: string }
  | { ok: false; cancelled?: boolean; error?: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAllowedAuthHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "authorization" || lower === "api-key" || lower.startsWith("x-");
}

function sanitizeAuthHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (isAllowedAuthHeader(key) && isNonEmptyString(value)) {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function hasAuth(auth: RecapAuth): boolean {
  return isNonEmptyString(auth.apiKey) || auth.headers !== undefined;
}

async function resolveAuth(
  ctx: RecapAuthContext,
  registryModel: unknown | null,
): Promise<RecapAuth> {
  if (!registryModel || !ctx.modelRegistry) return {};

  try {
    if (typeof ctx.modelRegistry.getApiKeyAndHeaders === "function") {
      const result = await ctx.modelRegistry.getApiKeyAndHeaders(registryModel);
      if (result?.ok) {
        return {
          apiKey: isNonEmptyString(result.apiKey) ? result.apiKey : undefined,
          headers: sanitizeAuthHeaders(result.headers),
        };
      }
    }

    const key = await ctx.modelRegistry.getApiKey(registryModel);
    if (isNonEmptyString(key)) return { apiKey: key };
  } catch {
    // Best-effort: continue without explicit auth when the provider can resolve it elsewhere.
  }

  return {};
}

async function hasRegistryAuth(
  ctx: RecapAuthContext,
  registryModel: unknown | null,
): Promise<boolean> {
  return hasAuth(await resolveAuth(ctx, registryModel));
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("recap", {
    description: "Show a quick summary of what this session is about",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("recap requires interactive mode", "error");
        return;
      }

      // Build conversation text from the session branch
      const branch = ctx.sessionManager.getBranch();
      const conversationText = buildConversationText(branch);

      if (!conversationText.trim()) {
        ctx.ui.notify("Nothing to recap — session is empty.", "info");
        return;
      }

      // Load config and resolve model
      let recapConfig;
      try {
        recapConfig = loadRecapConfig(ctx.cwd);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Invalid recap config: ${message}`, "error");
        return;
      }

      const availableModels: ModelCandidate[] = [];
      const registryModelByKey = new Map<string, unknown>();

      if (ctx.modelRegistry) {
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

      let sessionModel: ModelCandidate | undefined;
      if (ctx.model) {
        sessionModel = {
          provider: ctx.model.provider,
          id: ctx.model.id,
          name: ctx.model.name,
        };
      }

      const apiKeyCache = new Map<string, Promise<boolean>>();
      const hasApiKey = async (model: ModelCandidate): Promise<boolean> => {
        if (
          sessionModel &&
          model.provider === sessionModel.provider &&
          model.id === sessionModel.id
        ) {
          return true;
        }
        if (!ctx.modelRegistry) return false;
        const key = modelKey(model.provider, model.id);
        const cached = apiKeyCache.get(key);
        if (cached) return cached;

        const check = (async () => {
          const found =
            registryModelByKey.get(key) ??
            ctx.modelRegistry.find(model.provider, model.id);
          if (!found) return false;
          return hasRegistryAuth(ctx, found);
        })();

        apiKeyCache.set(key, check);
        return check;
      };

      const { model: resolvedModel, warnings } = await resolveRecapModel({
        availableModels,
        configuredModel: recapConfig.model
          ? {
            provider: recapConfig.model.provider,
            id: recapConfig.model.id,
            name: `${recapConfig.model.provider}/${recapConfig.model.id}`,
          }
          : undefined,
        sessionModel,
        hasApiKey,
      });

      for (const w of warnings) {
        ctx.ui.notify(`⚠ ${w}`, "warning");
      }

      if (!resolvedModel) {
        return;
      }

      const resolvedModelObject = resolveModelObject(ctx, resolvedModel);
      if (!resolvedModelObject) {
        ctx.ui.notify(
          `Model ${resolvedModel.provider}/${resolvedModel.id} could not be resolved.`,
          "error",
        );
        return;
      }

      // Phase 1: Show spinner overlay while generating
      const generation = await ctx.ui.custom<RecapGenerationResult>(
        (tui, theme, _kb, done) => {
          const loader = new BorderedLoader(
            tui,
            theme,
            `Generating recap via ${resolvedModel.provider}/${resolvedModel.id}...`,
          );

          let settled = false;
          const finish = (result: RecapGenerationResult) => {
            if (settled) return;
            settled = true;
            done(result);
          };

          loader.onAbort = () => finish({ ok: false, cancelled: true });

          const generate = async (): Promise<RecapGenerationResult> => {
            const auth = await resolveAuth(
              ctx,
              resolvedModelObject.registryModel,
            );
            const prompt = buildRecapPrompt(conversationText);

            const userMessage: UserMessage = {
              role: "user",
              content: [{ type: "text", text: prompt }],
              timestamp: Date.now(),
            };

            const response = await complete(
              resolvedModelObject.value as Parameters<typeof complete>[0],
              {
                systemPrompt: RECAP_SYSTEM_PROMPT,
                messages: [userMessage],
              },
              { ...auth, signal: loader.signal, maxTokens: 1024 },
            );

            if (response.stopReason === "aborted") {
              return { ok: false, cancelled: true };
            }

            const summary = extractRecapText(response);
            if (!summary) {
              return {
                ok: false,
                error: "The recap model returned no text content.",
              };
            }

            return { ok: true, summary };
          };

          generate()
            .then(finish)
            .catch((error) => finish({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }));

          return loader;
        },
        { overlay: true },
      );

      if (!generation.ok) {
        if (!generation.cancelled) {
          ctx.ui.notify(
            `Failed to generate recap: ${generation.error ?? "unknown error"}`,
            "error",
          );
        }
        return;
      }

      const { summary } = generation;

      // Phase 2: Show the rendered recap
      await ctx.ui.custom<void>(
        (_tui, theme, _kb, done) => {
          const mdTheme = getMarkdownTheme();
          const markdown = new Markdown(summary, 1, 1, mdTheme);
          const footer = new Text(
            theme.fg("dim", "Press Enter or Esc to close"),
            1,
            0,
          );

          const padLine = (line: string, width: number) => {
            const truncated = truncateToWidth(line, width, "...", true);
            return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
          };

          return {
            render: (width: number) => {
              const innerW = Math.max(1, width - 2);
              const border = (s: string) => theme.fg("border", s);
              const titleText = truncateToWidth("Recap", Math.max(1, innerW - 4), "", true);
              const leftSegment = "─ ";
              const middleGap = " ";
              const rightRuleWidth = Math.max(
                0,
                innerW - visibleWidth(leftSegment) - visibleWidth(titleText) - visibleWidth(middleGap),
              );

              const lines: string[] = [];
              lines.push(
                border(`╭${leftSegment}`)
                + theme.fg("accent", titleText)
                + border(`${middleGap}${"─".repeat(rightRuleWidth)}╮`),
              );

              for (const line of markdown.render(innerW)) {
                lines.push(border("│") + padLine(line, innerW) + border("│"));
              }

              lines.push(border("│") + " ".repeat(innerW) + border("│"));

              for (const line of footer.render(innerW)) {
                lines.push(border("│") + padLine(line, innerW) + border("│"));
              }

              lines.push(border(`╰${"─".repeat(innerW)}╯`));
              return lines;
            },
            invalidate: () => {
              markdown.invalidate();
              footer.invalidate();
            },
            handleInput: (data: string) => {
              if (matchesKey(data, "enter") || matchesKey(data, "escape")) {
                done(undefined);
              }
            },
          };
        },
        { overlay: true },
      );
    },
  });
}
