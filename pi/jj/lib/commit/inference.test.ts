import test from "node:test";
import assert from "node:assert/strict";
import {
  runModelInference,
  parseModelResponse,
  setCompleteFn,
  _testHelpers,
} from "./inference.ts";
import type {
  InferenceContext,
  CompleteFn,
  CompletionBlock,
} from "./inference.ts";
import type { ModelCandidate } from "./model-resolver.ts";

const {
  extractJsonObjectCandidates,
  extractFirstTextBlock,
  parseJsonFromModelResponse,
  resolveApiKey,
  resolveRequestAuth,
  buildCompleteOptions,
  sanitizeSummary,
  sanitizeDetails,
  validateSplitCoverage,
} = _testHelpers;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultModel: ModelCandidate = {
  provider: "anthropic",
  id: "claude-sonnet-4-6-20260301",
  name: "Claude Sonnet 4.6",
};

function mockCompleteFn(text: string): CompleteFn {
  return async () => ({
    content: [{ type: "text", text }],
  });
}

function createCtx(overrides: Partial<InferenceContext> = {}): InferenceContext {
  return {
    modelRegistry: {
      find: () => ({ provider: defaultModel.provider, id: defaultModel.id }),
      getApiKey: async () => "test-key",
    },
    logger: { debug: () => { } },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// extractJsonObjectCandidates
// ---------------------------------------------------------------------------

test("extractJsonObjectCandidates: extracts plain JSON", () => {
  const result = extractJsonObjectCandidates('{"a":1}');
  assert.ok(result.includes('{"a":1}'));
});

test("extractJsonObjectCandidates: extracts from markdown code block", () => {
  const input = 'Some text\n```json\n{"key":"value"}\n```\nMore text';
  const result = extractJsonObjectCandidates(input);
  assert.ok(result.some((c) => c.includes('"key"')));
});

test("extractJsonObjectCandidates: multiple objects in prose — extracts both", () => {
  const input = 'Here is the first: {"a":1} and second: {"b":2} suffix';
  const result = extractJsonObjectCandidates(input);
  // The balanced-brace parser should produce two separate candidates
  assert.ok(result.some((c) => {
    try { const p = JSON.parse(c); return p.a === 1; } catch { return false; }
  }), "should extract {\"a\":1}");
  assert.ok(result.some((c) => {
    try { const p = JSON.parse(c); return p.b === 2; } catch { return false; }
  }), "should extract {\"b\":2}");
});

test("extractJsonObjectCandidates: string containing closing brace", () => {
  const input = '{"key": "value with } brace"}';
  const result = extractJsonObjectCandidates(input);
  assert.ok(result.some((c) => {
    try { const p = JSON.parse(c); return p.key === "value with } brace"; } catch { return false; }
  }), "should handle string-embedded braces");
});

test("extractJsonObjectCandidates: deeply nested objects", () => {
  const input = '{"outer": {"inner": {"deep": 1}}}';
  const result = extractJsonObjectCandidates(input);
  assert.ok(result.some((c) => {
    try { const p = JSON.parse(c); return p.outer?.inner?.deep === 1; } catch { return false; }
  }), "should handle deeply nested objects");
});

test("extractJsonObjectCandidates: no braces returns only original text", () => {
  const input = "no json here at all";
  const result = extractJsonObjectCandidates(input);
  assert.deepStrictEqual(result, [input]);
});

test("extractJsonObjectCandidates: escaped quotes in strings", () => {
  const input = '{"key": "value \\"quoted\\" end"}';
  const result = extractJsonObjectCandidates(input);
  assert.ok(result.some((c) => {
    try { JSON.parse(c); return true; } catch { return false; }
  }), "should handle escaped quotes");
});

// ---------------------------------------------------------------------------
// extractFirstTextBlock
// ---------------------------------------------------------------------------

test("extractFirstTextBlock: returns null for null response", () => {
  assert.equal(extractFirstTextBlock(null), null);
});

test("extractFirstTextBlock: returns null for undefined response", () => {
  assert.equal(extractFirstTextBlock(undefined), null);
});

test("extractFirstTextBlock: returns null for empty content array", () => {
  assert.equal(extractFirstTextBlock({ content: [] }), null);
});

test("extractFirstTextBlock: returns null for non-text blocks only", () => {
  const response = {
    content: [
      { type: "image", data: "..." } as unknown as CompletionBlock,
      { type: "tool_use", name: "x" } as unknown as CompletionBlock,
    ],
  };
  assert.equal(extractFirstTextBlock(response), null);
});

test("extractFirstTextBlock: returns null when text block has missing text property", () => {
  const response = {
    content: [{ type: "text" } as CompletionBlock],
  };
  assert.equal(extractFirstTextBlock(response), null);
});

test("extractFirstTextBlock: returns null when text block has empty string", () => {
  const response = {
    content: [{ type: "text", text: "" } as CompletionBlock],
  };
  assert.equal(extractFirstTextBlock(response), null);
});

test("extractFirstTextBlock: returns first text block", () => {
  const response = {
    content: [
      { type: "image" } as unknown as CompletionBlock,
      { type: "text", text: "hello" },
      { type: "text", text: "world" },
    ],
  };
  assert.equal(extractFirstTextBlock(response), "hello");
});

test("extractFirstTextBlock: returns null for non-array content", () => {
  const response = { content: "not an array" } as any;
  assert.equal(extractFirstTextBlock(response), null);
});

test("extractFirstTextBlock: returns output_text when present", () => {
  const response = { output_text: "codex text" } as any;
  assert.equal(extractFirstTextBlock(response), "codex text");
});

test("extractFirstTextBlock: returns text from OpenAI Responses output messages", () => {
  const response = {
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        content: [
          { type: "output_text", text: "codex output message" },
        ],
      },
    ],
  } as any;

  assert.equal(extractFirstTextBlock(response), "codex output message");
});

