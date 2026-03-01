import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_LIMIT,
  MIN_LIMIT,
  formatSourcesSection,
  normalizeSearchInput,
  runSearch,
} from "./core.ts";
import type { SearchProvider, SearchParams } from "./providers/base.ts";
import { SearchProviderError, type SearchResponse } from "./types.ts";

class MockProvider implements SearchProvider {
  readonly id = "brave" as const;
  readonly label = "Brave";

  calls: SearchParams[] = [];

  private readonly available: boolean;
  private readonly response: SearchResponse;

  constructor(available: boolean, response: SearchResponse = { provider: "brave", sources: [] }) {
    this.available = available;
    this.response = response;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    this.calls.push(params);
    return this.response;
  }
}

test("normalizeSearchInput rejects empty query with deterministic message", () => {
  assert.throws(
    () => normalizeSearchInput({ query: "   " }),
    (error) => error instanceof Error && error.message === "Query must not be empty.",
  );
});

test("normalizeSearchInput clamps limit below minimum to 1", () => {
  const normalized = normalizeSearchInput({ query: "elm", limit: 0 });
  assert.equal(normalized.limit, MIN_LIMIT);
});

test("normalizeSearchInput clamps limit above maximum to 10", () => {
  const normalized = normalizeSearchInput({ query: "elm", limit: 999 });
  assert.equal(normalized.limit, MAX_LIMIT);
});

test("normalizeSearchInput uses default limit 5", () => {
  const normalized = normalizeSearchInput({ query: "elm" });
  assert.equal(normalized.limit, 5);
});

test("runSearch resolves provider:auto to first available provider", async () => {
  const provider = new MockProvider(true, {
    provider: "brave",
    sources: [{ title: "Result", url: "https://example.com" }],
  });

  const response = await runSearch({ query: "typescript", provider: "auto" }, [provider]);

  assert.equal(response.provider, "brave");
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.query, "typescript");
});

test("runSearch with explicit provider=brave uses Brave provider", async () => {
  const provider = new MockProvider(true, {
    provider: "brave",
    sources: [{ title: "Docs", url: "https://example.com/docs" }],
  });

  await runSearch({ query: "release notes", provider: "brave" }, [provider]);

  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0]?.query, "release notes");
});

test("runSearch throws deterministic SearchProviderError when no providers are available", async () => {
  const provider = new MockProvider(false);

  await assert.rejects(
    () => runSearch({ query: "ts", provider: "auto" }, [provider]),
    (error) =>
      error instanceof SearchProviderError &&
      error.message ===
        "No search providers are available. Set BRAVE_API_KEY to enable provider 'brave'.",
  );
});

test("formatSourcesSection applies snippet truncation marker", () => {
  const output = formatSourcesSection(
    [
      {
        title: "A long result",
        url: "https://example.com",
        snippet: "x".repeat(120),
      },
    ],
    32,
  );

  assert.match(output, /\.\.\.|… \[truncated\]/);
  assert.match(output, /## Sources/);
});
