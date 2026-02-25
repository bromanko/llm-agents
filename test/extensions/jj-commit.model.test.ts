import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  buildCommitPrompt,
  parseModelResponse,
  runModelInference,
  setCompleteFn,
  setCompleteFnImporter,
} from "../../packages/jj/extensions/jj-commit.ts";

const model = {
  provider: "anthropic",
  id: "claude-sonnet-4-6-20260301",
  name: "Claude Sonnet 4.6",
};

beforeEach(() => {
  setCompleteFn(undefined);
  setCompleteFnImporter(undefined);
});

afterEach(() => {
  setCompleteFn(undefined);
  setCompleteFnImporter(undefined);
});

test("buildCommitPrompt: includes context/targets and truncates diff", () => {
  const diff = "x".repeat(51_000);
  const prompt = buildCommitPrompt({
    changedFiles: ["src/a.ts", "src/b.ts"],
    diff,
    stat: "2 files changed",
    changelogTargets: ["CHANGELOG.md"],
    userContext: "please keep commits small",
  });

  assert.ok(prompt.includes("## Changed Files\nsrc/a.ts\nsrc/b.ts"));
  assert.ok(prompt.includes("## User Context\nplease keep commits small"));
  assert.ok(prompt.includes("## Changelog Targets\nCHANGELOG.md"));
  assert.ok(prompt.includes("x".repeat(50_000)));
  assert.ok(!prompt.includes("x".repeat(50_001)));
});

test("parseModelResponse: parses unfenced and fenced single JSON", () => {
  const unfenced = JSON.stringify({
    type: "single",
    commit: {
      type: "feat",
      scope: "commit",
      summary: "added parser tests",
      details: [{ text: "covered parser edge cases", userVisible: true }],
    },
  });

  const fenced = `\
\`\`\`json
${unfenced}
\`\`\``;

  const parsedUnfenced = parseModelResponse(unfenced, ["src/a.ts"]);
  const parsedFenced = parseModelResponse(fenced, ["src/a.ts"]);

  assert.equal(parsedUnfenced.proposal?.type, "feat");
  assert.equal(parsedFenced.proposal?.summary, "added parser tests");
  assert.deepStrictEqual(parsedFenced.proposal?.details, [
    { text: "covered parser edge cases", userVisible: true },
  ]);
});

test("parseModelResponse: returns empty object for non-JSON output", () => {
  const parsed = parseModelResponse("I think this should be a feat commit", ["src/a.ts"]);
  assert.deepStrictEqual(parsed, {});
});

test("parseModelResponse: handles invalid details and coerces invalid summary/scope/type", () => {
  const payload = JSON.stringify({
    type: "single",
    commit: {
      type: "not-a-valid-type",
      scope: "Bad Scope",
      summary: 123,
      details: [
        { text: "  kept detail  ", userVisible: 1 },
        "string detail",
        { text: "" },
        { nope: true },
        42,
      ],
    },
  });

  const parsed = parseModelResponse(payload, ["src/a.ts"]);

  assert.ok(parsed.proposal);
  assert.equal(parsed.proposal?.type, "chore");
  assert.equal(parsed.proposal?.scope, null);
  assert.equal(parsed.proposal?.summary, "updated files");
  assert.deepStrictEqual(parsed.proposal?.details, [
    { text: "kept detail", userVisible: false },
    { text: "string detail", userVisible: false },
  ]);
});

test("parseModelResponse: rejects invalid split payload shapes", () => {
  const notArray = JSON.stringify({ type: "split", commits: { files: ["a.ts"] } });
  const invalidEntry = JSON.stringify({ type: "split", commits: ["bad-entry"] });

  assert.deepStrictEqual(parseModelResponse(notArray, ["a.ts"]), {});
  assert.deepStrictEqual(parseModelResponse(invalidEntry, ["a.ts"]), {});
});

