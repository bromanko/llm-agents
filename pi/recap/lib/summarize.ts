type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type SessionEntry = {
  type: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
};

type RecapResponse = {
  content?: unknown;
  output_text?: unknown;
  output?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractTextParts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];

  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts;
}

function extractToolCalls(content: unknown): string[] {
  if (!Array.isArray(content)) return [];

  const calls: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "toolCall" && typeof block.name === "string") {
      const args = block.arguments ?? {};
      // Summarize tool calls concisely
      const argSummary = Object.entries(args)
        .map(([k, v]) => {
          const val = typeof v === "string" ? v : JSON.stringify(v);
          // Truncate long values
          return `${k}=${val.length > 80 ? val.slice(0, 77) + "..." : val}`;
        })
        .join(", ");
      calls.push(`[tool: ${block.name}(${argSummary})]`);
    }
  }
  return calls;
}

function normalizeText(parts: string[]): string | null {
  const text = parts
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/**
 * Extract visible text from completion responses produced by multiple pi-ai
 * provider adapters. Some adapters return `content: [{ type: "text" }]`, while
 * Codex/Responses-style adapters may return `output_text` or nested
 * `output[].content[{ type: "output_text" }]` instead.
 */
export function extractRecapText(response: RecapResponse | null | undefined): string | null {
  if (!response) return null;

  if (typeof response.output_text === "string") {
    const text = normalizeText([response.output_text]);
    if (text) return text;
  }

  if (Array.isArray(response.content)) {
    const parts: string[] = [];
    for (const part of response.content) {
      if (!isRecord(part)) continue;
      const type = part.type;
      if ((type === "text" || type === "output_text") && typeof part.text === "string") {
        parts.push(part.text);
      }
    }
    const text = normalizeText(parts);
    if (text) return text;
  }

  if (Array.isArray(response.output)) {
    const parts: string[] = [];
    for (const item of response.output) {
      if (!isRecord(item)) continue;

      if (typeof item.output_text === "string") {
        parts.push(item.output_text);
      }

      if (!Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (!isRecord(block)) continue;
        const type = block.type;
        if ((type === "text" || type === "output_text") && typeof block.text === "string") {
          parts.push(block.text);
        }
      }
    }
    return normalizeText(parts);
  }

  return null;
}

/**
 * Build a condensed text representation of the conversation for the
 * summarization prompt. We include user messages, assistant text, and
 * tool call summaries but skip raw tool results to keep the context small.
 */
export function buildConversationText(entries: SessionEntry[]): string {
  const sections: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message?.role) continue;

    const role = entry.message.role;
    const lines: string[] = [];

    if (role === "user") {
      const text = extractTextParts(entry.message.content).join("\n").trim();
      if (text) lines.push(`User: ${text}`);
    } else if (role === "assistant") {
      const text = extractTextParts(entry.message.content).join("\n").trim();
      if (text) lines.push(`Assistant: ${text}`);
      lines.push(...extractToolCalls(entry.message.content));
    }

    if (lines.length > 0) sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

const RECAP_SYSTEM_PROMPT = `You produce concise session recaps to help a developer remember what they were working on. Your output is markdown, kept short and scannable.

Format:
# <short title of what this session is about>

**Goal:** <one sentence describing what the user is trying to accomplish>

**Progress:**
- <key thing done>
- <key thing done>

**Where I left off:** <what was happening most recently, 1-2 sentences>

**Next likely step:** <what the user probably wants to do next>

Rules:
- Be concise. The entire recap should be 8-15 lines max.
- Use specific file names, function names, and technical details — not vague summaries.
- If the conversation is very short (1-2 exchanges), keep the recap proportionally brief.
- Do not include preamble or meta-commentary. Output the recap directly.`;

export function buildRecapPrompt(conversationText: string): string {
  return [
    "Summarize this session so I can quickly remember what I was working on.",
    "",
    "<conversation>",
    conversationText,
    "</conversation>",
  ].join("\n");
}

export { RECAP_SYSTEM_PROMPT };
