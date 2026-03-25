/**
 * Shared types for git-commit.
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

export interface CommitCommandArgs {
  dryRun: boolean;
  push: boolean;
  context?: string;
}

export interface ConventionalDetail {
  text: string;
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

export interface DiffHunk {
  index: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
}

export type FileChangeKind = "modified" | "added" | "deleted" | "renamed";

export type HunkSelector =
  | { type: "all" }
  | { type: "indices"; indices: number[] };

export interface FileChange {
  path: string;
  hunks: HunkSelector;
}

export interface SplitCommitGroup {
  changes: FileChange[];
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
}

export interface SnapshotFile {
  path: string;
  kind: FileChangeKind;
  isBinary: boolean;
  patch: string;
  hunks: DiffHunk[];
  splitAllowed: boolean;
}

export interface CommitSnapshot {
  files: SnapshotFile[];
  stat: string;
  diff: string;
}
