/**
 * Context File Approval Gate — Helper functions
 *
 * Helpers for context file discovery, hashing, approval store I/O,
 * and path utilities. Extracted for testability.
 *
 * All file I/O is async (fs/promises) to avoid blocking the event loop
 * during session start, where many filesystem calls may occur.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────

export interface ApprovalRecord {
  hash: string;
  approvedAt: string;
  /** If true, the file is permanently denied until the record is removed. */
  denied?: boolean;
}

export type ApprovalStore = Record<string, ApprovalRecord>;

export interface ContextFile {
  path: string;
  content: string;
}

export type FileVerdict = "approved" | "denied";

// ── Constants ──────────────────────────────────────────────────────────

export const APPROVALS_FILENAME = "context-approvals.json";
export const CONTEXT_FILENAMES = ["AGENTS.md", "CLAUDE.md"];

// ── Functions ──────────────────────────────────────────────────────────

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function getApprovalsPath(): string {
  return join(getAgentDir(), APPROVALS_FILENAME);
}

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Runtime check that a parsed value conforms to the ApprovalRecord shape. */
function isValidApprovalRecord(value: unknown): value is ApprovalRecord {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.hash === "string" &&
    typeof obj.approvedAt === "string" &&
    (obj.denied === undefined || typeof obj.denied === "boolean")
  );
}

export async function loadApprovals(): Promise<ApprovalStore> {
  const p = getApprovalsPath();
  try {
    const raw = await readFile(p, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const store: ApprovalStore = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (isValidApprovalRecord(value)) {
        store[key] = value;
      }
    }
    return store;
  } catch {
    return {};
  }
}

export async function saveApprovals(store: ApprovalStore): Promise<void> {
  const p = getApprovalsPath();
  const dir = join(p, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(p, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/**
 * True when the path is inside the user's pi agent config directory.
 * Resolves symlinks before comparison to prevent traversal attacks.
 */
export function isUserOwnedConfig(filePath: string): boolean {
  const agentDir = getAgentDir();
  try {
    const resolvedFile = realpathSync(resolve(filePath));
    const resolvedAgent = realpathSync(agentDir);
    return (
      resolvedFile.startsWith(resolvedAgent + "/") ||
      resolvedFile === resolvedAgent
    );
  } catch {
    // If realpath fails (path doesn't exist), fall back to resolve
    const resolved = resolve(filePath);
    return resolved.startsWith(agentDir + "/") || resolved === agentDir;
  }
}

/**
 * Discover AGENTS.md / CLAUDE.md the same way pi does:
 * global dir → walk up from cwd to root (ancestors in root-first order).
 *
 * Resolves symlinks before reading content so the user sees actual file
 * data regardless of symlink indirection.
 */
export async function discoverContextFiles(
  cwd: string,
): Promise<ContextFile[]> {
  const files: ContextFile[] = [];
  const seen = new Set<string>();

  const tryDir = async (dir: string) => {
    for (const name of CONTEXT_FILENAMES) {
      const p = join(dir, name);
      if (seen.has(p)) continue;
      try {
        // Resolve symlinks before reading to surface the true source path
        let realPath: string;
        try {
          realPath = realpathSync(p);
        } catch {
          realPath = p;
        }
        const content = await readFile(realPath, "utf8");
        files.push({ path: p, content });
        seen.add(p);
        return; // first match per dir wins (AGENTS.md before CLAUDE.md)
      } catch {
        /* ignore unreadable or missing */
      }
    }
  };

  // Global
  await tryDir(getAgentDir());

  // Walk up from cwd, collecting ancestors then reversing for root-first order
  const ancestors: string[] = [];
  let dir = resolve(cwd);
  const root = resolve("/");
  while (true) {
    ancestors.push(dir);
    if (dir === root) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  ancestors.reverse();
  for (const d of ancestors) await tryDir(d);

  return files;
}

export function shortenPath(p: string, cwd: string): string {
  const home = homedir();
  const resolved = resolve(p);
  if (resolved.startsWith(cwd + "/")) return resolved.slice(cwd.length + 1);
  if (resolved.startsWith(home)) return "~" + resolved.slice(home.length);
  return resolved;
}
