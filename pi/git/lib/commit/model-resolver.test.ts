import test from "node:test";
import assert from "node:assert/strict";

import { resolveCommitModel } from "./model-resolver.ts";

test("resolveCommitModel: prefers configured model over built-in preferred and session model", async () => {
  const result = await resolveCommitModel({
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-6-test", name: "Claude Sonnet 4.6" },
      { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    ],
    configuredModel: { provider: "anthropic", id: "claude-opus-4-1", name: "anthropic/claude-opus-4-1" },
    sessionModel: { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    hasApiKey: async (model) => model.id === "claude-opus-4-1",
  });

  assert.deepStrictEqual(result.model, {
    provider: "anthropic",
    id: "claude-opus-4-1",
    name: "anthropic/claude-opus-4-1",
  });
});

test("resolveCommitModel: does not pick a random compatible model when preferred and session fail", async () => {
  const result = await resolveCommitModel({
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-6-test", name: "Claude Sonnet 4.6" },
      { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    ],
    hasApiKey: async () => false,
  });

  assert.equal(result.model, null);
  assert.ok(
    result.warnings.some((warning) => warning.includes("No compatible git-commit model is available")),
  );
});

test("resolveCommitModel: allows configured openai-codex model when auth is available", async () => {
  const result = await resolveCommitModel({
    availableModels: [
      { provider: "anthropic", id: "claude-sonnet-4-6-test", name: "Claude Sonnet 4.6" },
      { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" },
    ],
    configuredModel: { provider: "openai-codex", id: "gpt-5.4", name: "openai-codex/gpt-5.4" },
    sessionModel: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
    hasApiKey: async (model) => model.id === "gpt-5.4",
  });

  assert.deepStrictEqual(result.model, {
    provider: "openai-codex",
    id: "gpt-5.4",
    name: "openai-codex/gpt-5.4",
  });
  assert.equal(result.warnings.length, 0);
});
