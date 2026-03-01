/**
 * Shared types for the jj-commit pipeline.
 */

export type CommitType =
  | "feat"
  | "fix"
  | "refactor"
  | "perf"
  | "docs"
  | "test"
  | "build"
  | "ci"
  | "chore"
  | "style"
  | "revert";

export type ChangelogCategory =
  | "Breaking Changes"
  | "Added"
  | "Changed"
  | "Deprecated"
  | "Removed"
  | "Fixed"
  | "Security";

export const CHANGELOG_CATEGORIES: ChangelogCategory[] = [
  "Breaking Changes",
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
];

export interface ConventionalDetail {
  text: string;
  changelogCategory?: ChangelogCategory;
  userVisible: boolean;
}

export interface CommitProposal {
  type: CommitType;
  scope: string | null;
  summary: string;
  details: ConventionalDetail[];
  issueRefs: string[];
  warnings: string[];
}

export interface SplitCommitGroup {
  files: string[];
  hunks?: { type: "all" } | { type: "indices"; indices: number[] };
  type: CommitType;
  scope: string | null;
  summary: string;
  details: ConventionalDetail[];
  issueRefs: string[];
  dependencies: number[];
}

export interface SplitCommitPlan {
  commits: SplitCommitGroup[];
  warnings: string[];
  mode: "file" | "hunk";
}

export interface CommitCommandArgs {
  dryRun: boolean;
  push: boolean;
  bookmark?: string;
  noChangelog: boolean;
  noAbsorb: boolean;
  context?: string;
}

export interface ChangelogBoundary {
  changelogPath: string;
  files: string[];
}

export interface UnreleasedSection {
  startLine: number;
  endLine: number;
  entries: Record<string, string[]>;
}
