/**
 * Validation rules for commit proposals and split plans.
 *
 * Adapted from oh-my-pi's validation.ts for jj semantics.
 */

import type { CommitProposal, CommitType, ConventionalDetail, SplitCommitGroup, SplitCommitPlan } from "./types.ts";

export const SUMMARY_MAX_CHARS = 72;
export const MAX_DETAIL_ITEMS = 6;

// ---------------------------------------------------------------------------
// Past-tense detection
// ---------------------------------------------------------------------------

const pastTenseVerbs = new Set([
  "added", "adjusted", "aligned", "bumped", "changed", "cleaned", "clarified",
  "consolidated", "converted", "corrected", "created", "deployed", "deprecated",
  "disabled", "documented", "dropped", "enabled", "expanded", "extracted",
  "fixed", "hardened", "implemented", "improved", "integrated", "introduced",
  "migrated", "moved", "optimized", "patched", "prevented", "reduced",
  "refactored", "removed", "renamed", "reorganized", "replaced", "resolved",
  "restored", "restructured", "reworked", "secured", "simplified", "stabilized",
  "standardized", "streamlined", "tightened", "tuned", "updated", "upgraded",
  "validated",
]);

const pastTenseEdExceptions = new Set(["hundred", "red", "bed"]);

function isPastTense(word: string): boolean {
  const normalized = word.toLowerCase().replace(/[^a-z]/g, "");
  if (pastTenseVerbs.has(normalized)) return true;
  if (normalized.endsWith("ed") && !pastTenseEdExceptions.has(normalized)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Summary validation
// ---------------------------------------------------------------------------

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateSummary(summary: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!summary || summary.trim().length === 0) {
    errors.push("Summary must not be empty");
    return { errors, warnings };
  }

  const trimmed = summary.trim();

  if (trimmed.length > SUMMARY_MAX_CHARS) {
    errors.push(`Summary exceeds ${SUMMARY_MAX_CHARS} characters (${trimmed.length})`);
  }

  if (trimmed.endsWith(".")) {
    warnings.push("Summary should not end with a period");
  }

  const words = trimmed.split(/\s+/);
  const firstWord = words[0] ?? "";
  if (!isPastTense(firstWord)) {
    errors.push("Summary must start with a past-tense verb");
  }

  // Check for filler words
  const fillerWords = ["comprehensive", "various", "several", "improved", "enhanced", "better"];
  const lowerSummary = trimmed.toLowerCase();
  for (const word of fillerWords) {
    if (lowerSummary.includes(word)) {
      warnings.push(`Avoid filler word: ${word}`);
    }
  }

  // Check for meta phrases
  const metaPhrases = ["this commit", "this change", "updated code", "modified files"];
  for (const phrase of metaPhrases) {
    if (lowerSummary.includes(phrase)) {
      warnings.push(`Avoid meta phrase: ${phrase}`);
    }
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Scope validation
// ---------------------------------------------------------------------------

export function validateScope(scope: string | null): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (scope === null || scope === "") return { errors, warnings };

  // Scope must be lowercase, max two segments, only letters, digits, hyphens, underscores
  if (!/^[a-z0-9][a-z0-9_-]*(\/?[a-z0-9][a-z0-9_-]*)?$/.test(scope)) {
    errors.push(
      "Scope must be lowercase, max two segments separated by /, " +
      "containing only letters, digits, hyphens, underscores"
    );
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Type-file consistency
// ---------------------------------------------------------------------------

export function validateTypeConsistency(
  type: CommitType,
  files: string[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const lowerFiles = files.map((f) => f.toLowerCase());
  const hasDocs = lowerFiles.some((f) => /\.(md|mdx|adoc|rst)$/.test(f));
  const hasTests = lowerFiles.some(
    (f) => /(^|\/)(test|tests|__tests__)(\/|$)/.test(f) || /(^|\/).*(_test|\.test|\.spec)\./.test(f),
  );
  const hasCI = lowerFiles.some(
    (f) => f.startsWith(".github/workflows/") || f.startsWith(".gitlab-ci"),
  );
  const hasBuild = lowerFiles.some((f) =>
    ["cargo.toml", "package.json", "makefile"].some((c) => f.endsWith(c)),
  );

  switch (type) {
    case "docs":
      if (!hasDocs) errors.push("Docs commit should include documentation file changes");
      break;
    case "test":
      if (!hasTests) errors.push("Test commit should include test file changes");
      break;
    case "ci":
      if (!hasCI) errors.push("CI commit should include CI configuration changes");
      break;
    case "build":
      if (!hasBuild) errors.push("Build commit should include build-related files");
      break;
    default:
      break;
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Detail capping
// ---------------------------------------------------------------------------

export function capDetails(
  details: ConventionalDetail[],
): { details: ConventionalDetail[]; warnings: string[] } {
  if (details.length <= MAX_DETAIL_ITEMS) {
    return { details, warnings: [] };
  }

  // Score-based priority: security > breaking > perf > bug > api > user
  const scored = details.map((detail, index) => ({
    detail,
    index,
    score: scoreDetail(detail.text),
  }));

  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const keep = new Set(scored.slice(0, MAX_DETAIL_ITEMS).map((e) => e.index));
  const kept = details.filter((_d, i) => keep.has(i));
  const warnings = [`Capped detail list to ${MAX_DETAIL_ITEMS} items based on priority scoring.`];
  return { details: kept, warnings };
}

function scoreDetail(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  if (/(security|vulnerability|exploit|cve)/.test(lower)) score += 100;
  if (/(breaking|incompatible)/.test(lower)) score += 90;
  if (/(performance|optimization|optimiz|latency|throughput)/.test(lower)) score += 80;
  if (/(bug|fix|crash|panic|regression|failure)/.test(lower)) score += 70;
  if (/(api|interface|public|export)/.test(lower)) score += 50;
  if (/(user|client|customer)/.test(lower)) score += 40;
  if (/(deprecated|removed|delete)/.test(lower)) score += 35;
  return score;
}

// ---------------------------------------------------------------------------
// Split-plan validation
// ---------------------------------------------------------------------------

export function validateSplitPlan(
  plan: SplitCommitPlan,
  allChangedFiles: string[],
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const usedFiles = new Set<string>();

  for (let i = 0; i < plan.commits.length; i++) {
    const group = plan.commits[i];
    const prefix = `Commit ${i + 1}`;

    // Validate summary
    const summaryResult = validateSummary(group.summary);
    errors.push(...summaryResult.errors.map((e) => `${prefix}: ${e}`));
    warnings.push(...summaryResult.warnings.map((w) => `${prefix}: ${w}`));

    // Validate scope
    const scopeResult = validateScope(group.scope);
    errors.push(...scopeResult.errors.map((e) => `${prefix}: ${e}`));

    // Check for duplicate files within this commit
    const seen = new Set<string>();
    for (const file of group.files) {
      if (seen.has(file)) {
        errors.push(`${prefix}: duplicate file ${file}`);
      }
      seen.add(file);

      // Check for files appearing in multiple commits
      if (usedFiles.has(file)) {
        errors.push(`File appears in multiple commits: ${file}`);
      }
      usedFiles.add(file);
    }

    // Validate dependencies
    for (const dep of group.dependencies) {
      if (dep < 0 || dep >= plan.commits.length) {
        errors.push(`${prefix}: dependency index out of range (${dep})`);
      }
      if (dep === i) {
        errors.push(`${prefix}: cannot depend on itself`);
      }
    }
  }

  // Every changed file must appear exactly once
  for (const file of allChangedFiles) {
    if (!usedFiles.has(file)) {
      errors.push(`Changed file missing from split plan: ${file}`);
    }
  }

  // Check for dependency cycles
  const cycleResult = detectDependencyCycle(plan.commits);
  if (cycleResult) {
    errors.push(cycleResult);
  }

  return { errors, warnings };
}

// ---------------------------------------------------------------------------
// Dependency cycle detection (Kahn's algorithm)
// ---------------------------------------------------------------------------

export function detectDependencyCycle(groups: SplitCommitGroup[]): string | null {
  const total = groups.length;
  const inDegree = new Array<number>(total).fill(0);
  const edges: Set<number>[] = Array.from({ length: total }, () => new Set());

  for (let i = 0; i < total; i++) {
    for (const dep of groups[i].dependencies) {
      if (dep < 0 || dep >= total) continue;
      if (!edges[dep].has(i)) {
        edges[dep].add(i);
        inDegree[i]++;
      }
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < total; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of edges[current]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  if (order.length !== total) {
    return "Circular dependency detected in split commit plan.";
  }
  return null;
}

/**
 * Compute topological order of commits based on their dependencies.
 * Returns ordered indices or an error string.
 */
export function computeDependencyOrder(groups: SplitCommitGroup[]): number[] | { error: string } {
  const total = groups.length;
  const inDegree = new Array<number>(total).fill(0);
  const edges: Set<number>[] = Array.from({ length: total }, () => new Set());

  for (let i = 0; i < total; i++) {
    for (const dep of groups[i].dependencies) {
      if (dep < 0 || dep >= total) {
        return { error: `Invalid dependency index: ${dep}` };
      }
      if (!edges[dep].has(i)) {
        edges[dep].add(i);
        inDegree[i]++;
      }
    }
  }

  const queue: number[] = [];
  for (let i = 0; i < total; i++) {
    if (inDegree[i] === 0) queue.push(i);
  }

  const order: number[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);
    for (const next of edges[current]) {
      inDegree[next]--;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  if (order.length !== total) {
    return { error: "Circular dependency detected in split commit plan." };
  }

  return order;
}
