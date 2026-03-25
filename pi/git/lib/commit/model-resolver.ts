/**
 * Model resolution for git-commit.
 * Preferred order:
 *   1. Configured model from git-commit settings
 *   2. Built-in preferred model: Sonnet 4.6
 *   3. Current session model (if compatible with completeSimple)
 *
 * Providers that use non-standard completion APIs (e.g. openai-codex uses the
 * Codex Responses API with JWT auth and a different request/response shape)
 * are excluded because completeSimple returns empty/undefined responses for
 * them.
 */

export interface ModelCandidate {
  provider: string;
  id: string;
  name: string;
}

export interface ModelResolverInput {
  availableModels: ModelCandidate[];
  configuredModel?: ModelCandidate;
  sessionModel?: ModelCandidate;
  hasApiKey: (model: ModelCandidate) => Promise<boolean>;
}

export interface ModelResolverResult {
  model: ModelCandidate | null;
  warnings: string[];
}

const PREFERRED_MODEL_PATTERN = /^claude-sonnet-4-6/;
const PREFERRED_PROVIDER = "anthropic";

/**
 * Providers whose completeSimple path does not return usable text responses
 * for one-shot prompts. These are skipped during model selection.
 */
const INCOMPATIBLE_PROVIDERS = new Set([
  "openai-codex",
  "opencode",
]);

export function isCompatibleProvider(model: ModelCandidate): boolean {
  return !INCOMPATIBLE_PROVIDERS.has(model.provider);
}

export async function resolveCommitModel(
  input: ModelResolverInput,
): Promise<ModelResolverResult> {
  const warnings: string[] = [];

  if (input.configuredModel) {
    if (!isCompatibleProvider(input.configuredModel)) {
      warnings.push(
        `Configured model ${input.configuredModel.provider}/${input.configuredModel.id} uses an incompatible provider for commit planning (${input.configuredModel.provider}).`,
      );
    } else if (await input.hasApiKey(input.configuredModel)) {
      return { model: input.configuredModel, warnings };
    } else {
      warnings.push(
        `Configured model ${input.configuredModel.provider}/${input.configuredModel.id} is unavailable or has no API key; falling back.`,
      );
    }
  }

  const preferred = input.availableModels.find(
    (model) =>
      model.provider === PREFERRED_PROVIDER
      && PREFERRED_MODEL_PATTERN.test(model.id)
      && isCompatibleProvider(model),
  );

  if (preferred) {
    if (await input.hasApiKey(preferred)) {
      return { model: preferred, warnings };
    }
    warnings.push(
      `Preferred model ${preferred.provider}/${preferred.id} has no API key; falling back.`,
    );
  } else {
    warnings.push("Preferred model (Sonnet 4.6) not found in registry; falling back.");
  }

  if (input.sessionModel) {
    if (!isCompatibleProvider(input.sessionModel)) {
      warnings.push(
        `Session model ${input.sessionModel.provider}/${input.sessionModel.id} uses an incompatible provider for commit planning (${input.sessionModel.provider}). Skipping.`,
      );
    } else if (await input.hasApiKey(input.sessionModel)) {
      return { model: input.sessionModel, warnings };
    } else {
      warnings.push(
        `Session model ${input.sessionModel.provider}/${input.sessionModel.id} has no API key.`,
      );
    }
  } else {
    warnings.push("No session model available.");
  }

  warnings.push("No compatible git-commit model is available. Configure one in ~/.pi/agent/git-commit.json or .pi/git-commit.json, or switch the session model.");
  return { model: null, warnings };
}