// ---------------------------------------------------------------------------
// parseJsonFromModelResponse
// ---------------------------------------------------------------------------

test("parseJsonFromModelResponse: parses plain JSON", () => {
  const result = parseJsonFromModelResponse('{"type":"single"}');
  assert.deepStrictEqual(result, { type: "single" });
});

test("parseJsonFromModelResponse: extracts JSON from markdown fences", () => {
  const input = "Here's the result:\n```json\n{\"type\":\"single\"}\n```";
  const result = parseJsonFromModelResponse(input);
  assert.deepStrictEqual(result, { type: "single" });
});

test("parseJsonFromModelResponse: throws on non-JSON input", () => {
  assert.throws(() => parseJsonFromModelResponse("no json here"), /parseable JSON/);
});

// ---------------------------------------------------------------------------
// resolveApiKey
// ---------------------------------------------------------------------------

test("resolveApiKey: returns undefined when getApiKey throws", async () => {
  const ctx = createCtx({
    modelRegistry: {
      find: () => ({ provider: "test", id: "test" }),
      getApiKey: async () => { throw new Error("auth service unavailable"); },
    },
  });
  const result = await resolveApiKey(ctx, { provider: "test", id: "test" });
  assert.equal(result, undefined);
});

test("resolveApiKey: returns undefined when no registry model", async () => {
  const ctx = createCtx();
  const result = await resolveApiKey(ctx, null);
  assert.equal(result, undefined);
});

test("resolveApiKey: returns undefined when no registry", async () => {
  const ctx = createCtx({ modelRegistry: undefined });
  const result = await resolveApiKey(ctx, { provider: "test", id: "test" });
  assert.equal(result, undefined);
});

test("resolveApiKey: returns key when getApiKey succeeds", async () => {
  const ctx = createCtx({
    modelRegistry: {
      find: () => ({ provider: "test", id: "test" }),
      getApiKey: async () => "sk-123",
    },
  });
  const result = await resolveApiKey(ctx, { provider: "test", id: "test" });
  assert.equal(result, "sk-123");
});

test("resolveApiKey: returns undefined for empty string key", async () => {
  const ctx = createCtx({
    modelRegistry: {
      find: () => ({ provider: "test", id: "test" }),
      getApiKey: async () => "",
    },
  });
  const result = await resolveApiKey(ctx, { provider: "test", id: "test" });
  assert.equal(result, undefined);
});