test("parseModelResponse: rejects split plans with missing/duplicate/unexpected files", () => {
  const changed = ["a.ts", "b.ts"];

  const missing = JSON.stringify({
    type: "split",
    commits: [
      { files: ["a.ts"], type: "feat", summary: "added a", details: [], dependencies: [] },
    ],
  });

  const duplicate = JSON.stringify({
    type: "split",
    commits: [
      { files: ["a.ts"], type: "feat", summary: "added a", details: [], dependencies: [] },
      { files: ["a.ts", "b.ts"], type: "fix", summary: "fixed b", details: [], dependencies: [] },
    ],
  });

  const unexpected = JSON.stringify({
    type: "split",
    commits: [
      { files: ["a.ts"], type: "feat", summary: "added a", details: [], dependencies: [] },
      { files: ["c.ts"], type: "fix", summary: "fixed c", details: [], dependencies: [] },
    ],
  });

  assert.deepStrictEqual(parseModelResponse(missing, changed), {});
  assert.deepStrictEqual(parseModelResponse(duplicate, changed), {});
  assert.deepStrictEqual(parseModelResponse(unexpected, changed), {});
});

test("parseModelResponse: accepts valid split plans and sanitizes details", () => {
  const payload = JSON.stringify({
    type: "split",
    mode: "hunk",
    commits: [
      {
        files: ["a.ts"],
        type: "feat",
        scope: "commit",
        summary: "added a",
        details: ["string detail", { text: "more detail", userVisible: true }],
        dependencies: [1, 99, -2],
      },
      {
        files: ["b.ts"],
        type: "fix",
        scope: "bad scope",
        summary: "fixed b",
        details: { wrong: true },
        dependencies: [],
      },
    ],
  });

  const parsed = parseModelResponse(payload, ["a.ts", "b.ts"]);

  assert.ok(parsed.splitPlan);
  assert.equal(parsed.splitPlan?.mode, "hunk");
  assert.equal(parsed.splitPlan?.commits[0].dependencies.length, 1);
  assert.deepStrictEqual(parsed.splitPlan?.commits[0].details, [
    { text: "string detail", userVisible: false },
    { text: "more detail", userVisible: true },
  ]);
  assert.equal(parsed.splitPlan?.commits[1].scope, null);
});

function makeInferenceContext(options: {
  availableModels?: any[];
  apiKey?: string | undefined;
  response?: any;
  throwOnComplete?: boolean;
}) {
  const registryModel = {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
  };

  const allModels = options.availableModels ?? [registryModel];

  // Install a mock completion function for the test
  setCompleteFn(async () => {
    if (options.throwOnComplete) {
      throw new Error("completion failed");
    }
    return options.response;
  });

  return {
    modelRegistry: {
      getAvailable: () => allModels,
      find: (provider: string, id: string) =>
        allModels.find((m: any) => m.provider === provider && m.id === id),
      getApiKey: async () => options.apiKey ?? "fake-key",
    },
  };
}

test("runModelInference: extracts first text block from mixed content", async () => {
  const ctx = makeInferenceContext({
    response: {
      content: [
        { type: "tool_result", result: "ignored" },
        { type: "text", text: "first text" },
        { type: "text", text: "second text" },
      ],
    },
  });

  const result = await runModelInference({} as any, ctx, model as any, "prompt");
  assert.equal(result, "first text");
});

test("runModelInference: passes resolved model, prompt message, and options", async () => {
  const prompt = "commit prompt text";
  const registryModel = {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
  };

  let capturedModel: unknown;
  let capturedContext: any;
  let capturedOptions: any;

  setCompleteFn(async (modelArg, contextArg, optionsArg) => {
    capturedModel = modelArg;
    capturedContext = contextArg;
    capturedOptions = optionsArg;
    return {
      content: [{ type: "text", text: "ok" }],
    };
  });

  const ctx = {
    modelRegistry: {
      find: (provider: string, id: string) => {
        assert.equal(provider, model.provider);
        assert.equal(id, model.id);
        return registryModel;
      },
      getApiKey: async (resolvedModel: unknown) => {
        assert.equal(resolvedModel, registryModel);
        return "forwarded-key";
      },
    },
  };

  const result = await runModelInference({} as any, ctx as any, model as any, prompt);

  assert.equal(result, "ok");
  assert.equal(capturedModel, registryModel);
  assert.ok(capturedContext);
  assert.ok(Array.isArray(capturedContext.messages));
  assert.equal(capturedContext.messages.length, 1);
  assert.equal(capturedContext.messages[0].role, "user");
  assert.deepStrictEqual(capturedContext.messages[0].content, [{ type: "text", text: prompt }]);
  assert.equal(capturedContext.messages[0].timestamp, undefined);
  assert.deepStrictEqual(capturedOptions, {
    apiKey: "forwarded-key",
    maxTokens: 2048,
    temperature: 0.2,
  });
});

