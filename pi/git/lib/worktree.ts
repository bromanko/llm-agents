import { basename, dirname, resolve } from "node:path";

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branchRef: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface ManagedGitWorktree {
  name: string;
  path: string;
  branchRef: string;
  head: string;
}

export const MANAGED_WORKTREE_BRANCH_PREFIX = "refs/heads/pi-ws/";

export function managedBranchRef(name: string): string {
  return `${MANAGED_WORKTREE_BRANCH_PREFIX}${name}`;
}

export function managedNameFromBranchRef(branchRef: string | null): string | null {
  if (!branchRef?.startsWith(MANAGED_WORKTREE_BRANCH_PREFIX)) return null;

  const name = branchRef.slice(MANAGED_WORKTREE_BRANCH_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

function finalizeEntry(entries: GitWorktreeEntry[], current: GitWorktreeEntry | null) {
  if (!current?.path) return;
  entries.push(current);
}

export function parseGitWorktreeList(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let current: GitWorktreeEntry | null = null;

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) {
      finalizeEntry(entries, current);
      current = null;
      continue;
    }

    if (!current) {
      current = {
        path: "",
        head: "",
        branchRef: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: false,
      };
    }

    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length).trim();
      continue;
    }

    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim();
      continue;
    }

    if (line.startsWith("branch ")) {
      current.branchRef = line.slice("branch ".length).trim() || null;
      continue;
    }

    if (line === "bare") {
      current.bare = true;
      continue;
    }

    if (line === "detached") {
      current.detached = true;
      continue;
    }

    if (line.startsWith("locked")) {
      current.locked = true;
      continue;
    }

    if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }

  finalizeEntry(entries, current);
  return entries;
}

export function toManagedGitWorktree(entry: GitWorktreeEntry): ManagedGitWorktree | null {
  if (entry.bare || entry.detached) return null;

  const name = managedNameFromBranchRef(entry.branchRef);
  if (!name || !entry.branchRef) return null;

  return {
    name,
    path: entry.path,
    branchRef: entry.branchRef,
    head: entry.head,
  };
}

export function computeMainWorktreeRoot(showTopLevel: string, gitCommonDir: string): string {
  const topLevel = resolve(showTopLevel.trim());
  const resolvedCommonDir = resolve(topLevel, gitCommonDir.trim());
  return basename(resolvedCommonDir) === ".git"
    ? dirname(resolvedCommonDir)
    : topLevel;
}

export function linkedWorktreeOnManagedBranch(currentBranchRef: string | null, name: string): boolean {
  return currentBranchRef === managedBranchRef(name);
}
