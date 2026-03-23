export interface ParsedCritique {
  verdict: "ACCEPT" | "REJECT";
  summary?: string;
  raw: string;
}

export function parseCritique(text: string): ParsedCritique {
  const verdictMatch = text.match(/^\s*(?:##\s*)?Verdict\s*:\s*(ACCEPT|REJECT)\b/im);
  let verdict: "ACCEPT" | "REJECT" = "REJECT";
  if (verdictMatch) {
    verdict = verdictMatch[1] as "ACCEPT" | "REJECT";
  } else if (/\bACCEPT\b/i.test(text) && !/\bREJECT\b/i.test(text)) {
    verdict = "ACCEPT";
  }

  const summaryMatch = text.match(/^\s*(?:##\s*)?(?:Consensus Summary|Summary)\s*:?\s*([\s\S]+?)$/im);
  const summary = summaryMatch?.[1]?.trim();
  return { verdict, summary, raw: text.trim() };
}

export function composeFinalDesignDocument(params: {
  topic: string;
  briefMarkdown: string;
  finalDraft: string;
  accepted: boolean;
  round: number;
  maxRounds: number;
  lastCritique: string;
  architectA: string;
  architectB: string;
}): string {
  const finalDraft = params.finalDraft.trim();
  const critique = params.lastCritique.trim();
  const header = finalDraft.startsWith("#") ? "" : `# Design: ${params.topic}\n\n`;
  let doc = `${header}${finalDraft}`.trimEnd();
  const outcomeHeading = params.accepted ? "Consensus reached" : "Consensus not fully reached";
  const outcomeText = params.accepted
    ? `Architect B accepted the design in round ${params.round} of ${params.maxRounds}.`
    : `Architect B did not accept the design after ${params.maxRounds} round${params.maxRounds === 1 ? "" : "s"}. The latest draft is preserved below, followed by unresolved disagreement notes.`;

  doc += `\n\n## Debate Outcome\n- ${outcomeHeading}\n- ${outcomeText}\n- Architect A: ${params.architectA}\n- Architect B: ${params.architectB}`;

  if (!params.accepted && critique) {
    doc += `\n\n## Unresolved Disagreements\n\n${critique}`;
  }

  doc += `\n\n## Design Brief Used For Debate\n\n${params.briefMarkdown.trim()}`;
  return doc.trimEnd() + "\n";
}