test("runModelInference: resolves completion via importer fallback when injector is unset", async () => {
  const prompt = "fallback prompt";
  const registryModel = {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
  };

  let importerCalls = 0;
  let completeCalls = 0;
  let capturedModel: unknown;
  let capturedContext: any;
  let capturedOptions: any;

  setCompleteFn(undefined);
  setCompleteFnImporter(async () => {
    importerCalls += 1;
    return async (modelArg, contextArg, optionsArg) => {
      completeCalls += 1;
      capturedModel = modelArg;
      capturedContext = contextArg;
      capturedOptions = optionsArg;
      return { content: [{ type: "text", text: "fallback ok" }] };
    };
  });

  const ctx = {
    modelRegistry: {
      find: () => registryModel,
      getApiKey: async () => "fallback-key",
    },
  };

  const first = await runModelInference({} as any, ctx as any, model as any, prompt);
  const second = await runModelInference({} as any, ctx as any, model as any, prompt);

  assert.equal(first, "fallback ok");
  assert.equal(second, "fallback ok");
  assert.equal(importerCalls, 1);
  assert.equal(completeCalls, 2);
  assert.equal(capturedModel, registryModel);
  assert.deepStrictEqual(capturedContext.messages[0].content, [{ type: "text", text: prompt }]);
  assert.deepStrictEqual(capturedOptions, {
    apiKey: "fallback-key",
    maxTokens: 2048,
    temperature: 0.2,
  });
});

test("runModelInference: returns null for non-text or surprising content shapes", async () => {
  const nonText = makeInferenceContext({
    response: {
      content: [{ type: "tool_result", result: "ignored" }],
    },
  });

  const weirdShape = makeInferenceContext({
    response: {
      content: { type: "text", text: "not-an-array" },
    },
  });

  assert.equal(await runModelInference({} as any, nonText, model as any, "prompt"), null);
  assert.equal(await runModelInference({} as any, weirdShape, model as any, "prompt"), null);
});

test("runModelInference: returns null when model not found in registry", async () => {
  const notFound = makeInferenceContext({ availableModels: [] });

  assert.equal(await runModelInference({} as any, notFound, model as any, "prompt"), null);
});

test("runModelInference: allows undefined apiKey and still completes", async () => {
  let completeCalled = false;
  let capturedOptions: any;

  setCompleteFn(async (_model, _context, options) => {
    completeCalled = true;
    capturedOptions = options;
    return {
      content: [{ type: "text", text: "oauth response" }],
    };
  });

  const registryModel = {
    provider: model.provider,
    id: model.id,
    name: model.name,
    api: "anthropic-messages",
  };

  const ctx = {
    modelRegistry: {
      find: () => registryModel,
      getApiKey: async () => undefined,
    },
  };

  const result = await runModelInference({} as any, ctx as any, model as any, "prompt");

  assert.equal(result, "oauth response");
  assert.equal(completeCalled, true);
  assert.deepStrictEqual(capturedOptions, {
    apiKey: undefined,
    maxTokens: 2048,
    temperature: 0.2,
  });
});

test("runModelInference: swallows API errors, logs debug context, and returns null", async () => {
  const ctx = makeInferenceContext({ throwOnComplete: true }) as any;

  let debugMessage: string | undefined;
  let debugMeta: any;
  ctx.logger = {
    debug: (message: string, meta?: unknown) => {
      debugMessage = message;
      debugMeta = meta;
    },
  };

  const result = await runModelInference({} as any, ctx, model as any, "prompt");

  assert.equal(result, null);
  assert.equal(debugMessage, "runModelInference failed");
  assert.ok(debugMeta);
  assert.equal(debugMeta.provider, model.provider);
  assert.equal(debugMeta.modelId, model.id);
  assert.ok(debugMeta.err instanceof Error);
  assert.equal(debugMeta.err.message, "completion failed");
});

