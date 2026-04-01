import { readdir, stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_SKIP_NAMES } from "./constants.ts";
import type { PathKind, PathValidationResult } from "./types.ts";

function normalizeSeparators(value: string): string {
  return value.replace(/[\\/]+/g, "/");
}

function normalizeRequestedPath(requestedPath: string): string {
  return requestedPath.replace(/[\\/]+/g, path.sep);
}

function normalizeRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  return relative ? normalizeSeparators(relative) : ".";
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function basenameFor(value: string): string {
  return path.posix.basename(normalizeSeparators(value));
}

function editDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array<number>(cols).fill(0));

  for (let row = 0; row < rows; row += 1) {
    const currentRow = matrix[row];
    if (!currentRow) continue;
    currentRow[0] = row;
  }

  const firstRow = matrix[0];
  if (!firstRow) return 0;
  for (let col = 0; col < cols; col += 1) {
    firstRow[col] = col;
  }

  for (let row = 1; row < rows; row += 1) {
    const currentRow = matrix[row];
    const previousRow = matrix[row - 1];
    if (!currentRow || !previousRow) continue;

    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1;
      const insertCost = (currentRow[col - 1] ?? 0) + 1;
      const deleteCost = (previousRow[col] ?? 0) + 1;
      const replaceCost = (previousRow[col - 1] ?? 0) + cost;
      currentRow[col] = Math.min(deleteCost, insertCost, replaceCost);
    }
  }

  const lastRow = matrix[rows - 1];
  return lastRow?.[cols - 1] ?? 0;
}

async function walkPaths(root: string, current: string, results: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });

  for (const entry of entries) {
    if (DEFAULT_SKIP_NAMES.includes(entry.name as (typeof DEFAULT_SKIP_NAMES)[number])) {
      continue;
    }

    const absolutePath = path.join(current, entry.name);
    if (!isWithinRoot(absolutePath, root)) continue;

    const relative = normalizeRelative(root, absolutePath);
    results.push(relative);

    if (entry.isDirectory()) {
      await walkPaths(root, absolutePath, results);
    }
  }
}

function scoreCandidate(candidate: string, requested: string): number {
  const requestedLower = normalizeSeparators(requested).toLowerCase();
  const candidateLower = candidate.toLowerCase();
  const requestedBase = basenameFor(requestedLower);
  const candidateBase = basenameFor(candidateLower);

  if (candidateBase === requestedBase) return 0;
  if (candidateLower === requestedLower) return 1;
  if (candidateBase.startsWith(requestedBase) || candidateLower.startsWith(requestedLower)) return 2;

  const baseDistance = editDistance(candidateBase, requestedBase);
  const fullDistance = editDistance(candidateLower, requestedLower);
  const distance = Math.min(baseDistance, fullDistance);
  if (distance <= 2) return 3 + distance;

  return Number.POSITIVE_INFINITY;
}

async function suggestPaths(requestedPath: string, root: string): Promise<string[]> {
  const normalizedRequestedPath = normalizeSeparators(requestedPath);
  const candidates: string[] = [];
  await walkPaths(root, root, candidates);

  return candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, normalizedRequestedPath) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      if (left.candidate.length !== right.candidate.length) return left.candidate.length - right.candidate.length;
      return left.candidate.localeCompare(right.candidate);
    })
    .slice(0, 3)
    .map((entry) => entry.candidate);
}

function determinePathKind(stats: Awaited<ReturnType<typeof stat>>): PathKind {
  return stats.isDirectory() ? "directory" : "file";
}

export async function validatePath(requestedPath: string | undefined, root: string): Promise<PathValidationResult> {
  if (!requestedPath || requestedPath.trim() === "" || requestedPath === ".") {
    return { valid: true, resolved: ".", kind: "directory" };
  }

  const normalizedRequestedPath = normalizeRequestedPath(requestedPath);
  const absolutePath = path.resolve(root, normalizedRequestedPath);
  if (!isWithinRoot(absolutePath, root)) {
    return { valid: false, suggestions: [] };
  }

  try {
    const stats = await stat(absolutePath);
    return {
      valid: true,
      resolved: normalizeRelative(root, absolutePath),
      kind: determinePathKind(stats),
    };
  } catch {
    return {
      valid: false,
      suggestions: await suggestPaths(normalizedRequestedPath, root),
    };
  }
}
