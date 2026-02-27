/**
 * Config loading, merging, and resolution for the LSP extension.
 *
 * Config is resolved from three layers (lowest to highest precedence):
 *   1. Built-in defaults (defaults.json, shipped with this package)
 *   2. User config (~/.pi/agent/lsp.json)
 *   3. Project config (<cwd>/.pi/lsp.json)
 *
 * Higher-precedence layers override lower ones. Server entries are merged
 * by name: if a server name exists in defaults and in a config layer, the
 * config layer's fields are spread on top. New server names are appended
 * in insertion order. Setting `disabled: true` on a server keeps it in
 * the resolved list but marks it as excluded from detection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  LspRuntimeConfig,
  LspServerDefinition,
  ResolvedLspConfig,
} from "./types.ts";

/** Resolve the path to defaults.json relative to this module. */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(__dirname, "defaults.json");

/** Default global settings (separate from server definitions). */
const GLOBAL_DEFAULTS = {
  formatOnWrite: true,
  diagnosticsOnWrite: true,
  autoCodeActions: false,
  idleTimeoutMinutes: 10,
} as const;

/**
 * Read and parse a JSON file. Returns null if the file does not exist.
 * Throws with a deterministic message if the file exists but contains
 * invalid JSON.
 */
async function readJsonFile(filePath: string): Promise<LspRuntimeConfig | null> {
  try {
    const content = await fs.promises.readFile(filePath, "utf-8");
    try {
      return JSON.parse(content) as LspRuntimeConfig;
    } catch {
      throw new Error(`Failed to parse ${path.basename(filePath)}: invalid JSON in ${filePath}`);
    }
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Parse the servers map from defaults.json into an ordered array of
 * LspServerDefinition objects.
 */
function parseDefaultServers(
  serversMap: Record<string, Omit<LspServerDefinition, "name">>,
): LspServerDefinition[] {
  return Object.entries(serversMap).map(([name, def]) => ({
    name,
    command: def.command,
    args: def.args ?? [],
    fileTypes: def.fileTypes ?? [],
    rootMarkers: def.rootMarkers ?? [],
    ...(def.initializationOptions ? { initializationOptions: def.initializationOptions } : {}),
    ...(def.settings ? { settings: def.settings } : {}),
    ...(def.disabled !== undefined ? { disabled: def.disabled } : {}),
  }));
}

/**
 * Merge a config layer's servers map on top of the current server list.
 *
 * - If a server name already exists, its fields are overridden by the layer.
 * - If a server name is new, it is appended at the end.
 * - Insertion order within the layer is preserved.
 */
function mergeServers(
  base: LspServerDefinition[],
  layerServers: Record<string, Partial<LspServerDefinition> & { binary?: string }> | undefined,
): LspServerDefinition[] {
  if (!layerServers) return base;

  // Clone base into an ordered map for easy lookup + mutation.
  const merged = new Map<string, LspServerDefinition>();
  for (const s of base) {
    merged.set(s.name, { ...s });
  }

  for (const [name, overrides] of Object.entries(layerServers)) {
    const existing = merged.get(name);
    if (existing) {
      // Merge: override fields that are present in the layer.
      if (overrides.command !== undefined) existing.command = overrides.command;
      if (overrides.binary !== undefined) existing.command = overrides.binary;
      if (overrides.args !== undefined) existing.args = overrides.args;
      if (overrides.fileTypes !== undefined) existing.fileTypes = overrides.fileTypes;
      if (overrides.rootMarkers !== undefined) existing.rootMarkers = overrides.rootMarkers;
      if (overrides.initializationOptions !== undefined)
        existing.initializationOptions = overrides.initializationOptions;
      if (overrides.settings !== undefined) existing.settings = overrides.settings;
      if (overrides.disabled !== undefined) existing.disabled = overrides.disabled;
    } else {
      // New server entry — append.
      merged.set(name, {
        name,
        command: overrides.command ?? overrides.binary ?? name,
        args: overrides.args ?? [],
        fileTypes: overrides.fileTypes ?? [],
        rootMarkers: overrides.rootMarkers ?? [],
        ...(overrides.initializationOptions
          ? { initializationOptions: overrides.initializationOptions }
          : {}),
        ...(overrides.settings ? { settings: overrides.settings } : {}),
        ...(overrides.disabled !== undefined ? { disabled: overrides.disabled } : {}),
      });
    }
  }

  return Array.from(merged.values());
}

/**
 * Load the fully resolved LSP config by merging defaults, user, and project
 * config layers.
 *
 * @param cwd - The project working directory (used to find .pi/lsp.json).
 * @param homeDir - Override for the user's home directory (default: os.homedir()).
 */
export async function loadResolvedConfig(
  cwd: string,
  homeDir?: string,
): Promise<ResolvedLspConfig> {
  // 1. Load built-in defaults.
  const defaultsRaw = JSON.parse(await fs.promises.readFile(DEFAULTS_PATH, "utf-8"));
  let servers = parseDefaultServers(defaultsRaw.servers ?? {});

  // Start with global defaults.
  let formatOnWrite = GLOBAL_DEFAULTS.formatOnWrite;
  let diagnosticsOnWrite = GLOBAL_DEFAULTS.diagnosticsOnWrite;
  let autoCodeActions = GLOBAL_DEFAULTS.autoCodeActions;
  let idleTimeoutMinutes = GLOBAL_DEFAULTS.idleTimeoutMinutes;

  // 2. Load user config (~/.pi/agent/lsp.json).
  const home = homeDir ?? (await import("node:os")).homedir();
  const userConfigPath = path.join(home, ".pi", "agent", "lsp.json");
  const userConfig = await readJsonFile(userConfigPath);
  if (userConfig) {
    if (userConfig.formatOnWrite !== undefined) formatOnWrite = userConfig.formatOnWrite;
    if (userConfig.diagnosticsOnWrite !== undefined) diagnosticsOnWrite = userConfig.diagnosticsOnWrite;
    if (userConfig.autoCodeActions !== undefined) autoCodeActions = userConfig.autoCodeActions;
    if (userConfig.idleTimeoutMinutes !== undefined) idleTimeoutMinutes = userConfig.idleTimeoutMinutes;
    servers = mergeServers(servers, userConfig.servers);
  }

  // 3. Load project config (<cwd>/.pi/lsp.json).
  const projectConfigPath = path.join(cwd, ".pi", "lsp.json");
  const projectConfig = await readJsonFile(projectConfigPath);
  if (projectConfig) {
    if (projectConfig.formatOnWrite !== undefined) formatOnWrite = projectConfig.formatOnWrite;
    if (projectConfig.diagnosticsOnWrite !== undefined)
      diagnosticsOnWrite = projectConfig.diagnosticsOnWrite;
    if (projectConfig.autoCodeActions !== undefined) autoCodeActions = projectConfig.autoCodeActions;
    if (projectConfig.idleTimeoutMinutes !== undefined)
      idleTimeoutMinutes = projectConfig.idleTimeoutMinutes;
    servers = mergeServers(servers, projectConfig.servers);
  }

  return {
    formatOnWrite,
    diagnosticsOnWrite,
    autoCodeActions,
    idleTimeoutMinutes,
    servers,
  };
}
