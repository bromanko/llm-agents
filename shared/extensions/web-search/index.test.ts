import assert from "node:assert/strict";
import test from "node:test";

import { createMockExtensionAPI } from "../../../test/helpers.ts";
import registerWebSearchExtension, { createWebSearchToolDefinition } from "./index.ts";
import { SearchProviderError } from "./types.ts";

function getRegisteredToolDefinition() {
  const pi = createMockExtensionAPI();
  let definition: any;

  pi.registerTool = (toolDefinition: any) => {
    definition = toolDefinition;
  };

  registerWebSearchExtension(
    pi as unknown as Parameters<typeof registerWebSearchExtension>[0],
  );

  return definition;
}

test("extension registers a single tool named web_search", () => {
  const definition = getRegisteredToolDefinition();
  assert.ok(definition);
  assert.equal(definition.name, "web_search");
});

test("schema includes query/provider/recency/limit/enrich/fetchTop fields", () => {
  const definition = getRegisteredToolDefinition();
  const properties = definition.parameters.properties;

  assert.ok(properties.query);
  assert.ok(properties.provider);
  assert.ok(properties.recency);
  assert.ok(properties.limit);
  assert.ok(properties.enrich);
  assert.ok(properties.fetchTop);
});

test("schema marks query as required and forbids additional properties", () => {
  const definition = getRegisteredToolDefinition();

  assert.deepEqual(definition.parameters.required, ["query"]);
  assert.equal(definition.parameters.additionalProperties, false);
});

test("execute happy path returns envelope with Sources and Meta sections", async () => {
  const definition = createWebSearchToolDefinition({
    searchRunner: async () => ({
      provider: "brave",
      requestId: "req-123",
      sources: [
        {
          title: "Result title",
          url: "https://example.com",
          snippet: "result snippet",
        },
      ],
    }),
    enricher: async (sources) => ({ sources, warnings: [] }),
  });

  const result = await definition.execute("tool-call-1", {
    query: "typescript release notes",
  });

  const text = result.content[0]?.text ?? "";
  assert.match(text, /## Sources/);
  assert.match(text, /## Meta/);
});

test("execute includes Warnings section when warnings are present", async () => {
  const definition = createWebSearchToolDefinition({
    searchRunner: async () => ({
      provider: "brave",
      requestId: "req-123",
      sources: [{ title: "Result title", url: "https://example.com" }],
      warnings: ["base warning"],
    }),
    enricher: async (sources) => ({ sources, warnings: ["enrich warning"] }),
  });

  const result = await definition.execute("tool-call-1", {
    query: "typescript release notes",
  });

  const text = result.content[0]?.text ?? "";
  assert.match(text, /## Warnings/);
  assert.match(text, /base warning/);
  assert.match(text, /enrich warning/);
});

test("missing Brave key errors are surfaced with actionable text", async () => {
  const definition = createWebSearchToolDefinition({
    searchRunner: async () => {
      throw new SearchProviderError(
        "brave",
        "BRAVE_API_KEY not found. Set it in environment before using web_search.",
      );
    },
  });

  const result = await definition.execute("tool-call-1", {
    query: "typescript release notes",
  });

  const text = result.content[0]?.text ?? "";
  assert.equal(
    text,
    "Error: BRAVE_API_KEY not found. Set it in environment before using web_search.",
  );
});

test("renderCall and renderResult return compact readable strings", () => {
  const definition = getRegisteredToolDefinition();

  const callComponent = definition.renderCall({ query: "elm" });
  const callText = callComponent.render(120).join("\n");
  assert.equal(callText, "web_search elm");

  const resultComponent = definition.renderResult(
    { details: { sourceCount: 3, provider: "brave" } },
    { isPartial: false },
  );
  const resultText = resultComponent.render(120).join("\n");
  assert.equal(resultText, "Web search complete (3 sources, brave)");
});
