import type { CommitType, ConventionalDetail } from "./types.ts";

export function formatCommitMessage(
  type: CommitType,
  scope: string | null,
  summary: string,
  details: ConventionalDetail[],
): string {
  const scopePart = scope ? `(${scope})` : "";
  const header = `${type}${scopePart}: ${summary}`;
  const body = details
    .map((detail) => detail.text.trim())
    .filter(Boolean)
    .map((text) => `- ${text}`);

  if (body.length === 0) return header;
  return `${header}\n\n${body.join("\n")}`;
}
