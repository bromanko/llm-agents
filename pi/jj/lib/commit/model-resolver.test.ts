import test from "node:test";
import assert from "node:assert/strict";
import { resolveCommitModel } from "./model-resolver.ts";
import type { ModelCandidate } from "./model-resolver.ts";

const preferredCommitModel: ModelCandidate = {
  provider: "openai-codex",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 mini",
};

const preferredCommitModelWithThinking: ModelCandidate = {
  ...preferredCommitModel,
  thinkingLevel: "low",
};

const sessionModel: ModelCandidate = {
  provider: "openai",
  id: "gpt-4o",
  name: "GPT-4o",
};

const otherModel: ModelCandidate = {
  provider: "anthropic",
  id: "claude-haiku-3-5-20241022",
  name: "Claude 3.5 Haiku",
};

test("resolveCommitModel: prefers configured model over built-in preferred and session model", async () => {
  const configuredModel: ModelCandidate = {
    provider: "dbx-bedrock",
    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    name: "dbx-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  };

  const result = await resolveCommitModel({
    availableModels: [otherModel, preferredCommitModel, sessionModel, configuredModel],
    configuredModel,
    sessionModel,
    hasApiKey: async (m) => m.id === configuredModel.id,
  });

  assert.deepStrictEqual(result.model, configuredModel);
  assert.equal(result.warnings.length, 0);
});

test("resolveCommitModel: prefers GPT-5.4 mini with low thinking when available with API key", async () => {
  const result = await resolveCommitModel({
    availableModels: [otherModel, preferredCommitModel, sessionModel],
    sessionModel,
    hasApiKey: async () => true,
  });

  assert.deepStrictEqual(result.model, preferredCommitModelWithThinking);
  assert.equal(result.warnings.length, 0);
});

test("resolveCommitModel: falls back to session model when GPT-5.4 mini is not in registry", async () => {
  const result = await resolveCommitModel({
    availableModels: [otherModel, sessionModel],
    sessionModel,
    hasApiKey: async () => true,
  });

  assert.deepStrictEqual(result.model, sessionModel);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("not found in registry"));
});

test("resolveCommitModel: falls back to session model when GPT-5.4 mini has no API key", async () => {
  const result = await resolveCommitModel({
    availableModels: [preferredCommitModel, sessionModel],
    sessionModel,
    hasApiKey: async (m) => m.id !== preferredCommitModel.id,
  });

  assert.deepStrictEqual(result.model, sessionModel);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("no API key"));
  assert.ok(result.warnings[0].includes("falling back"));
});

test("resolveCommitModel: returns null when both preferred and session model fail", async () => {
  const result = await resolveCommitModel({
    availableModels: [preferredCommitModel],
    sessionModel,
    hasApiKey: async () => false,
  });

  assert.equal(result.model, null);
  assert.ok(result.warnings.length >= 2);
  assert.ok(
    result.warnings.some((w) => w.includes("No compatible jj-commit model is available")),
  );
});

test("resolveCommitModel: returns null when no models available and no session model", async () => {
  const result = await resolveCommitModel({
    availableModels: [],
    sessionModel: undefined,
    hasApiKey: async () => true,
  });

  assert.equal(result.model, null);
  assert.ok(result.warnings.some((w) => w.includes("not found in registry")));
  assert.ok(result.warnings.some((w) => w.includes("No session model")));
});

test("resolveCommitModel: allows configured openai-codex models when auth is available", async () => {
  const codexModel: ModelCandidate = {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "openai-codex/gpt-5.4",
  };

  const result = await resolveCommitModel({
    availableModels: [preferredCommitModel, sessionModel, codexModel],
    configuredModel: codexModel,
    sessionModel,
    hasApiKey: async (m) => m.id === codexModel.id,
  });

  assert.deepStrictEqual(result.model, codexModel);
  assert.equal(result.warnings.length, 0);
});

test("resolveCommitModel: falls back to an openai-codex session model when preferred model is unavailable", async () => {
  const codexSessionModel: ModelCandidate = {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
  };

  const result = await resolveCommitModel({
    availableModels: [otherModel, codexSessionModel],
    sessionModel: codexSessionModel,
    hasApiKey: async (m) => m.id === codexSessionModel.id,
  });

  assert.deepStrictEqual(result.model, codexSessionModel);
  assert.ok(result.warnings.some((w) => w.includes("not found in registry")));
});

test("resolveCommitModel: does not match other GPT-5.4 variants", async () => {
  const variant: ModelCandidate = {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "GPT-5.4",
  };

  const result = await resolveCommitModel({
    availableModels: [variant],
    sessionModel,
    hasApiKey: async () => true,
  });

  assert.deepStrictEqual(result.model, sessionModel);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("gpt-5.4-mini"));
});