test("resolveApiKey: returns undefined for whitespace-only key", async () => {
  const ctx = createCtx({
    modelRegistry: {
      find: () => ({ provider: "test", id: "test" }),
      getApiKey: async () => "   ",
    },
  });
  const result = await resolveApiKey(ctx, { provider: "test", id: "test" });
  assert.equal(result, undefined);
});

test("resolveRequestAuth: prefers getApiKeyAndHeaders when available", async () => {
  const ctx = createCtx({
    modelRegistry: {
      find: () => ({ provider: "test", id: "test" }),
      getApiKey: async () => {
        throw new Error("should not fall back to getApiKey");
      },
      getApiKeyAndHeaders: async () => ({
        ok: true as const,
        apiKey: "codex-key",
        headers: { Authorization: "Bearer codex-key" },
      }),
    },
  });

  const result = await resolveRequestAuth(ctx, { provider: "test", id: "test" });

  assert.deepStrictEqual(result, {
    apiKey: "codex-key",
    headers: { Authorization: "Bearer codex-key" },
  });
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
    maxTokens: 2048,
    temperature: 0.2,
  });
});

// ---------------------------------------------------------------------------
// runModelInference — resolveModelObject edge cases
// ---------------------------------------------------------------------------

test("runModelInference: returns null when model not found anywhere", async () => {
  setCompleteFn(mockCompleteFn('{"type":"single"}'));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getApiKey: async () => "",
      },
      model: undefined,
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, null);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: uses getAll fallback when find returns undefined", async () => {
  const responseText = '{"type":"single","commit":{"type":"feat"}}';
  setCompleteFn(mockCompleteFn(responseText));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [
          { provider: "anthropic", id: "claude-sonnet-4-6-20260301", name: "test" },
        ],
        getApiKey: async () => "key",
      },
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, responseText);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: returns null when getAll has no matching model", async () => {
  setCompleteFn(mockCompleteFn("test"));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [{ provider: "other", id: "other" }],
        getApiKey: async () => "",
      },
      model: undefined,
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, null);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: returns null when getAll returns non-record items", async () => {
  setCompleteFn(mockCompleteFn("test"));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [null, "string", 42] as unknown[],
        getApiKey: async () => "",
      },
      model: undefined,
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, null);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: returns null when getAll throws", async () => {
  setCompleteFn(mockCompleteFn("test"));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getAll: () => { throw new Error("registry error"); },
        getApiKey: async () => "",
      },
      model: undefined,
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, null);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: returns null when getAll returns empty array", async () => {
  setCompleteFn(mockCompleteFn("test"));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getAll: () => [],
        getApiKey: async () => "",
      },
      model: undefined,
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, null);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: falls back to session model when registry misses", async () => {
  const responseText = '{"type":"single"}';
  setCompleteFn(mockCompleteFn(responseText));
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => undefined,
        getApiKey: async () => undefined,
      },
      model: {
        provider: defaultModel.provider,
        id: defaultModel.id,
      },
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, responseText);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: proceeds without API key when getApiKey throws", async () => {
  const responseText = '{"answer": 42}';
  let capturedOptions: any;
  setCompleteFn(async (_model, _input, options) => {
    capturedOptions = options;
    return { content: [{ type: "text", text: responseText }] };
  });
  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => ({ provider: "test", id: "test" }),
        getApiKey: async () => { throw new Error("key store unavailable"); },
      },
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, responseText);
    assert.equal(capturedOptions?.apiKey, undefined);
    assert.equal(capturedOptions?.headers, undefined);
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: forwards auth headers for providers like openai-codex", async () => {
  let capturedOptions: any;
  setCompleteFn(async (_model, _input, options) => {
    capturedOptions = options;
    return { output_text: '{"type":"single"}' };
  });

  try {
    const ctx = createCtx({
      modelRegistry: {
        find: () => ({ provider: "openai-codex", id: "gpt-5.4" }),
        getApiKey: async () => "",
        getApiKeyAndHeaders: async () => ({
          ok: true as const,
          headers: { Authorization: "Bearer jwt-token" },
        }),
      },
    });

    const result = await runModelInference(
      ctx,
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
      "test prompt",
    );

    assert.equal(result, '{"type":"single"}');
    assert.deepStrictEqual(capturedOptions, {
      apiKey: undefined,
      headers: { Authorization: "Bearer jwt-token" },
      maxTokens: 2048,
    });
  } finally {
    setCompleteFn(undefined);
  }
});

