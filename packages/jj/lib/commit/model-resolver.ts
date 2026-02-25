/**
 * Model resolution for jj-commit.
 *
 * Preferred model: Sonnet 4.6 (anthropic/claude-sonnet-4-6-*)
 * Fallback: current session model
 * Final fallback: null (caller uses deterministic path)
 */

export interface ModelCandidate {
  provider: string;
  id: string;
  name: string;
}

export interface ModelResolverInput {
  /** All models available in the registry */
  availableModels: ModelCandidate[];
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

export async function resolveCommitModel(
  input: ModelResolverInput,
): Promise<ModelResolverResult> {
  const warnings: string[] = [];

  // Try preferred Sonnet 4.6
  const preferred = input.availableModels.find(
    (m) =>
      m.provider === PREFERRED_PROVIDER && PREFERRED_MODEL_PATTERN.test(m.id),
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

  // Fallback to session model
  if (input.sessionModel) {
    const hasKey = await input.hasApiKey(input.sessionModel);
    if (hasKey) {
      return { model: input.sessionModel, warnings };
    }
    warnings.push(
      `Session model ${input.sessionModel.provider}/${input.sessionModel.id} has no API key.`,
    );
  } else {
    warnings.push("No session model available.");
  }

  // Final fallback: null (deterministic path)
  warnings.push("All model resolution paths failed; using deterministic fallback.");
  return { model: null, warnings };
}
