import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCommitPrompt,
  runModelInferenceDetailed,
  setCompleteFn,
  _testHelpers,
} from "./inference.ts";

const model = {
  provider: "openai-codex",
  id: "gpt-5.4",
  name: "GPT-5.4",
};

const {
  resolveApiKey,
  resolveRequestAuth,
  buildCompleteOptions,
  extractFirstTextBlock,
} = _testHelpers;

test("extractFirstTextBlock: returns output_text when present", () => {
  assert.equal(extractFirstTextBlock({ output_text: "ok" } as any), "ok");
});

test("extractFirstTextBlock: returns text from responses output messages", () => {
  const response = {
    output: [
      { type: "reasoning" },
      { type: "message", content: [{ type: "output_text", text: "ok" }] },
    ],
  } as any;

  assert.equal(extractFirstTextBlock(response), "ok");
});

test("resolveRequestAuth: prefers getApiKeyAndHeaders when available", async () => {
  const auth = await resolveRequestAuth(
    {
      modelRegistry: {
        find: () => ({ provider: model.provider, id: model.id }),
        getApiKey: async () => {
          throw new Error("should not call getApiKey when headers are available");
        },
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          headers: { Authorization: "Bearer token" },
        }),
      },
    },
    { provider: model.provider, id: model.id },
  );

  assert.deepStrictEqual(auth, {
    apiKey: undefined,
    headers: { Authorization: "Bearer token" },
  });
});

test("buildCompleteOptions: omits temperature for openai-codex", () => {
  const options = buildCompleteOptions(model, { headers: { Authorization: "Bearer token" } });
  assert.deepStrictEqual(options, {
    apiKey: undefined,
    headers: { Authorization: "Bearer token" },
    maxTokens: 4096,
  });
});

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

test("runModelInferenceDetailed: includes a system prompt and codex-safe options", async () => {
  let capturedContext: any;
  let capturedOptions: any;

  setCompleteFn(async (_resolvedModel, context, options) => {
    capturedContext = context;
    capturedOptions = options;
    return { output_text: '{"type":"single"}' };
  });

  const result = await runModelInferenceDetailed(
    {
      modelRegistry: {
        find: () => ({ provider: model.provider, id: model.id }),
        getApiKey: async () => undefined,
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          headers: { Authorization: "Bearer token" },
        }),
      },
    },
    model,
    "test prompt",
  );

  assert.equal(result.text, '{"type":"single"}');
  assert.equal(typeof capturedContext.systemPrompt, "string");
  assert.match(capturedContext.systemPrompt, /planning atomic Git commits/);
  assert.deepStrictEqual(capturedOptions, {
    apiKey: undefined,
    headers: { Authorization: "Bearer token" },
    maxTokens: 4096,
  });

  setCompleteFn(undefined);
});

test("resolveApiKey: returns undefined when auth resolution yields only headers", async () => {
  const apiKey = await resolveApiKey(
    {
      modelRegistry: {
        find: () => ({ provider: model.provider, id: model.id }),
        getApiKey: async () => "",
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          headers: { Authorization: "Bearer token" },
        }),
      },
    },
    { provider: model.provider, id: model.id },
  );

  assert.equal(apiKey, undefined);
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

// ---------------------------------------------------------------------------
// resolveRequestAuth: fallback when getApiKeyAndHeaders returns ok: false
// ---------------------------------------------------------------------------

test("resolveRequestAuth: falls back to getApiKey when getApiKeyAndHeaders returns ok: false", async () => {
  const auth = await resolveRequestAuth(
    {
      modelRegistry: {
        find: () => ({ provider: "test", id: "test" }),
        getApiKey: async () => "fallback-key",
        getApiKeyAndHeaders: async () => ({ ok: false as const, error: "token expired" }),
      },
    },
    { provider: "test", id: "test" },
  );
  assert.deepStrictEqual(auth, { apiKey: "fallback-key" });
});

// ---------------------------------------------------------------------------
// resolveRequestAuth: returns empty auth when getApiKeyAndHeaders throws
// ---------------------------------------------------------------------------

test("resolveRequestAuth: returns empty auth when getApiKeyAndHeaders throws", async () => {
  const auth = await resolveRequestAuth(
    {
      modelRegistry: {
        find: () => ({ provider: "test", id: "test" }),
        getApiKey: async () => { throw new Error("also broken"); },
        getApiKeyAndHeaders: async () => { throw new Error("network error"); },
      },
    },
    { provider: "test", id: "test" },
  );
  assert.deepStrictEqual(auth, {});
});

// ---------------------------------------------------------------------------
// resolveRequestAuth: returns empty auth when registryModel is null
// ---------------------------------------------------------------------------

test("resolveRequestAuth: returns empty auth when registryModel is null", async () => {
  const auth = await resolveRequestAuth(
    { modelRegistry: { find: () => null, getApiKey: async () => "key" } },
    null,
  );
  assert.deepStrictEqual(auth, {});
});

// ---------------------------------------------------------------------------
// resolveRequestAuth: falls back to getApiKey when getApiKeyAndHeaders is absent
// ---------------------------------------------------------------------------

test("resolveRequestAuth: falls back to getApiKey when getApiKeyAndHeaders is not defined", async () => {
  const auth = await resolveRequestAuth(
    {
      modelRegistry: {
        find: () => ({ provider: "test", id: "test" }),
        getApiKey: async () => "legacy-key",
      },
    },
    { provider: "test", id: "test" },
  );
  assert.deepStrictEqual(auth, { apiKey: "legacy-key" });
});

// ---------------------------------------------------------------------------
// extractFirstTextBlock: edge cases
// ---------------------------------------------------------------------------

test("extractFirstTextBlock: returns null for empty output_text", () => {
  assert.equal(extractFirstTextBlock({ output_text: "" } as any), null);
});

test("extractFirstTextBlock: prefers output_text over content blocks", () => {
  const response = {
    output_text: "from output_text",
    content: [{ type: "text", text: "from content" }],
  } as any;
  assert.equal(extractFirstTextBlock(response), "from output_text");
});

// ---------------------------------------------------------------------------
// buildCompleteOptions: includes temperature for non-codex providers
// ---------------------------------------------------------------------------

test("buildCompleteOptions: includes temperature for non-codex providers", () => {
  const options = buildCompleteOptions(
    { provider: "anthropic", id: "claude-sonnet", name: "Sonnet" },
    { apiKey: "key-123" },
  );
  assert.deepStrictEqual(options, {
    apiKey: "key-123",
    headers: undefined,
    maxTokens: 4096,
    temperature: 0.2,
  });
});
