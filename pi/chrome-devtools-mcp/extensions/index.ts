import { accessSync, constants } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const skillPath = join(extensionDir, "..", "chrome-devtools-mcp", "SKILL.md");

function canExecute(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getExecutableCandidates(name: string, platform: NodeJS.Platform, pathExtEnv: string): string[] {
  if (platform !== "win32") return [name];

  const ext = extname(name);
  if (ext) return [name];

  const pathExts = pathExtEnv
    .split(";")
    .map((value) => value.trim())
    .filter(Boolean);

  const uniqueExts = Array.from(new Set([".exe", ".cmd", ".bat", ".com", ...pathExts]));
  return uniqueExts.map((suffix) => `${name}${suffix}`);
}

export function hasExecutableInPath(
  name: string,
  options: {
    pathEnv?: string;
    platform?: NodeJS.Platform;
    pathExtEnv?: string;
  } = {},
): boolean {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const platform = options.platform ?? process.platform;
  const pathExtEnv = options.pathExtEnv ?? process.env.PATHEXT ?? "";

  if (!pathEnv) return false;

  const candidates = getExecutableCandidates(name, platform, pathExtEnv);
  const searchDirs = pathEnv.split(delimiter).filter(Boolean);

  for (const dir of searchDirs) {
    for (const candidate of candidates) {
      if (canExecute(join(dir, candidate))) return true;
    }
  }

  return false;
}

export default function registerChromeDevtoolsMcpAvailability(pi: ExtensionAPI): void {
  pi.on("resources_discover", () => {
    if (!hasExecutableInPath("chrome-devtools-mcp")) {
      return;
    }

    return {
      skillPaths: [skillPath],
    };
  });
}
