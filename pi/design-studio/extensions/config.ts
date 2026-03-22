import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface NormalizedModelRef {
  provider: string;
  model: string;
  thinkingLevel?: ThinkingLevel;
}

export interface NormalizedProfile {
  facilitator: NormalizedModelRef;
  architectA: NormalizedModelRef;
  architectB: NormalizedModelRef;
  maxRounds: number;
  saveDir: string;
}

export interface NormalizedConfig {
  defaultProfile?: string;
  profiles: Record<string, NormalizedProfile>;
  saveDir: string;
}

type RawModelRef =
  | string
  | {
    provider?: string;
    model?: string;
    thinkingLevel?: string;
  };

type RawProfile = {
  facilitator?: RawModelRef;
  architectA?: RawModelRef;
  architectB?: RawModelRef;
  maxRounds?: number;
  saveDir?: string;
};

type RawConfig = {
  defaultProfile?: string;
  profiles?: Record<string, RawProfile>;
  saveDir?: string;
};

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

export function parseModelRef(value: RawModelRef, fieldName = "model"): NormalizedModelRef {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`${fieldName} must not be empty`);

    const slashIndex = trimmed.indexOf("/");
    if (slashIndex <= 0 || slashIndex === trimmed.length - 1) {
      throw new Error(`${fieldName} must use provider/model or provider/model:thinking syntax`);
    }

    const provider = trimmed.slice(0, slashIndex).trim();
    const remainder = trimmed.slice(slashIndex + 1).trim();
    const lastColon = remainder.lastIndexOf(":");
    let model = remainder;
    let thinkingLevel: ThinkingLevel | undefined;

    if (lastColon !== -1) {
      const suffix = remainder.slice(lastColon + 1).trim();
      if (isThinkingLevel(suffix)) {
        model = remainder.slice(0, lastColon).trim();
        thinkingLevel = suffix;
      }
    }

    if (!provider) throw new Error(`${fieldName} is missing a provider`);
    if (!model) throw new Error(`${fieldName} is missing a model id`);
    return { provider, model, thinkingLevel };
  }

  if (!value || typeof value !== "object") {
    throw new Error(`${fieldName} must be a string or object`);
  }

  const provider = value.provider?.trim();
  const model = value.model?.trim();
  const thinkingLevel = value.thinkingLevel?.trim();

  if (!provider) throw new Error(`${fieldName}.provider is required`);
  if (!model) throw new Error(`${fieldName}.model is required`);
  if (thinkingLevel && !isThinkingLevel(thinkingLevel)) {
    throw new Error(
      `${fieldName}.thinkingLevel must be one of ${THINKING_LEVELS.join(", ")}`,
    );
  }

  return {
    provider,
    model,
    thinkingLevel: thinkingLevel as ThinkingLevel | undefined,
  };
}

function readJsonFile(filePath: string): RawConfig {
  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Expected ${filePath} to contain a JSON object`);
  }
  return parsed as RawConfig;
}

function mergeRawConfigs(base: RawConfig, override: RawConfig): RawConfig {
  return {
    ...base,
    ...override,
    saveDir: override.saveDir ?? base.saveDir,
    defaultProfile: override.defaultProfile ?? base.defaultProfile,
    profiles: { ...(base.profiles ?? {}), ...(override.profiles ?? {}) },
  };
}

export function normalizeConfig(raw: RawConfig): NormalizedConfig {
  const saveDir = raw.saveDir?.trim() || "docs/designs";
  const rawProfiles = raw.profiles ?? {};
  const profiles: Record<string, NormalizedProfile> = {};

  for (const [name, profile] of Object.entries(rawProfiles)) {
    if (!profile || typeof profile !== "object") {
      throw new Error(`profiles.${name} must be an object`);
    }
    if (!profile.architectA) throw new Error(`profiles.${name}.architectA is required`);
    if (!profile.architectB) throw new Error(`profiles.${name}.architectB is required`);

    const architectA = parseModelRef(profile.architectA, `profiles.${name}.architectA`);
    const architectB = parseModelRef(profile.architectB, `profiles.${name}.architectB`);
    const facilitator = profile.facilitator
      ? parseModelRef(profile.facilitator, `profiles.${name}.facilitator`)
      : architectA;
    const maxRounds = Math.max(1, Math.min(5, Math.floor(profile.maxRounds ?? 3)));

    profiles[name] = {
      facilitator,
      architectA,
      architectB,
      maxRounds,
      saveDir: profile.saveDir?.trim() || saveDir,
    };
  }

  const defaultProfile = raw.defaultProfile?.trim() || Object.keys(profiles)[0];
  if (defaultProfile && profiles[defaultProfile] === undefined && Object.keys(profiles).length > 0) {
    throw new Error(`defaultProfile "${defaultProfile}" does not exist in profiles`);
  }

  return {
    defaultProfile,
    profiles,
    saveDir,
  };
}

export function loadDesignStudioConfig(cwd: string): NormalizedConfig {
  const globalPath = path.join(os.homedir(), ".pi", "agent", "design-studio.json");
  const projectPath = path.join(cwd, ".pi", "design-studio.json");

  let raw: RawConfig = {};
  if (fs.existsSync(globalPath)) raw = mergeRawConfigs(raw, readJsonFile(globalPath));
  if (fs.existsSync(projectPath)) raw = mergeRawConfigs(raw, readJsonFile(projectPath));
  return normalizeConfig(raw);
}

export function formatModelRef(model: NormalizedModelRef): string {
  return `${model.provider}/${model.model}${model.thinkingLevel ? `:${model.thinkingLevel}` : ""}`;
}

export function slugifyTopic(topic: string): string {
  const slug = topic
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "design";
}

export function nextAvailableSavePath(baseDir: string, topic: string): string {
  const slug = slugifyTopic(topic);
  let candidate = path.join(baseDir, `${slug}.md`);
  if (!fs.existsSync(candidate)) return candidate;

  for (let i = 2; i < 1000; i++) {
    candidate = path.join(baseDir, `${slug}-${i}.md`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(baseDir, `${slug}-${Date.now()}.md`);
}
