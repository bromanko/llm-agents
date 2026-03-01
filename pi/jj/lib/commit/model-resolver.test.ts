import test from "node:test";
import assert from "node:assert/strict";
import { resolveCommitModel } from "./model-resolver.ts";
import type { ModelCandidate } from "./model-resolver.ts";

const sonnet46: ModelCandidate = {
  provider: "anthropic",
  id: "claude-sonnet-4-6-20260301",
  name: "Claude Sonnet 4.6",
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

test("resolveCommitModel: prefers Sonnet 4.6 when available with API key", async () => {
  const result = await resolveCommitModel({
    availableModels: [otherModel, sonnet46, sessionModel],
    sessionModel,
    hasApiKey: async () => true,
  });

  assert.deepStrictEqual(result.model, sonnet46);
  assert.equal(result.warnings.length, 0);
});

test("resolveCommitModel: falls back to session model when Sonnet 4.6 not in registry", async () => {
  const result = await resolveCommitModel({
    availableModels: [otherModel, sessionModel],
    sessionModel,
    hasApiKey: async () => true,
  });

  assert.deepStrictEqual(result.model, sessionModel);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("not found in registry"));
});

test("resolveCommitModel: falls back to session model when Sonnet 4.6 has no API key", async () => {
  const result = await resolveCommitModel({
    availableModels: [sonnet46, sessionModel],
    sessionModel,
    hasApiKey: async (m) => m.id !== sonnet46.id,
  });

  assert.deepStrictEqual(result.model, sessionModel);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0].includes("no API key"));
  assert.ok(result.warnings[0].includes("falling back"));
});

test("resolveCommitModel: returns null when both preferred and session model fail", async () => {
  const result = await resolveCommitModel({
    availableModels: [sonnet46],
    sessionModel,
    hasApiKey: async () => false,
  });

  assert.equal(result.model, null);
  assert.ok(result.warnings.length >= 2);
  assert.ok(
    result.warnings.some((w) => w.includes("deterministic fallback")),
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

test("resolveCommitModel: matches any Sonnet 4.6 variant ID", async () => {
  const variant: ModelCandidate = {
    provider: "anthropic",
    id: "claude-sonnet-4-6-20260515",
    name: "Claude Sonnet 4.6 (May)",
  };

  const result = await resolveCommitModel({
    availableModels: [variant],
    sessionModel,
    hasApiKey: async () => true,
  });

  assert.deepStrictEqual(result.model, variant);
  assert.equal(result.warnings.length, 0);
});
