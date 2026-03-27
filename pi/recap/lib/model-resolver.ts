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

const PREFERRED_MODELS: Array<{
  provider: string;
  pattern: RegExp;
  label: string;
}> = [
    {
      provider: "openai-codex",
      pattern: /^gpt-5(-mini)?/,
      label: "GPT-5 / GPT-5 Mini (Codex)",
    },
  ];

export async function resolveRecapModel(
  input: ModelResolverInput,
): Promise<ModelResolverResult> {
  const warnings: string[] = [];

  // 1. Configured model from recap settings
  if (input.configuredModel) {
    if (await input.hasApiKey(input.configuredModel)) {
      return { model: input.configuredModel, warnings };
    }
    warnings.push(
      `Configured model ${input.configuredModel.provider}/${input.configuredModel.id} is unavailable or has no API key; falling back.`,
    );
  }

  // 2. Preferred cheap/fast model
  for (const preference of PREFERRED_MODELS) {
    const preferred = input.availableModels.find(
      (m) =>
        m.provider === preference.provider &&
        preference.pattern.test(m.id),
    );

    if (!preferred) {
      warnings.push(
        `Preferred model (${preference.label}) not found in registry; trying next fallback.`,
      );
      continue;
    }

    if (await input.hasApiKey(preferred)) {
      return { model: preferred, warnings };
    }

    warnings.push(
      `Preferred model ${preferred.provider}/${preferred.id} is unavailable or has no API key; trying next fallback.`,
    );
  }

  // 3. Session model
  if (input.sessionModel) {
    if (await input.hasApiKey(input.sessionModel)) {
      return { model: input.sessionModel, warnings };
    }
    warnings.push(
      `Session model ${input.sessionModel.provider}/${input.sessionModel.id} has no API key.`,
    );
  } else {
    warnings.push("No session model available.");
  }

  warnings.push(
    "No compatible recap model is available. Configure one in ~/.pi/agent/recap.json or .pi/recap.json, or switch the session model.",
  );
  return { model: null, warnings };
}
