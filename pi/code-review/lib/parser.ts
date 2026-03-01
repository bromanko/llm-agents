/**
 * Parses review findings from LLM output.
 *
 * We prefer strict markdown format, but tolerate common variants:
 * - Different heading levels/bullets (`### [HIGH]`, `## HIGH: ...`, `- [medium] ...`)
 * - Bold or plain field labels (`**Issue:**` / `Issue:`)
 * - Synonyms for fields (`Recommendation`, `Fix`, `Path`, etc.)
 */

export type Severity = "HIGH" | "MEDIUM" | "LOW";
export type Effort = "trivial" | "small" | "medium" | "large";

export interface Finding {
  severity: Severity;
  title: string;
  file: string | undefined;
  category: string | undefined;
  issue: string;
  suggestion: string;
  effort: Effort | undefined;
  /** Which skill produced this finding */
  skill: string;
}

type Heading = {
  index: number;
  severity: Severity | undefined;
  title: string | undefined;
};

const FIELD_NAMES = {
  file: ["file", "path", "location"],
  category: ["category", "type"],
  issue: ["issue", "problem", "risk"],
  suggestion: ["suggestion", "recommendation", "fix", "remediation"],
  effort: ["effort", "complexity"],
  severity: ["severity", "priority"],
  title: ["title", "name"],
} as const;

const ALL_FIELD_LABELS = Object.values(FIELD_NAMES).flat();

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripMarkdownNoise(value: string): string {
  return value
    .replace(/^`+|`+$/g, "")
    .replace(/^\*+|\*+$/g, "")
    .trim();
}

function normalizeSeverity(value: string | undefined): Severity | undefined {
  if (!value) return undefined;

  const normalized = value.trim().toLowerCase();
  if (["high", "critical", "sev1", "p0", "p1"].includes(normalized)) {
    return "HIGH";
  }
  if (["medium", "med", "warning", "warn", "sev2", "p2"].includes(normalized)) {
    return "MEDIUM";
  }
  if (["low", "info", "informational", "minor", "sev3", "p3"].includes(normalized)) {
    return "LOW";
  }

  return undefined;
}

function normalizeEffort(value: string | undefined): Effort | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "trivial" || normalized === "small" || normalized === "medium" || normalized === "large") {
    return normalized;
  }
  return undefined;
}

function extractInlineField(block: string, fieldNames: readonly string[]): string | undefined {
  const labels = fieldNames.map(escapeRegExp).join("|");
  const regex = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${labels})(?:\\*\\*)?\\s*:\\s*([^\\n]+)`,
    "i",
  );

  const match = block.match(regex);
  return match?.[1] ? stripMarkdownNoise(match[1]) : undefined;
}

function extractMultiLineField(block: string, fieldNames: readonly string[]): string | undefined {
  const labels = fieldNames.map(escapeRegExp).join("|");
  const allLabels = ALL_FIELD_LABELS.map(escapeRegExp).join("|");
  // Use [^\S\n]* (horizontal whitespace only) instead of \s* after the colon
  // so that a trailing newline is NOT consumed.  Consuming it would prevent the
  // lookahead from finding the "\n<NextField>:" boundary, causing the next
  // field's name to leak into this field's captured content when the field
  // value is empty (e.g. "Issue:\nSuggestion:").
  const regex = new RegExp(
    `(?:^|\\n)\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${labels})(?:\\*\\*)?\\s*:[^\\S\\n]*([\\s\\S]*?)(?=\\n\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${allLabels})(?:\\*\\*)?\\s*:|\\n\\s*---+\\s*$|$)`,
    "i",
  );

  const match = block.match(regex);
  if (!match?.[1]) return undefined;

  const cleaned = match[1]
    .split("\n")
    // Strip leading bullet markers (-, *, or numbered list like 1.) so that
    // multi-line field values are clean plain text regardless of how the LLM
    // formats its output.
    .map((line) => line.replace(/^\s*(?:\d+\.|[-*])\s?/, "").trimEnd())
    .join("\n")
    .trim();

  return cleaned ? stripMarkdownNoise(cleaned) : undefined;
}

function isFieldLikeTitle(value: string): boolean {
  return /^(file|path|location|issue|problem|risk|suggestion|recommendation|fix|remediation|effort|complexity|category|type|severity|priority|summary)\b/i.test(
    value.trim(),
  );
}

function firstMeaningfulLine(block: string): string | undefined {
  const line = block
    .split("\n")
    .map((l) => l.trim())
    .find((l) => {
      if (!l) return false;
      if (/^#{1,6}\s+findings?\b/i.test(l)) return false;
      if (/^[-*_`]{3,}$/.test(l)) return false;
      if (isFieldLikeTitle(l)) return false;
      return true;
    });

  return line ? line.replace(/^#{1,6}\s*/, "") : undefined;
}

