import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function isJjRepo(dir: string): boolean {
  let current = dir;
  while (current !== "/") {
    if (existsSync(join(current, ".jj"))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}
