import assert from "node:assert/strict";
import test from "node:test";

import { paginate } from "./pagination.ts";

test("returns all items when result fits in one page", () => {
  const result = paginate(["a", "b", "c"], { limit: 10, offset: 0 });
  assert.deepEqual(result, {
    items: ["a", "b", "c"],
    totalCount: 3,
    truncated: false,
    nextOffset: undefined,
  });
});

test("truncates and provides nextOffset when results exceed limit", () => {
  const result = paginate(["a", "b", "c", "d", "e"], { limit: 3, offset: 0 });
  assert.deepEqual(result, {
    items: ["a", "b", "c"],
    totalCount: 5,
    truncated: true,
    nextOffset: 3,
  });
});

test("offset shifts the visible window", () => {
  const result = paginate(["a", "b", "c", "d", "e"], { limit: 2, offset: 2 });
  assert.deepEqual(result, {
    items: ["c", "d"],
    totalCount: 5,
    truncated: true,
    nextOffset: 4,
  });
});

test("offset past the end returns empty page", () => {
  const result = paginate(["a", "b"], { limit: 10, offset: 5 });
  assert.deepEqual(result, {
    items: [],
    totalCount: 2,
    truncated: false,
    nextOffset: undefined,
  });
});

test("last page is not truncated", () => {
  const result = paginate(["a", "b", "c", "d", "e"], { limit: 3, offset: 3 });
  assert.deepEqual(result, {
    items: ["d", "e"],
    totalCount: 5,
    truncated: false,
    nextOffset: undefined,
  });
});
