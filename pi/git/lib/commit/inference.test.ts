import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommitPrompt,
  runModelInferenceDetailed,
  setCompleteFn,
} from "./inference.ts";

const model = {
  provider: "openai-codex",
  id: "gpt-5.4",
  name: "GPT-5.4",
};

test("runModelInferenceDetailed: preserves raw response when no text block is returned", async () => {
  setCompleteFn(async () => ({
    content: [{ type: "reasoning", text: "hidden" }],
  }));

  const result = await runModelInferenceDetailed(
    {
      modelRegistry: {
        find: () => ({ provider: model.provider, id: model.id }),
        getApiKey: async () => "fake-key",
      },
    },
    model,
    "test prompt",
  );

  assert.equal(result.text, null);
  assert.equal(result.error, undefined);
  assert.deepStrictEqual(result.rawResponse, {
    content: [{ type: "reasoning", text: "hidden" }],
  });

  setCompleteFn(undefined);
});

test("runModelInferenceDetailed: preserves thrown error message", async () => {
  setCompleteFn(async () => {
    throw new Error("provider exploded");
  });

  const result = await runModelInferenceDetailed(
    {
      modelRegistry: {
        find: () => ({ provider: model.provider, id: model.id }),
        getApiKey: async () => "fake-key",
      },
    },
    model,
    "test prompt",
  );

  assert.equal(result.text, null);
  assert.equal(result.error, "provider exploded");
  assert.equal(result.rawResponse, undefined);

  setCompleteFn(undefined);
});

test("buildCommitPrompt: truncates large diffs and includes a note", () => {
  const prompt = buildCommitPrompt({
    snapshot: {
      stat: "1 file changed",
      diff: `diff --git a/a b/a\n${"x".repeat(20_000)}`,
      files: [
        {
          path: "src/a.ts",
          kind: "modified",
          isBinary: false,
          patch: "",
          splitAllowed: true,
          hunks: [
            {
              index: 0,
              header: "@@ -1,1 +1,1 @@",
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              content: "@@ -1,1 +1,1 @@",
            },
          ],
        },
      ],
    },
  });

  assert.match(prompt, /Diff truncated to 15000 characters out of 2001\d/);
  assert.ok(prompt.length < 18_000);
});
