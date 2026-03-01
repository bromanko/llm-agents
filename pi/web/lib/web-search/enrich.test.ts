import assert from "node:assert/strict";
import test from "node:test";

import { enrichSourcesWithFetch } from "./enrich.ts";
import type { SearchSource } from "./types.ts";

function makeSources(count: number): SearchSource[] {
  return Array.from({ length: count }, (_, index) => ({
    title: `Source ${index + 1}`,
    url: `https://example.com/${index + 1}`,
    snippet: `snippet ${index + 1}`,
  }));
}

test("enrichment disabled returns sources unchanged", async () => {
  const sources = makeSources(2);

  const result = await enrichSourcesWithFetch(sources, { enrich: false, fetchTop: 2 });

  assert.deepEqual(result.sources, sources);
  assert.deepEqual(result.warnings, []);
});

test("fetchTop=0 returns sources unchanged", async () => {
  const sources = makeSources(2);

  const result = await enrichSourcesWithFetch(sources, { enrich: true, fetchTop: 0 });

  assert.deepEqual(result.sources, sources);
  assert.deepEqual(result.warnings, []);
});

test("fetchTop above 5 is clamped to 5", async () => {
  const sources = makeSources(8);
  let fetchCalls = 0;

  const result = await enrichSourcesWithFetch(
    sources,
    { enrich: true, fetchTop: 99 },
    async () => {
      fetchCalls += 1;
      return { excerpt: "ok" };
    },
  );

  assert.equal(fetchCalls, 5);
  assert.equal(result.sources.filter((source) => source.fetchedExcerpt === "ok").length, 5);
});

test("only first fetchTop sources are enriched", async () => {
  const sources = makeSources(4);

  const result = await enrichSourcesWithFetch(
    sources,
    { enrich: true, fetchTop: 2 },
    async (url) => ({ excerpt: `excerpt for ${url}` }),
  );

  assert.match(result.sources[0]!.fetchedExcerpt ?? "", /excerpt for/);
  assert.match(result.sources[1]!.fetchedExcerpt ?? "", /excerpt for/);
  assert.equal(result.sources[2]!.fetchedExcerpt, undefined);
  assert.equal(result.sources[3]!.fetchedExcerpt, undefined);
});

test("per-source failure preserves source and sets fetchError + warning", async () => {
  const sources = makeSources(3);

  const result = await enrichSourcesWithFetch(
    sources,
    { enrich: true, fetchTop: 3 },
    async (url) => {
      if (url.endsWith("/2")) {
        throw new Error("timeout");
      }
      return { excerpt: "ok" };
    },
  );

  assert.equal(result.sources[1]!.fetchError, "timeout");
  assert.equal(result.sources[1]!.title, "Source 2");
  assert.equal(result.sources[0]!.fetchedExcerpt, "ok");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /Failed to fetch source 2/);
});

test("global adapter failure returns unchanged sources and warning", async () => {
  const sources = makeSources(2);

  const result = await enrichSourcesWithFetch(
    sources,
    { enrich: true, fetchTop: 2 },
    async () => {
      throw new Error("adapter unavailable");
    },
  );

  assert.deepEqual(result.sources, sources);
  assert.equal(result.sources[0]!.fetchError, undefined);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /Fetch enrichment unavailable/);
});

test("excerpt is sanitized and truncated to maxExcerptChars", async () => {
  const sources = makeSources(1);

  const result = await enrichSourcesWithFetch(
    sources,
    { enrich: true, fetchTop: 1, maxExcerptChars: 20 },
    async () => ({ excerpt: "line 1\n\nline\t2\u0000" + "x".repeat(100) }),
  );

  assert.match(result.sources[0]!.fetchedExcerpt ?? "", /… \[truncated\]$/);
  assert.doesNotMatch(result.sources[0]!.fetchedExcerpt ?? "", /\u0000/);
});

test("per-source timeout option is passed to fetch adapter", async () => {
  const sources = makeSources(1);
  const timeoutValues: number[] = [];

  await enrichSourcesWithFetch(
    sources,
    { enrich: true, fetchTop: 1, perSourceTimeoutMs: 4321 },
    async (_url, opts) => {
      timeoutValues.push(opts.timeoutMs);
      return { excerpt: "ok" };
    },
  );

  assert.deepEqual(timeoutValues, [4321]);
});
