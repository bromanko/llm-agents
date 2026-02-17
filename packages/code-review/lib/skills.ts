/**
 * Discovers review skills by scanning the shared skills directory.
 *
 * Skills follow the naming convention: `{language}-{type}-review`
 * e.g. gleam-code-review, fsharp-security-review
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface ReviewSkill {
  /** e.g. "gleam-code-review" */
  name: string;
  /** e.g. "gleam" */
  language: string;
  /** e.g. "code" */
  type: string;
  /** Absolute path to SKILL.md */
  path: string;
}

/**
 * Scan the shared skills directory for review skills.
 */
export function discoverReviewSkills(skillsDirs: string[]): ReviewSkill[] {
  const skills: ReviewSkill[] = [];

  for (const dir of skillsDirs) {
    if (!fs.existsSync(dir)) continue;

    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const match = entry.name.match(/^(.+)-(code|security|performance|test)-review$/);
      if (!match) continue;

      const skillPath = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;

      skills.push({
        name: entry.name,
        language: match[1],
        type: match[2],
        path: skillPath,
      });
    }
  }

  return skills;
}

/**
 * Get unique languages that have review skills.
 */
export function getLanguages(skills: ReviewSkill[]): string[] {
  return [...new Set(skills.map((s) => s.language))].sort();
}

/**
 * Get available review types for a language.
 */
export function getTypesForLanguage(
  skills: ReviewSkill[],
  language: string,
): string[] {
  return skills
    .filter((s) => s.language === language)
    .map((s) => s.type)
    .sort();
}

/**
 * Filter skills by language and optional type filter.
 */
export function filterSkills(
  skills: ReviewSkill[],
  language: string,
  types?: string[],
): ReviewSkill[] {
  return skills.filter(
    (s) => s.language === language && (!types || types.includes(s.type)),
  );
}

/**
 * File extensions considered relevant for each review language.
 * Used to filter diffs so that only matching files are sent to the LLM.
 */
const LANGUAGE_EXTENSIONS: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  fsharp: [".fs", ".fsx"],
  gleam: [".gleam"],
  elm: [".elm"],
};

/**
 * Return the file extensions associated with a review language,
 * or undefined if the language has no known extension list (i.e. no filtering).
 */
export function getLanguageExtensions(language: string): string[] | undefined {
  return LANGUAGE_EXTENSIONS[language];
}

/**
 * Filter a unified diff (git format) to only include entries whose file path
 * ends with one of the given extensions.
 *
 * Each diff entry starts with a line matching `diff --git a/... b/...`.
 * We split on those boundaries and keep only matching sections.
 *
 * Returns the filtered diff string, or null if nothing remains.
 */
export function filterDiffByExtensions(
  diff: string,
  extensions: string[],
): string | null {
  // Split the diff into per-file sections.
  // Each section starts with "diff --git …"
  const sections: string[] = [];
  let current = "";

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current) sections.push(current);
      current = line + "\n";
    } else {
      current += line + "\n";
    }
  }
  if (current) sections.push(current);

  const kept = sections.filter((section) => {
    // Extract the b-side path from the header: diff --git a/foo b/bar
    const match = section.match(/^diff --git a\/.+ b\/(.+)/);
    if (!match) return false;
    const filePath = match[1];
    return extensions.some((ext) => filePath.endsWith(ext));
  });

  if (kept.length === 0) return null;

  // Re-join, trimming any trailing whitespace from the split
  return kept.join("").trimEnd() + "\n";
}

/**
 * Known skills directories relative to the repository root.
 * We resolve from the extension's own location.
 */
export function getSkillsDirs(): string[] {
  // Navigate from this file to the shared skills directory
  const sharedSkills = path.resolve(__dirname, "../../../shared/skills");
  const globalSkills = path.join(
    process.env.HOME || "~",
    ".pi/agent/skills",
  );

  const dirs: string[] = [];
  if (fs.existsSync(sharedSkills)) dirs.push(sharedSkills);
  if (fs.existsSync(globalSkills)) dirs.push(globalSkills);
  return dirs;
}
