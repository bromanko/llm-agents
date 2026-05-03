import test from "node:test";
import assert from "node:assert/strict";

import {
  buildConversationText,
  extractRecapText,
} from "./summarize.ts";

test("buildConversationText includes user, assistant, and tool-call summaries", () => {
  const conversation = buildConversationText([
    {
      type: "message",
      message: {
        role: "user",
        content: "please inspect recap",
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "I will look at the extension." },
          { type: "toolCall", name: "read", arguments: { path: "pi/recap/extensions/recap.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        content: [{ type: "text", text: "raw tool output should be skipped" }],
      },
    },
  ]);

  assert.equal(
    conversation,
    "User: please inspect recap\n\nAssistant: I will look at the extension.\n[tool: read(path=pi/recap/extensions/recap.ts)]",
  );
});

test("extractRecapText reads top-level output_text responses", () => {
  assert.equal(
    extractRecapText({ output_text: "\n# Recap\n\nDone.\n" }),
    "# Recap\n\nDone.",
  );
});

test("extractRecapText reads nested Responses API output text", () => {
  const response = {
    output: [
      { type: "reasoning" },
      {
        type: "message",
        content: [
          { type: "output_text", text: "# Recap" },
          { type: "output_text", text: "Next step." },
        ],
      },
    ],
  };

  assert.equal(extractRecapText(response), "# Recap\nNext step.");
});

test("extractRecapText falls back to content text blocks", () => {
  assert.equal(
    extractRecapText({
      content: [
        { type: "thinking", text: "hidden" },
        { type: "text", text: "visible" },
      ],
    }),
    "visible",
  );
});

test("extractRecapText returns null when no visible text exists", () => {
  assert.equal(extractRecapText({ content: [{ type: "thinking", text: "hidden" }] }), null);
});
