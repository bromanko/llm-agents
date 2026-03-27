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
