/**
 * Deterministic fallback proposal generation.
 *
 * Used when all model resolution paths fail — produces a reasonable commit
 * proposal based purely on file names and extensions.
 */

import * as path from "node:path";
import type { CommitProposal, CommitType } from "./types.ts";
import { SUMMARY_MAX_CHARS } from "./validation.ts";

const TEST_PATTERNS = ["/test/", "/tests/", "/__tests__/", "_test.", ".test.", ".spec.", "_spec."];
const DOC_EXTENSIONS = new Set([".md", ".txt", ".rst", ".adoc"]);
const CONFIG_EXTENSIONS = new Set([".json", ".yaml", ".yml", ".toml", ".xml", ".ini", ".cfg"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss", ".less", ".sass"]);

function getExtension(filePath: string): string {
  const name = path.basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function inferTypeFromFiles(files: string[]): CommitType {
  if (files.length === 0) return "chore";

  let hasTests = false;
  let hasDocs = false;
  let hasConfig = false;
  let hasStyle = false;
  let hasSource = false;

  for (const f of files) {
    const lower = f.toLowerCase();
    const ext = getExtension(f);

    if (TEST_PATTERNS.some((p) => lower.includes(p))) {
      hasTests = true;
    } else if (DOC_EXTENSIONS.has(ext)) {
      hasDocs = true;
    } else if (CONFIG_EXTENSIONS.has(ext)) {
      hasConfig = true;
    } else if (STYLE_EXTENSIONS.has(ext)) {
      hasStyle = true;
    } else {
      hasSource = true;
    }
  }

  if (hasTests && !hasSource && !hasDocs) return "test";
  if (hasDocs && !hasSource && !hasTests) return "docs";
  if (hasStyle && !hasSource && !hasTests) return "style";
  if (hasConfig && !hasSource && !hasTests && !hasDocs) return "chore";
  return "refactor";
}

export function generateFallbackProposal(files: string[]): CommitProposal {
  const type = inferTypeFromFiles(files);

  const verbMap: Record<string, string> = {
    test: "updated tests for",
    docs: "updated documentation for",
    refactor: "refactored",
    style: "formatted",
    chore: "updated",
    feat: "updated",
    fix: "updated",
    perf: "updated",
    build: "updated",
    ci: "updated",
    revert: "reverted changes in",
  };
  const verb = verbMap[type] ?? "updated";
  const file = path.basename(files[0] ?? "files");

  const truncate = (text: string, maxLen: number): string => {
    if (maxLen <= 0) return "";
    if (text.length <= maxLen) return text;
    if (maxLen <= 3) return text.slice(0, maxLen);
    return `${text.slice(0, maxLen - 3)}...`;
  };

  let summary: string;
  if (files.length === 1) {
    const maxFileLen = SUMMARY_MAX_CHARS - (verb.length + 1);
    summary = `${verb} ${truncate(file, maxFileLen)}`.trim();
  } else {
    const otherCount = files.length - 1;
    const suffix = ` and ${otherCount} other${files.length === 2 ? "" : "s"}`;
    const maxFileLen = SUMMARY_MAX_CHARS - (verb.length + 1 + suffix.length);
    if (maxFileLen < 4) {
      summary = `${verb} ${files.length} files`;
    } else {
      summary = `${verb} ${truncate(file, maxFileLen)}${suffix}`;
    }
  }

  const details = files.slice(0, 3).map((f) => ({
    text: `Updated ${path.basename(f)}`,
    userVisible: false,
  }));

  return {
    type,
    scope: null,
    summary,
    details,
    issueRefs: [],
    warnings: ["Commit generated using deterministic fallback (no model available)"],
  };
}
