import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RecapModelRef {
  provider: string;
  id: string;
}

export interface RecapConfig {
  model?: RecapModelRef;
}

type RawModelRef =
  | string
  | {
    provider?: string;
    id?: string;
  };

type RawRecapConfig = {
  model?: RawModelRef;
};

function readJsonFile(filePath: string): RawRecapConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Expected ${filePath} to contain a JSON object`);
  }
  return parsed as RawRecapConfig;
}

export function parseModelRef(
  value: RawModelRef,
  fieldName = "model",
): RecapModelRef {
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
  const id = value.id?.trim();

  if (!provider) throw new Error(`${fieldName}.provider is required`);
  if (!id) throw new Error(`${fieldName}.id is required`);
  return { provider, id };
}

function normalizeConfig(raw: RawRecapConfig): RecapConfig {
  const model = raw.model ? parseModelRef(raw.model) : undefined;
  return model ? { model } : {};
}

function mergeRawConfigs(
  base: RawRecapConfig,
  override: RawRecapConfig,
): RawRecapConfig {
  return {
    ...base,
    ...override,
    model: override.model ?? base.model,
  };
}

export function loadRecapConfig(cwd: string): RecapConfig {
  const globalPath = path.join(os.homedir(), ".pi", "agent", "recap.json");
  const projectPath = path.join(cwd, ".pi", "recap.json");

  let raw: RawRecapConfig = {};
  if (fs.existsSync(globalPath))
    raw = mergeRawConfigs(raw, readJsonFile(globalPath));
  if (fs.existsSync(projectPath))
    raw = mergeRawConfigs(raw, readJsonFile(projectPath));
  return normalizeConfig(raw);
}
