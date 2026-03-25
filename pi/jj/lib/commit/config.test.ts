import test from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig, parseModelRef } from "./config.ts";

test("parseModelRef: accepts provider/model string syntax", () => {
  assert.deepStrictEqual(parseModelRef("dbx-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"), {
    provider: "dbx-bedrock",
    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  });
});

test("parseModelRef: accepts object syntax with id or model", () => {
  assert.deepStrictEqual(parseModelRef({ provider: "openai", id: "gpt-4o" }), {
    provider: "openai",
    id: "gpt-4o",
  });

  assert.deepStrictEqual(parseModelRef({ provider: "anthropic", model: "claude-opus-4-1" }), {
    provider: "anthropic",
    id: "claude-opus-4-1",
  });
});

test("normalizeConfig: normalizes optional model", () => {
  assert.deepStrictEqual(normalizeConfig({}), {});
  assert.deepStrictEqual(normalizeConfig({ model: "anthropic/claude-opus-4-1" }), {
    model: {
      provider: "anthropic",
      id: "claude-opus-4-1",
    },
  });
});