function findHeadingStarts(text: string): Heading[] {
  const starts: Heading[] = [];

  // Strict format: ### [HIGH] Title
  const strictPattern = /(?:^|\n)#{2,6}\s*\[(HIGH|MEDIUM|LOW|CRITICAL|WARNING|INFO)\]\s*(.+)/gi;
  let strictMatch: RegExpExecArray | null;
  while ((strictMatch = strictPattern.exec(text)) !== null) {
    starts.push({
      index: strictMatch.index,
      severity: normalizeSeverity(strictMatch[1]),
      title: stripMarkdownNoise(strictMatch[2] ?? ""),
    });
  }

  // Flexible heading style: ## HIGH: Title / - [high] Title
  const flexiblePattern = /(?:^|\n)\s*(?:#{1,6}\s*|[-*]\s*)(?:\[?(HIGH|MEDIUM|LOW|CRITICAL|WARNING|INFO)\]?\s*[:\-–]\s*|\[(HIGH|MEDIUM|LOW|CRITICAL|WARNING|INFO)\]\s*)(.+)/gi;
  let flexMatch: RegExpExecArray | null;
  while ((flexMatch = flexiblePattern.exec(text)) !== null) {
    const sev = flexMatch[1] || flexMatch[2];
    const title = stripMarkdownNoise(flexMatch[3] ?? "");

    if (!title || isFieldLikeTitle(title)) continue;

    starts.push({
      index: flexMatch.index,
      severity: normalizeSeverity(sev),
      title,
    });
  }

  // Deduplicate by index and sort.
  const byIndex = new Map<number, Heading>();
  for (const start of starts) {
    if (!byIndex.has(start.index)) {
      byIndex.set(start.index, start);
    }
  }

  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Parse the LLM's review output into structured findings.
 */
export function parseFindings(text: string, skill: string): Finding[] {
  const findings: Finding[] = [];
  const starts = findHeadingStarts(text);

  const blocks: Array<{ heading: Heading | undefined; block: string }> = [];

  if (starts.length > 0) {
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i];
      const nextIndex = starts[i + 1]?.index ?? text.length;
      blocks.push({
        heading: start,
        block: text.slice(start.index, nextIndex),
      });
    }
  } else {
    // No recognizable headings — still try to parse one block if it looks structured.
    if (/(?:^|\n)\s*(?:\*\*)?(?:issue|problem|risk)(?:\*\*)?\s*:/i.test(text) ||
        /(?:^|\n)\s*(?:\*\*)?(?:suggestion|recommendation|fix|remediation)(?:\*\*)?\s*:/i.test(text)) {
      blocks.push({ heading: undefined, block: text });
    }
  }

  for (const { heading, block } of blocks) {
    const file = extractInlineField(block, FIELD_NAMES.file);
    const category = extractInlineField(block, FIELD_NAMES.category);
    const issue = extractMultiLineField(block, FIELD_NAMES.issue);
    const suggestion = extractMultiLineField(block, FIELD_NAMES.suggestion);
    const severityField = extractInlineField(block, FIELD_NAMES.severity);
    const effortField = extractInlineField(block, FIELD_NAMES.effort);
    const explicitTitle = extractInlineField(block, FIELD_NAMES.title);

    const severity =
      heading?.severity ?? normalizeSeverity(severityField) ?? "MEDIUM";

    const title =
      heading?.title ?? explicitTitle ?? firstMeaningfulLine(block) ?? "Untitled finding";

    const effort = normalizeEffort(effortField);

    // Require at least some substantive content so we don't create noise findings.
    if (!issue && !suggestion && !file) {
      continue;
    }

    findings.push({
      severity,
      title: stripMarkdownNoise(title),
      file,
      category,
      issue: issue || "(no description)",
      suggestion: suggestion || "(no suggestion)",
      effort,
      skill,
    });
  }

  return findings;
}
