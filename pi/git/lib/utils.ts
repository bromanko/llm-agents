import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function isGitRepo(dir: string): boolean {
  let current = dir;
  while (true) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}
