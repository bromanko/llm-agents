import test from "node:test";
import assert from "node:assert/strict";

import {
  isValidWorkspaceName,
  parseWorkspaceHeads,
  parseWorkspaceNameFromOutput,
  WORKSPACE_NAME_MAX_LENGTH,
} from "./workspace.ts";

test("parseWorkspaceHeads parses colon-delimited workspace output", () => {
  assert.deepEqual(parseWorkspaceHeads("default:def000\nfeature:abc123\n"), [
    { name: "default", changeId: "def000" },
    { name: "feature", changeId: "abc123" },
  ]);
});

test("parseWorkspaceHeads also accepts pipe-delimited output", () => {
  assert.deepEqual(parseWorkspaceHeads("default|def000\nfeature|abc123\n"), [
    { name: "default", changeId: "def000" },
    { name: "feature", changeId: "abc123" },
  ]);
});

test("parseWorkspaceNameFromOutput returns the named workspace for matching change id", () => {
  assert.equal(
    parseWorkspaceNameFromOutput("abc123", "default:def000\nfeature:abc123\n"),
    "feature",
  );
});

test("parseWorkspaceNameFromOutput returns null for matching default workspace", () => {
  assert.equal(
    parseWorkspaceNameFromOutput("def000", "default:def000\nfeature:abc123\n"),
    null,
  );
});

test("parseWorkspaceNameFromOutput returns null when change id is missing", () => {
  assert.equal(
    parseWorkspaceNameFromOutput("missing", "default:def000\nfeature:abc123\n"),
    null,
  );
});

test("isValidWorkspaceName accepts valid names", () => {
  assert.equal(isValidWorkspaceName("auth"), true);
  assert.equal(isValidWorkspaceName("ui-refactor_2"), true);
});

test("isValidWorkspaceName rejects invalid names and overlong names", () => {
  assert.equal(isValidWorkspaceName("-bad"), false);
  assert.equal(isValidWorkspaceName("bad name"), false);
  assert.equal(isValidWorkspaceName("a".repeat(WORKSPACE_NAME_MAX_LENGTH + 1)), false);
});
