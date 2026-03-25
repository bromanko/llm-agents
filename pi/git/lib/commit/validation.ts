import type { CommitSnapshot, SplitCommitGroup, SplitCommitPlan } from "./types.ts";

export const SUMMARY_MAX_CHARS = 72;

const pastTenseVerbs = new Set([
  "added", "adjusted", "aligned", "bumped", "changed", "cleaned", "clarified",
  "consolidated", "converted", "corrected", "created", "deprecated", "disabled",
  "documented", "dropped", "enabled", "expanded", "extracted", "fixed", "hardened",
  "implemented", "improved", "integrated", "introduced", "migrated", "moved",
  "optimized", "patched", "prevented", "reduced", "refactored", "removed", "renamed",
  "reorganized", "replaced", "resolved", "restored", "restructured", "reworked",
  "secured", "simplified", "stabilized", "standardized", "streamlined", "tightened",
  "tuned", "updated", "upgraded", "validated",
]);

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

function isPastTense(word: string): boolean {
  const normalized = word.toLowerCase().replace(/[^a-z]/g, "");
  return pastTenseVerbs.has(normalized) || (normalized.endsWith("ed") && normalized.length > 2);
}

export function validateSummary(summary: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const trimmed = summary.trim();

  if (trimmed.length === 0) {
    errors.push("Summary must not be empty");
    return { errors, warnings };
  }
  if (trimmed.length > SUMMARY_MAX_CHARS) {
    errors.push(`Summary exceeds ${SUMMARY_MAX_CHARS} characters (${trimmed.length})`);
  }
  if (trimmed.endsWith(".")) {
    warnings.push("Summary should not end with a period");
  }
  const firstWord = trimmed.split(/\s+/)[0] ?? "";
  if (!isPastTense(firstWord)) {
    errors.push("Summary must start with a past-tense verb");
  }

  return { errors, warnings };
}

export function validateScope(scope: string | null): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (scope === null || scope === "") return { errors, warnings };
  if (!/^[a-z0-9][a-z0-9_-]*(\/?[a-z0-9][a-z0-9_-]*)?$/.test(scope)) {
    errors.push(
      "Scope must be lowercase, max two segments separated by /, containing only letters, digits, hyphens, underscores",
    );
  }

  return { errors, warnings };
}

export function validateSplitPlan(
  plan: SplitCommitPlan,
  snapshot: CommitSnapshot,
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const fileMap = new Map(snapshot.files.map((file) => [file.path, file]));
  const coverage = new Map<string, { usedAll: boolean; seenIndices: Set<number>; allCount: number }>();

  for (let i = 0; i < plan.commits.length; i++) {
    const commit = plan.commits[i];
    const prefix = `Commit ${i + 1}`;

    const summary = validateSummary(commit.summary);
    errors.push(...summary.errors.map((error) => `${prefix}: ${error}`));
    warnings.push(...summary.warnings.map((warning) => `${prefix}: ${warning}`));

    const scope = validateScope(commit.scope);
    errors.push(...scope.errors.map((error) => `${prefix}: ${error}`));

    if (commit.changes.length === 0) {
      errors.push(`${prefix}: must include at least one change`);
    }

    const seenPaths = new Set<string>();
    for (const change of commit.changes) {
      const meta = fileMap.get(change.path);
      if (!meta) {
        errors.push(`${prefix}: unknown changed file ${change.path}`);
        continue;
      }
      if (seenPaths.has(change.path)) {
        errors.push(`${prefix}: duplicate change entry for ${change.path}`);
      }
      seenPaths.add(change.path);

      const entry = coverage.get(change.path) ?? {
        usedAll: false,
        seenIndices: new Set<number>(),
        allCount: 0,
      };
      coverage.set(change.path, entry);

      if (change.hunks.type === "all") {
        if (entry.usedAll || entry.seenIndices.size > 0) {
          errors.push(`${prefix}: ${change.path} overlaps with another selection`);
        }
        entry.usedAll = true;
        entry.allCount += 1;
        continue;
      }

      if (!meta.splitAllowed) {
        errors.push(`${prefix}: ${change.path} cannot be split by hunk; use type=all`);
        continue;
      }
      if (change.hunks.indices.length === 0) {
        errors.push(`${prefix}: ${change.path} must select at least one hunk`);
        continue;
      }

      for (const index of change.hunks.indices) {
        if (!Number.isInteger(index) || index < 1 || index > meta.hunks.length) {
          errors.push(`${prefix}: ${change.path} references invalid hunk ${index}`);
          continue;
        }
        if (entry.seenIndices.has(index) || entry.usedAll) {
          errors.push(`${prefix}: ${change.path} hunk ${index} appears in multiple commits`);
          continue;
        }
        entry.seenIndices.add(index);
      }
    }

    for (const dep of commit.dependencies) {
      if (dep < 0 || dep >= plan.commits.length) {
        errors.push(`${prefix}: dependency index out of range (${dep})`);
      }
      if (dep === i) {
        errors.push(`${prefix}: cannot depend on itself`);
      }
    }
  }

  for (const file of snapshot.files) {
    const entry = coverage.get(file.path);
    if (!entry) {
      errors.push(`Changed file missing from split plan: ${file.path}`);
      continue;
    }

    if (!file.splitAllowed) {
      if (!entry.usedAll || entry.allCount !== 1) {
        errors.push(`Changed file must be committed as a whole exactly once: ${file.path}`);
      }
      continue;
    }

    if (entry.usedAll) {
      if (entry.allCount !== 1 || entry.seenIndices.size > 0) {
        errors.push(`Changed file overlaps whole-file and hunk selections: ${file.path}`);
      }
      continue;
    }

    if (entry.seenIndices.size !== file.hunks.length) {
      errors.push(
        `Changed file does not cover every hunk exactly once: ${file.path} (${entry.seenIndices.size}/${file.hunks.length})`,
      );
    }
  }

  const cycle = detectDependencyCycle(plan.commits);
  if (cycle) errors.push(cycle);

  return { errors, warnings };
}

export function detectDependencyCycle(groups: SplitCommitGroup[]): string | null {
  const result = computeDependencyOrder(groups);
  return "error" in result ? result.error : null;
}

export function computeDependencyOrder(
  groups: SplitCommitGroup[],
): number[] | { error: string } {
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
        inDegree[i] += 1;
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
      inDegree[next] -= 1;
      if (inDegree[next] === 0) queue.push(next);
    }
  }

  if (order.length !== total) {
    return { error: "Circular dependency detected in split commit plan." };
  }

  return order;
}
