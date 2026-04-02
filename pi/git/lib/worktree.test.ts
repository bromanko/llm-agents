import test from "node:test";
import assert from "node:assert/strict";

import {
  computeMainWorktreeRoot,
  linkedWorktreeOnManagedBranch,
  managedBranchRef,
  managedNameFromBranchRef,
  parseGitWorktreeList,
  toManagedGitWorktree,
} from "./worktree.ts";
import { isValidWorkspaceName } from "../../jj/lib/workspace.ts";

const PORCELAIN_FIXTURE = [
  "worktree /tmp/repo",
  "HEAD 1111111111111111111111111111111111111111",
  "branch refs/heads/main",
  "",
  "worktree /tmp/repo-ws-auth",
  "HEAD 2222222222222222222222222222222222222222",
  "branch refs/heads/pi-ws/auth",
  "",
  "worktree /tmp/repo-ws-detached",
  "HEAD 3333333333333333333333333333333333333333",
  "detached",
  "",
].join("\n");

test("parseGitWorktreeList parses main, managed, and detached records", () => {
  assert.deepEqual(parseGitWorktreeList(PORCELAIN_FIXTURE), [
    {
      path: "/tmp/repo",
      head: "1111111111111111111111111111111111111111",
      branchRef: "refs/heads/main",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: "/tmp/repo-ws-auth",
      head: "2222222222222222222222222222222222222222",
      branchRef: "refs/heads/pi-ws/auth",
      bare: false,
      detached: false,
      locked: false,
      prunable: false,
    },
    {
      path: "/tmp/repo-ws-detached",
      head: "3333333333333333333333333333333333333333",
      branchRef: null,
      bare: false,
      detached: true,
      locked: false,
      prunable: false,
    },
  ]);
});

test("managedNameFromBranchRef extracts only managed names", () => {
  assert.equal(managedNameFromBranchRef(managedBranchRef("auth")), "auth");
  assert.equal(managedNameFromBranchRef("refs/heads/feature/auth"), null);
  assert.equal(managedNameFromBranchRef(null), null);
});

test("toManagedGitWorktree ignores unrelated and detached entries", () => {
  const entries = parseGitWorktreeList(PORCELAIN_FIXTURE);

  assert.deepEqual(toManagedGitWorktree(entries[1]!), {
    name: "auth",
    path: "/tmp/repo-ws-auth",
    branchRef: "refs/heads/pi-ws/auth",
    head: "2222222222222222222222222222222222222222",
  });
  assert.equal(toManagedGitWorktree(entries[0]!), null);
  assert.equal(toManagedGitWorktree(entries[2]!), null);
});

test("workspace naming validation reuses the shared jj rule", () => {
  assert.equal(isValidWorkspaceName("auth"), true);
  assert.equal(isValidWorkspaceName("ui_refactor-2"), true);
  assert.equal(isValidWorkspaceName("bad name"), false);
  assert.equal(isValidWorkspaceName("-bad"), false);
});

test("computeMainWorktreeRoot handles linked and main worktrees", () => {
  assert.equal(computeMainWorktreeRoot("/tmp/repo-ws-auth", "/tmp/repo/.git"), "/tmp/repo");
  assert.equal(computeMainWorktreeRoot("/tmp/repo", ".git"), "/tmp/repo");
});

test("linkedWorktreeOnManagedBranch verifies the expected branch ref", () => {
  assert.equal(linkedWorktreeOnManagedBranch("refs/heads/pi-ws/auth", "auth"), true);
  assert.equal(linkedWorktreeOnManagedBranch("refs/heads/main", "auth"), false);
  assert.equal(linkedWorktreeOnManagedBranch(null, "auth"), false);
});
