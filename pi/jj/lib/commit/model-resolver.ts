/**
 * Model resolution for jj-commit.
 *
 * Preferred order:
 *   1. Configured model from jj-commit settings
 *   2. Sonnet 4.6 (anthropic/claude-sonnet-4-6-*)
 *   3. Current session model
 *   4. Null (caller reports failure)
 */

export interface ModelCandidate {
  provider: string;
  id: string;
  name: string;
}

export interface ModelResolverInput {
  /** All models available in the registry */
  availableModels: ModelCandidate[];
  /** Model configured in jj-commit settings */
  configuredModel?: ModelCandidate;
  /** The model currently active in the session (may be undefined) */
  sessionModel?: ModelCandidate;
  /** Function to check if an API key exists for a given model */
  hasApiKey: (model: ModelCandidate) => Promise<boolean>;
}

export interface ModelResolverResult {
  model: ModelCandidate | null;
  warnings: string[];
}

const PREFERRED_MODEL_PATTERN = /^claude-sonnet-4-6/;
const PREFERRED_PROVIDER = "anthropic";

const INCOMPATIBLE_PROVIDERS = new Set([
  // openai-codex works via pi-ai's complete() path, so allow it for jj-commit.
  // Keep opencode excluded until jj-commit has a proven-compatible inference path.
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
        `Configured model ${input.configuredModel.provider}/${input.configuredModel.id} uses an incompatible provider for jj-commit (${input.configuredModel.provider}).`,
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
    (m) =>
      m.provider === PREFERRED_PROVIDER
      && PREFERRED_MODEL_PATTERN.test(m.id)
      && isCompatibleProvider(m),
  );

  if (preferred) {
    const hasKey = await input.hasApiKey(preferred);
    if (hasKey) {
      return { model: preferred, warnings };
    }
    warnings.push(
      `Preferred model ${preferred.provider}/${preferred.id} has no API key; falling back to session model.`,
    );
  } else {
    warnings.push(
      "Preferred model (Sonnet 4.6) not found in registry; falling back to session model.",
    );
  }

  if (input.sessionModel) {
    if (!isCompatibleProvider(input.sessionModel)) {
      warnings.push(
        `Session model ${input.sessionModel.provider}/${input.sessionModel.id} uses an incompatible provider for jj-commit (${input.sessionModel.provider}). Skipping.`,
      );
    } else {
      const hasKey = await input.hasApiKey(input.sessionModel);
      if (hasKey) {
        return { model: input.sessionModel, warnings };
      }
      warnings.push(
        `Session model ${input.sessionModel.provider}/${input.sessionModel.id} has no API key.`,
      );
    }
  } else {
    warnings.push("No session model available.");
  }

  warnings.push("No compatible jj-commit model is available. Configure one in ~/.pi/agent/jj-commit.json or .pi/jj-commit.json, or switch the session model.");
  return { model: null, warnings };
}
