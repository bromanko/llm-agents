/**
 * Format a conventional commit message from structured data.
 */

import type { CommitType, ConventionalDetail } from "./types.ts";

export function formatCommitMessage(
  type: CommitType,
  scope: string | null,
  summary: string,
  details: ConventionalDetail[],
): string {
  const scopePart = scope ? `(${scope})` : "";
  const header = `${type}${scopePart}: ${summary}`;
  const bodyLines = details
    .map((d) => (typeof d.text === "string" ? d.text.trim() : ""))
    .filter((text) => text.length > 0)
    .map((text) => `- ${text}`);

  if (bodyLines.length === 0) {
    return header;
  }

  return `${header}\n\n${bodyLines.join("\n")}`;
}
