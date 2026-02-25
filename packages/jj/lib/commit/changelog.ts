/**
 * Changelog detection and application for jj-commit.
 *
 * Key constraint: NEVER create new CHANGELOG.md files.
 * Only discover and update existing ones.
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChangelogBoundary, ChangelogCategory, UnreleasedSection } from "./types.ts";
import { CHANGELOG_CATEGORIES } from "./types.ts";

const CHANGELOG_NAME = "CHANGELOG.md";
const UNRELEASED_PATTERN = /^##\s+\[?Unreleased\]?/i;
const SECTION_PATTERN = /^###\s+(.*)$/;

// ---------------------------------------------------------------------------
// Discovery: find nearest existing CHANGELOG.md for each changed file
// ---------------------------------------------------------------------------

/**
 * For each changed file, walk up from its directory to `cwd` looking for a
 * CHANGELOG.md. Returns changelog paths grouped with the files they cover.
 *
 * Never creates new files. If no CHANGELOG.md is found for a file, that file
 * is silently excluded.
 */
export async function detectChangelogBoundaries(
  cwd: string,
  changedFiles: string[],
): Promise<ChangelogBoundary[]> {
  const boundaries = new Map<string, string[]>();

  for (const file of changedFiles) {
    // Skip changelog files themselves
    if (file.toLowerCase().endsWith("changelog.md")) continue;

    const changelogPath = await findNearestChangelog(cwd, file);
    if (!changelogPath) continue;

    const list = boundaries.get(changelogPath) ?? [];
    list.push(file);
    boundaries.set(changelogPath, list);
  }

  return Array.from(boundaries.entries()).map(([changelogPath, files]) => ({
    changelogPath,
    files,
  }));
}

async function findNearestChangelog(cwd: string, filePath: string): Promise<string | null> {
  let current = path.resolve(cwd, path.dirname(filePath));
  const root = path.resolve(cwd);

  while (true) {
    const candidate = path.resolve(current, CHANGELOG_NAME);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Not found, keep walking
    }
    if (current === root) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

// ---------------------------------------------------------------------------
// Parsing: extract [Unreleased] section from a CHANGELOG.md
// ---------------------------------------------------------------------------

export function parseUnreleasedSection(content: string): UnreleasedSection;
export function parseUnreleasedSection(lines: string[]): UnreleasedSection;
export function parseUnreleasedSection(contentOrLines: string | string[]): UnreleasedSection {
  const lines = Array.isArray(contentOrLines)
    ? contentOrLines
    : contentOrLines.split("\n");
  const startIndex = lines.findIndex((line) => UNRELEASED_PATTERN.test(line.trim()));
  if (startIndex === -1) {
    throw new Error("No [Unreleased] section found in changelog");
  }

  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    if (lines[i]?.startsWith("## ")) {
      endIndex = i;
      break;
    }
  }

  const entries: Record<string, string[]> = {};
  let currentSection: string | null = null;

  for (let i = startIndex + 1; i < endIndex; i++) {
    const line = lines[i] ?? "";
    const sectionMatch = line.match(SECTION_PATTERN);
    if (sectionMatch) {
      currentSection = sectionMatch[1]?.trim() || null;
      if (currentSection) {
        entries[currentSection] = entries[currentSection] ?? [];
      }
      continue;
    }

    if (!currentSection) continue;
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    const entry = trimmed.replace(/^[-*]\s*/, "");
    if (entry) {
      entries[currentSection]?.push(entry);
    }
  }

  return { startLine: startIndex, endLine: endIndex, entries };
}

// ---------------------------------------------------------------------------
// Application: merge new entries under [Unreleased]
// ---------------------------------------------------------------------------

export function applyChangelogEntries(
  content: string,
  unreleased: UnreleasedSection,
  newEntries: Record<string, string[]>,
): string;
export function applyChangelogEntries(
  lines: string[],
  unreleased: UnreleasedSection,
  newEntries: Record<string, string[]>,
): string;
export function applyChangelogEntries(
  contentOrLines: string | string[],
  unreleased: UnreleasedSection,
  newEntries: Record<string, string[]>,
): string {
  const lines = Array.isArray(contentOrLines)
    ? contentOrLines
    : contentOrLines.split("\n");
  const before = lines.slice(0, unreleased.startLine + 1);
  const after = lines.slice(unreleased.endLine);

  const merged = mergeEntries(unreleased.entries, newEntries);
  const sectionLines = renderUnreleasedSections(merged);

  return [...before, ...sectionLines, ...after].join("\n");
}

function mergeEntries(
  existing: Record<string, string[]>,
  incoming: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...existing };
  for (const [section, items] of Object.entries(incoming)) {
    const current = merged[section] ?? [];
    const lowerSet = new Set(current.map((item) => item.toLowerCase()));
    for (const item of items) {
      if (!lowerSet.has(item.toLowerCase())) {
        current.push(item);
      }
    }
    merged[section] = current;
  }
  return merged;
}

function renderUnreleasedSections(entries: Record<string, string[]>): string[] {
  const lines: string[] = [""];
  for (const section of CHANGELOG_CATEGORIES) {
    const items = entries[section] ?? [];
    if (items.length === 0) continue;
    lines.push(`### ${section}`);
    for (const item of items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
