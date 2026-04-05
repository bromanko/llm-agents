import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { DEFAULT_SKIP_NAMES } from "./constants.ts";
import type { MultiPathValidationResult, PathKind, PathValidationResult, SinglePathValidator } from "./types.ts";

function normalizeSeparators(value: string): string {
  return value.replace(/[\\/]+/g, "/");
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return homedir() + value.slice(1);
  return value;
}

function normalizeRequestedPath(requestedPath: string): string {
  return expandHome(requestedPath).replace(/[\\/]+/g, path.sep);
}

function usesHomePrefix(requestedPath: string): boolean {
  return requestedPath === "~" || requestedPath.startsWith("~/") || requestedPath.startsWith("~\\");
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

function rankSuggestions(candidates: string[], requestedPath: string): string[] {
  const normalizedRequestedPath = normalizeSeparators(requestedPath);

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

async function suggestPaths(requestedPath: string, root: string): Promise<string[]> {
  const candidates: string[] = [];
  await walkPaths(root, root, candidates);
  return rankSuggestions(candidates, requestedPath);
}

function formatExternalSuggestion(requestedPath: string, root: string, absolutePath: string): string {
  if (usesHomePrefix(requestedPath)) {
    const relativeToHome = path.relative(homedir(), absolutePath);
    return relativeToHome ? `~/${normalizeSeparators(relativeToHome)}` : "~";
  }

  const normalizedRequestedPath = normalizeRequestedPath(requestedPath);
  if (path.isAbsolute(normalizedRequestedPath)) {
    return normalizeSeparators(absolutePath);
  }

  return normalizeRelative(root, absolutePath);
}

async function suggestExternalPaths(requestedPath: string, absolutePath: string, root: string): Promise<string[]> {
  const parentDirectory = path.dirname(absolutePath);

  try {
    const entries = await readdir(parentDirectory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => !DEFAULT_SKIP_NAMES.includes(entry.name as (typeof DEFAULT_SKIP_NAMES)[number]))
      .map((entry) => formatExternalSuggestion(requestedPath, root, path.join(parentDirectory, entry.name)));

    return rankSuggestions(candidates, requestedPath);
  } catch {
    return [];
  }
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
  const withinRoot = isWithinRoot(absolutePath, root);

  try {
    const stats = await stat(absolutePath);
    // For paths within root, return a relative resolved path.
    // For paths outside root (e.g. absolute paths to other directories),
    // return the absolute path so rg can find them.
    const resolved = withinRoot
      ? normalizeRelative(root, absolutePath)
      : normalizeSeparators(absolutePath);
    return {
      valid: true,
      resolved,
      kind: determinePathKind(stats),
    };
  } catch {
    const suggestions = withinRoot
      ? await suggestPaths(normalizedRequestedPath, root)
      : await suggestExternalPaths(requestedPath, absolutePath, root);
    return {
      valid: false,
      suggestions,
    };
  }
}

const MAX_SEARCH_PATHS = 20;

/**
 * Normalize a path input (string, string[], or undefined) into an array of
 * raw path strings.  Returns `["."]` for absent/empty input.
 */
function normalizePaths(input: string | string[] | undefined): string[] {
  if (input == null || input === "") return ["."];
  if (typeof input === "string") return [input];
  const filtered = input.filter((p) => p !== "");
  if (filtered.length === 0) return ["."];
  return filtered;
}

/**
 * Validate one or more search paths.  Every path must pass `validatePath`;
 * the first failure (in input order) is reported.
 */
export async function validatePaths(
  pathInput: string | string[] | undefined,
  root: string,
  singleValidator: SinglePathValidator = validatePath,
): Promise<MultiPathValidationResult> {
  const raw = normalizePaths(pathInput);

  if (raw.length > MAX_SEARCH_PATHS) {
    return {
      valid: false,
      failedPath: `<${raw.length} paths>`,
      suggestions: [],
    };
  }

  // Fire all validations concurrently
  const results = await Promise.all(raw.map((p) => singleValidator(p, root)));

  const resolved: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (!result.valid) {
      return { valid: false, failedPath: raw[i], suggestions: result.suggestions };
    }
    resolved.push(result.resolved);
  }

  return { valid: true, resolved };
}