test("runModelInference: sanitizes error in debug log (no raw err object)", async () => {
  let loggedMeta: any;
  setCompleteFn(async () => { throw new Error("secret-key-in-context"); });
  try {
    const ctx = createCtx({
      logger: {
        debug: (_msg: string, meta?: unknown) => { loggedMeta = meta; },
      },
    });
    const result = await runModelInference(ctx, defaultModel, "test prompt");
    assert.equal(result, null);
    // The logged metadata should contain the error message, not the raw error object
    assert.equal(loggedMeta?.error, "secret-key-in-context");
    assert.equal(loggedMeta?.err, undefined, "raw err object should not be logged");
  } finally {
    setCompleteFn(undefined);
  }
});

// ---------------------------------------------------------------------------
// sanitizeSummary
// ---------------------------------------------------------------------------

test("buildCompleteOptions: omits temperature for openai-codex", () => {
  const options = buildCompleteOptions(
    { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
    { apiKey: undefined, headers: { Authorization: "Bearer token" } },
  );

  assert.deepStrictEqual(options, {
    apiKey: undefined,
    headers: { Authorization: "Bearer token" },
    maxTokens: 2048,
  });
});

test("sanitizeSummary: returns default for non-string", () => {
  assert.equal(sanitizeSummary(42), "updated files");
  assert.equal(sanitizeSummary(null), "updated files");
  assert.equal(sanitizeSummary(undefined), "updated files");
});

test("sanitizeSummary: trims and returns valid string", () => {
  assert.equal(sanitizeSummary("  added feature  "), "added feature");
});

test("sanitizeSummary: strips control characters", () => {
  assert.equal(sanitizeSummary("added \x00feature\x1b[31m red"), "added feature[31m red");
});

test("sanitizeSummary: enforces 72-character max length", () => {
  const long = "a".repeat(100);
  const result = sanitizeSummary(long);
  assert.equal(result.length, 72);
});

test("sanitizeSummary: returns default for empty after stripping", () => {
  assert.equal(sanitizeSummary("\x00\x01\x02"), "updated files");
  assert.equal(sanitizeSummary("   "), "updated files");
});

test("sanitizeSummary: strips newlines from model output", () => {
  const result = sanitizeSummary("added feature\nsecond line");
  assert.ok(!result.includes("\n"), "should not contain newlines");
});

// ---------------------------------------------------------------------------
// sanitizeDetails
// ---------------------------------------------------------------------------

test("sanitizeDetails: strips control characters from string items", () => {
  const result = sanitizeDetails(["normal", "has\x00null", "\x1b[31mcolored"]);
  assert.equal(result.length, 3);
  assert.equal(result[0].text, "normal");
  assert.equal(result[1].text, "hasnull");
  assert.equal(result[2].text, "[31mcolored");
});

test("sanitizeDetails: strips control characters from object items", () => {
  const result = sanitizeDetails([
    { text: "clean text", userVisible: true },
    { text: "dirty\x00\x1ftext", userVisible: false },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, "clean text");
  assert.equal(result[1].text, "dirtytext");
});

test("sanitizeDetails: returns empty array for non-array", () => {
  assert.deepStrictEqual(sanitizeDetails("not an array"), []);
  assert.deepStrictEqual(sanitizeDetails(null), []);
  assert.deepStrictEqual(sanitizeDetails(undefined), []);
});

test("sanitizeDetails: filters empty items after control char stripping", () => {
  const result = sanitizeDetails(["\x00\x01", { text: "\x00" }]);
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// validateSplitCoverage
// ---------------------------------------------------------------------------

test("validateSplitCoverage: returns false for empty commits", () => {
  assert.equal(validateSplitCoverage([], ["a.ts"]), false);
});

test("validateSplitCoverage: returns true for exact coverage", () => {
  const commits = [
    { files: ["a.ts"] },
    { files: ["b.ts"] },
  ];
  assert.equal(validateSplitCoverage(commits, ["a.ts", "b.ts"]), true);
});

test("validateSplitCoverage: returns false for missing file", () => {
  const commits = [{ files: ["a.ts"] }];
  assert.equal(validateSplitCoverage(commits, ["a.ts", "b.ts"]), false);
});

test("validateSplitCoverage: returns false for duplicate file across commits", () => {
  const commits = [
    { files: ["a.ts"] },
    { files: ["a.ts"] },
  ];
  assert.equal(validateSplitCoverage(commits, ["a.ts"]), false);
});

// ---------------------------------------------------------------------------
// parseModelResponse (integration-level)
// ---------------------------------------------------------------------------

test("parseModelResponse: handles single commit response", () => {
  const response = JSON.stringify({
    type: "single",
    commit: {
      type: "feat",
      scope: "core",
      summary: "added new feature",
      details: [{ text: "implementation detail", userVisible: false }],
    },
  });
  const result = parseModelResponse(response, []);
  assert.ok(result.proposal);
  assert.equal(result.proposal!.type, "feat");
  assert.equal(result.proposal!.scope, "core");
  assert.equal(result.proposal!.summary, "added new feature");
});

test("parseModelResponse: handles split commit response", () => {
  const response = JSON.stringify({
    type: "split",
    commits: [
      { files: ["a.ts"], type: "feat", scope: null, summary: "added a", details: [], dependencies: [] },
      { files: ["b.ts"], type: "fix", scope: null, summary: "fixed b", details: [], dependencies: [] },
    ],
    mode: "file",
  });
  const result = parseModelResponse(response, ["a.ts", "b.ts"]);
  assert.ok(result.splitPlan);
  assert.equal(result.splitPlan!.commits.length, 2);
});

test("parseModelResponse: returns empty for garbage input", () => {
  const result = parseModelResponse("not json at all", []);
  assert.equal(result.proposal, undefined);
  assert.equal(result.splitPlan, undefined);
});

// ---------------------------------------------------------------------------
// Integration: full runModelInference → parseModelResponse path (Finding 13)
// Verifies the wiring works end-to-end without a `pi` parameter.
// ---------------------------------------------------------------------------

test("runModelInference: includes a system prompt for providers that require instructions", async () => {
  let capturedInput: any;
  setCompleteFn(async (_model, input) => {
    capturedInput = input;
    return { content: [{ type: "text", text: '{"type":"single"}' }] };
  });

  try {
    const ctx: InferenceContext = {
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, name: "test" }),
        getApiKey: async () => "test-key",
      },
      logger: { debug: () => { } },
    };

    await runModelInference(ctx, defaultModel, "Analyze these changes");
    assert.equal(typeof capturedInput?.systemPrompt, "string");
    assert.ok(capturedInput.systemPrompt.includes("conventional commit expert"));
  } finally {
    setCompleteFn(undefined);
  }
});

test("integration: runModelInference end-to-end produces parseable proposal", async () => {
  const modelResponse = JSON.stringify({
    type: "single",
    commit: {
      type: "feat",
      scope: "core",
      summary: "added new feature",
      details: [{ text: "detail", userVisible: false }],
    },
  });

  let capturedModel: unknown;
  let capturedInput: unknown;
  setCompleteFn(async (model, input, _options) => {
    capturedModel = model;
    capturedInput = input;
    return { content: [{ type: "text", text: modelResponse }] };
  });

  try {
    const ctx: InferenceContext = {
      modelRegistry: {
        find: (provider: string, id: string) => ({ provider, id, name: "test" }),
        getApiKey: async () => "test-key",
      },
      logger: { debug: () => { } },
    };

    const text = await runModelInference(ctx, defaultModel, "Analyze these changes");
    assert.ok(text, "should return model text");

    const result = parseModelResponse(text!, ["src/main.ts"]);
    assert.ok(result.proposal, "should produce a proposal");
    assert.equal(result.proposal!.type, "feat");
    assert.equal(result.proposal!.summary, "added new feature");

    // Verify the completion function received proper arguments
    assert.ok(capturedModel, "model object should be passed");
    assert.ok(capturedInput, "input should be passed");
  } finally {
    setCompleteFn(undefined);
  }
});
