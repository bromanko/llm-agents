import type { ResultEnvelope } from "./types.ts";

export type { ResultEnvelope } from "./types.ts";

export function formatResultEnvelope(envelope: ResultEnvelope): string {
  const lines: string[] = [];
  lines.push(`Mode: ${envelope.mode} | Scope: ${envelope.scope}`);

  if (envelope.items.length > 0) {
    lines.push(...envelope.items);
  }

  if (envelope.summaryLine) {
    lines.push(envelope.summaryLine);
    return lines.join("\n");
  }

  if (envelope.totalCount === 0) {
    lines.push("0 results.");
    return lines.join("\n");
  }

  const offset = envelope.offset ?? 0;
  if (envelope.items.length === 0 && offset > 0) {
    lines.push(`No results on this page. Offset=${offset} is past the end of ${envelope.totalCount} total results.`);
    return lines.join("\n");
  }

  if (envelope.truncated && envelope.nextOffset != null) {
    const start = offset + 1;
    const end = offset + envelope.items.length;
    lines.push(`Showing ${start}–${end} of ${envelope.totalCount} results. Use offset=${envelope.nextOffset} to continue.`);
    return lines.join("\n");
  }

  lines.push(`${envelope.totalCount} results.`);
  return lines.join("\n");
}
