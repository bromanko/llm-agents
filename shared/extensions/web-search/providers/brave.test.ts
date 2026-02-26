import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { BraveSearchProvider, mapRecencyToBraveFreshness } from "./brave.ts";
import { SearchProviderError } from "../types.ts";

const successFixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/brave-web-search.success.json", import.meta.url), "utf8"),
);

const missingFieldsFixture = JSON.parse(
  readFileSync(new URL("./__fixtures__/brave-web-search.missing-fields.json", import.meta.url), "utf8"),
);

test("isAvailable returns false when BRAVE_API_KEY is missing", () => {
  const provider = new BraveSearchProvider(fetch, {});
  assert.equal(provider.isAvailable(), false);
});

test("isAvailable returns true when BRAVE_API_KEY exists", () => {
  const provider = new BraveSearchProvider(fetch, { BRAVE_API_KEY: "test-key" });
  assert.equal(provider.isAvailable(), true);
});

test("search request includes query and clamped limit", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(successFixture), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const provider = new BraveSearchProvider(mockFetch, { BRAVE_API_KEY: "k" });

  await provider.search({ query: "typescript", limit: 999 });

  assert.equal(calls.length, 1);
  const calledUrl = new URL(calls[0]!.url);
  assert.equal(calledUrl.searchParams.get("q"), "typescript");
  assert.equal(calledUrl.searchParams.get("count"), "10");
  assert.equal(calls[0]!.init?.method, "GET");
});

test("recency mapping day/week/month/year maps to Brave freshness values", () => {
  assert.equal(mapRecencyToBraveFreshness("day"), "pd");
  assert.equal(mapRecencyToBraveFreshness("week"), "pw");
  assert.equal(mapRecencyToBraveFreshness("month"), "pm");
  assert.equal(mapRecencyToBraveFreshness("year"), "py");
});

test("success fixture parses into normalized sources", async () => {
  const provider = new BraveSearchProvider(
    async () =>
      new Response(JSON.stringify(successFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { BRAVE_API_KEY: "k" },
  );

  const result = await provider.search({ query: "typescript", limit: 3 });

  assert.equal(result.provider, "brave");
  assert.equal(result.sources.length, 3);
  assert.equal(result.sources[0]?.title, "Announcing TypeScript 5.7");
  assert.equal(result.sources[0]?.url, "https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/");
});

test("missing-fields fixture skips invalid items safely", async () => {
  const provider = new BraveSearchProvider(
    async () =>
      new Response(JSON.stringify(missingFieldsFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { BRAVE_API_KEY: "k" },
  );

  const result = await provider.search({ query: "typescript", limit: 5 });

  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0]?.title, "Valid fallback entry");
});

test("non-200 response throws SearchProviderError with status", async () => {
  const provider = new BraveSearchProvider(
    async () =>
      new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/plain" },
      }),
    { BRAVE_API_KEY: "k" },
  );

  await assert.rejects(
    () => provider.search({ query: "typescript", limit: 5 }),
    (error) =>
      error instanceof SearchProviderError && error.status === 429 &&
      error.message === "Brave search request failed with status 429.",
  );
});

test("network errors are wrapped in deterministic provider error", async () => {
  const provider = new BraveSearchProvider(
    async () => {
      throw new Error("socket hang up");
    },
    { BRAVE_API_KEY: "k" },
  );

  await assert.rejects(
    () => provider.search({ query: "typescript", limit: 5 }),
    (error) =>
      error instanceof SearchProviderError &&
      error.message.includes("Brave search request failed: Error: socket hang up"),
  );
});

test("request id from response metadata is propagated", async () => {
  const provider = new BraveSearchProvider(
    async () =>
      new Response(JSON.stringify(successFixture), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    { BRAVE_API_KEY: "k" },
  );

  const result = await provider.search({ query: "typescript", limit: 5 });

  assert.equal(result.requestId, "req-success-123");
});

