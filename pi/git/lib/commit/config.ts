import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface NormalizedGitCommitModelRef {
  provider: string;
  id: string;
}

export interface NormalizedGitCommitConfig {
  model?: NormalizedGitCommitModelRef;
}

type RawModelRef =
  | string
  | {
    provider?: string;
    id?: string;
    model?: string;
  };

type RawGitCommitConfig = {
  model?: RawModelRef;
};

function readJsonFile(filePath: string): RawGitCommitConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Expected ${filePath} to contain a JSON object`);
  }
  return parsed as RawGitCommitConfig;
}

function mergeRawConfigs(base: RawGitCommitConfig, override: RawGitCommitConfig): RawGitCommitConfig {
  return {
    ...base,
    ...override,
    model: override.model ?? base.model,
  };
}

export function parseModelRef(value: RawModelRef, fieldName = "model"): NormalizedGitCommitModelRef {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${fieldName} must not be empty`);

    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
      throw new Error(`${fieldName} must use provider/model syntax`);
    }

    const provider = trimmed.slice(0, slashIndex).trim();
    const id = trimmed.slice(slashIndex + 1).trim();
    if (!provider) throw new Error(`${fieldName} is missing a provider`);
    if (!id) throw new Error(`${fieldName} is missing a model id`);
    return { provider, id };
  }

  if (!value || typeof value !== "object") {
    throw new Error(`${fieldName} must be a string or object`);
  }

  const provider = value.provider?.trim();
  const id = value.id?.trim() || value.model?.trim();

  if (!provider) throw new Error(`${fieldName}.provider is required`);
  if (!id) throw new Error(`${fieldName}.id is required`);
  return { provider, id };
}

export function normalizeConfig(raw: RawGitCommitConfig): NormalizedGitCommitConfig {
  const model = raw.model ? parseModelRef(raw.model) : undefined;
  return model ? { model } : {};
}

export function loadGitCommitConfig(cwd: string): NormalizedGitCommitConfig {
  const globalPath = path.join(os.homedir(), ".pi", "agent", "git-commit.json");
  const projectPath = path.join(cwd, ".pi", "git-commit.json");

  let raw: RawGitCommitConfig = {};
  if (fs.existsSync(globalPath)) raw = mergeRawConfigs(raw, readJsonFile(globalPath));
  if (fs.existsSync(projectPath)) raw = mergeRawConfigs(raw, readJsonFile(projectPath));
  return normalizeConfig(raw);
}
