# Make `jj absorb` workspace-aware in `/jj-commit`

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

Today `/jj-commit` disables `jj absorb` entirely whenever a repository has multiple
workspaces. That is safe, but overly conservative. In many named workspaces, there is
a private stack of commits above shared history, and `jj absorb` can safely rewrite
only those private commits. After this change, `/jj-commit` will recover the useful
part of absorb: it will automatically absorb edits into workspace-private ancestors
when safe, while leaving shared-history edits in the working copy. Users will see
fewer unnecessary manual commits without causing stale or divergent sibling workspaces.

## Problem Framing and Constraints

The current implementation in `pi/jj/lib/commit/pipeline.ts` skips absorb whenever
`pi/jj/lib/commit/jj.ts` reports more than one workspace. The warning is accurate for
plain `jj absorb`, because its default destination set is `mutable()`, which can
include shared ancestors. Rewriting those shared ancestors makes other workspaces
stale and can cause divergence.

However, skipping absorb entirely throws away safe cases. In a named workspace with a
private descendant stack, some edits can be absorbed into commits reachable only from
that workspace's target. The solution must preserve safety first: it must never
rewrite a commit that is also an ancestor of another workspace target. If safety
cannot be proven, it must fall back to the current conservative behavior for that
change.

Constraints:

- The implementation must work using the currently installed `jj` CLI.
- It must not require out-of-band repository metadata.
- It must be computed from current workspace state in the repository.
- It must be safe in the presence of multiple named workspaces and the default
  workspace.
- It must degrade gracefully when there is no private stack to absorb into.

## Strategy Overview

Instead of treating "other workspaces exist" as a binary reason to skip absorb, the
pipeline will compute a workspace-private destination revset and pass it to
`jj absorb --into`.

The revset will be:

    mutable() & ancestors(@) & ~(ancestors(<other-workspace-targets>))

In plain language:

- `ancestors(@)` means only commits in the current workspace's history.
- `ancestors(<other-workspace-targets>)` means commits that are reachable from any
  sibling workspace target.
- subtracting those gives the current workspace's private stack.
- intersecting with `mutable()` preserves jj's normal mutability rule.

This means:

- edits whose nearest matching ancestor is private can be absorbed safely.
- edits whose nearest matching ancestor is shared will remain in `@`.
- no shared ancestor will be rewritten.

The extension will still skip absorb if workspace parsing fails. If the scoped revset
resolves to zero destination commits, jj absorb does nothing and the pipeline
continues normally.

To identify the current workspace, the code resolves `@`'s full commit ID via
`jj log -r @ -T 'self.commit_id()' --no-graph` and then filters the workspace list
to exclude entries whose `targetCommitId` matches. This is simpler and more reliable
than parsing a boolean marker from template output. It also correctly handles the edge
case where two workspaces share the same target commit: in that case both are treated
as "other" and the safe revset subtracts both, which is conservative and correct.

## Alternatives Considered

The simplest alternative is to keep the current full skip whenever other workspaces
exist. That is maximally safe, but it unnecessarily disables absorb for named
workspaces that clearly have a private stack.

Another alternative is to absorb only when there is exactly one workspace. That is the
current logic and has the same drawback.

A more ambitious alternative would be to inspect per-file or per-hunk ancestry before
invoking absorb and decide case by case whether to allow it. That is unnecessary,
because `jj absorb --into <private-stack-revset>` already gives the right behavior in
the tested scenario: safe edits absorb, unsafe ones stay in the source revision.

## Risks and Countermeasures

The main risk is computing the wrong destination revset and accidentally including
shared commits. To counter this, the implementation must add integration tests using a
real jj repository with two workspaces and verify that shared ancestors are not
rewritten.

Another risk is the default workspace. In many cases, the default workspace has no
private stack relative to a named workspace, so the computed safe destination revset
may resolve to zero commits. That is acceptable; jj absorb with an empty destination
set succeeds with "Nothing changed." and the pipeline continues normally. No special
skip or warning is needed for this case.

A third risk is revset quoting and commit-id formatting bugs. To reduce that risk, the
logic should use full 40-character hex commit IDs returned from `jj workspace list -T`
and `jj log`, not shortest IDs that may be ambiguous.

A fourth risk is `jj absorb --into <revset>` when the revset resolves to zero commits.
Verified behavior: jj succeeds with "Nothing changed." and exit code 0, so the
existing absorb result parsing will handle this correctly (it maps to
`{ changed: false }`).

A fifth risk is a fresh workspace with no ancestors above the root commit. In that case
`ancestors(@)` minus the other targets will resolve to an empty set, `jj absorb`
reports "Nothing changed.", and the pipeline continues normally. No special handling
is needed.

## Progress

- [x] (2026-04-10 16:24Z) Investigated repository history and confirmed this repo never implemented scoped multi-workspace absorb; current behavior was introduced by `c3e58275478b` and `cabd0e94ccf5`.
- [x] (2026-04-10 16:24Z) Reproduced that plain `jj absorb` rewrites shared ancestors across workspaces and leaves sibling workspaces stale.
- [x] (2026-04-10 16:24Z) Reproduced that `jj absorb --into 'ancestors(@) ~ ancestors(<other-target>)'` safely absorbs only private-stack edits and leaves shared-history edits in the working copy.
- [ ] Milestone 1, step 1: Add `WorkspaceTarget` interface to `pi/jj/lib/commit/jj.ts`.
- [ ] Milestone 1, step 2: Add `parseWorkspaceListOutput()` to `pi/jj/lib/commit/jj.ts`.
- [ ] Milestone 1, step 3: Write unit tests for `parseWorkspaceListOutput()` in `pi/jj/lib/commit/jj.test.ts`.
- [ ] Milestone 1, step 4: Run `pi/jj/lib/commit/jj.test.ts` — new parsing tests pass.
- [ ] Milestone 1, step 5: Add `buildScopedAbsorbRevset()` to `pi/jj/lib/commit/jj.ts`.
- [ ] Milestone 1, step 6: Write unit tests for `buildScopedAbsorbRevset()` in `pi/jj/lib/commit/jj.test.ts`.
- [ ] Milestone 1, step 7: Run `pi/jj/lib/commit/jj.test.ts` — revset builder tests pass.
- [ ] Milestone 1, step 8: Add `listWorkspaceTargets()` and `getCurrentCommitId()` to `ControlledJj`.
- [ ] Milestone 1, step 9: Add `getScopedAbsorbRevset()` to `ControlledJj`.
- [ ] Milestone 1, step 10: Add optional `intoRevset` parameter to `ControlledJj.absorb()`.
- [ ] Milestone 1, step 11: Write integration tests for workspace helpers in `pi/jj/lib/commit/jj.test.ts`.
- [ ] Milestone 1, step 12: Run `pi/jj/lib/commit/jj.test.ts` — all tests pass. Commit.
- [ ] Milestone 2, step 1: Write new pipeline test — multi-workspace with private targets calls scoped absorb.
- [ ] Milestone 2, step 2: Write new pipeline test — plain absorb when getScopedAbsorbRevset returns null.
- [ ] Milestone 2, step 3: Write new pipeline test — workspace query failure skips absorb conservatively.
- [ ] Milestone 2, step 4: Run `pi/jj/lib/commit/pipeline.test.ts` — new tests fail (red).
- [ ] Milestone 2, step 5: Replace binary skip logic in `pi/jj/lib/commit/pipeline.ts` with scoped absorb logic.
- [ ] Milestone 2, step 6: Run `pi/jj/lib/commit/pipeline.test.ts` — all tests pass (green). Commit.
- [ ] Milestone 3, step 1: Write integration test — scoped absorb in multi-workspace repo.
- [ ] Milestone 3, step 2: Run `pi/jj/lib/commit/jj.test.ts` — integration test passes. Commit.
- [ ] Milestone 3, step 3: Run full test suite.
- [ ] Milestone 3, step 4: Manual validation in temp repo.

## Surprises & Discoveries

- Observation: this repository never contained a smarter "workspace-private absorb" implementation. It started with plain `jj absorb` and later added a blanket skip when other workspaces exist.
  Evidence: file history for `pi/jj/lib/commit/pipeline.ts`, `pi/jj/lib/commit/jj.ts`, and `pi/jj/lib/commit/pipeline.test.ts` shows initial `/jj-commit` in `74c98cc558ed`, `hasOtherWorkspaces()` in `c3e58275478b`, and the skip guard in `cabd0e94ccf5`, with no intervening scoped absorb logic.

- Observation: plain `jj absorb` rewrites shared ancestors across workspaces and leaves sibling workspaces stale.
  Evidence: temp repo experiment produced `Absorbed changes into 2 revisions`, including the shared ancestor, and the sibling workspace then reported a stale working copy.

- Observation: `jj absorb --into 'ancestors(@) ~ ancestors(<other-target>)'` safely absorbed only the private-stack edit and left the shared-history edit in the working copy.
  Evidence: temp repo experiment after restricted absorb showed only the shared-history file still modified, while the sibling workspace remained unaffected.

- Observation: `jj absorb --into 'none()'` succeeds with "Nothing changed." and exit code 0 when the revset resolves to zero commits. No special handling is needed for the empty-destination case.

- Observation: `jj log -r @ -T 'self.commit_id()' --no-graph` returns the full 40-character hex commit ID for the current workspace's working-copy commit. This is the most reliable way to identify the current workspace from the workspace list.

## Decision Log

- Decision: use `jj absorb --into <workspace-private-revset>` instead of inventing a custom per-file absorb planner.
  Rationale: jj already leaves unresolved changes in the source revision when no allowed destination applies, which matches the desired safe behavior.
  Date: 2026-04-10

- Decision: define workspace-private destinations as `mutable() & ancestors(@) & ~(ancestors(<other-workspace-targets>))`.
  Rationale: this excludes all commits shared with any sibling workspace target while preserving the current workspace's private stack.
  Date: 2026-04-10

- Decision: keep the fallback conservative when workspace parsing fails or the safe revset would be empty.
  Rationale: this preserves the current safety guarantee and limits the blast radius of bugs in revset construction.
  Date: 2026-04-10

- Decision: identify the current workspace by resolving `@`'s commit ID via `jj log -r @ -T 'self.commit_id()' --no-graph` and filtering the workspace list by target commit ID match.
  Rationale: simpler and more reliable than adding a boolean column to the workspace-list template. Correctly handles the edge case where two workspaces share the same target (both are treated as "other," which is conservative).
  Date: 2026-04-10

- Decision: add an optional `intoRevset` parameter to the existing `ControlledJj.absorb()` method rather than creating a separate method.
  Rationale: the method already handles absorb's success/failure parsing; adding a parameter is minimal and avoids duplication. When `intoRevset` is provided, the CLI args include `--into <revset>`; when omitted, behavior is unchanged.
  Date: 2026-04-10

- Decision: expose `parseWorkspaceListOutput()` and `buildScopedAbsorbRevset()` as exported free functions (not class methods) so they can be unit-tested without mocking the jj CLI.
  Rationale: matches the existing pattern of `parseHunks()` in the same file — a pure function exported alongside the class.
  Date: 2026-04-10

## Outcomes & Retrospective

(To be filled at major milestones and at completion.)

## Context and Orientation

`pi/jj/lib/commit/jj.ts` is the CLI adapter for jj operations such as `diff`, `stat`,
`commit`, `absorb`, and workspace queries. It exports a `ControlledJj` class whose
methods shell out to the `jj` binary and return structured results. It also exports
pure helper functions like `parseHunks()` that can be tested without a jj binary.
`pi/jj/lib/commit/jj.test.ts` tests both the pure helpers (always run) and the
`ControlledJj` methods (run only when jj is available, gated by `{ skip: !HAS_JJ }`).

`pi/jj/lib/commit/pipeline.ts` orchestrates the `/jj-commit` flow: check for changes,
optionally run absorb, resolve a model, run an agentic session, apply changelog
entries, and execute commits. The absorb decision currently lives in step 2 of
`runCommitPipeline()`. `pi/jj/lib/commit/pipeline.test.ts` tests pipeline behavior
using a `createMockJj()` helper that returns a mock object matching the `ControlledJj`
interface. The existing test `pipeline: skips absorb when other workspaces exist`
asserts that `absorb()` is never called and a warning is emitted.

`test/extensions/jj-commit.test.ts` and `test/extensions/jj-commit.model.test.ts` are
higher-level extension registration and argument-parsing tests. They do not exercise
absorb behavior and should not need changes, but must remain green.

Today `ControlledJj.absorb()` takes no arguments and runs `jj absorb` with no flags.
Today `ControlledJj.hasOtherWorkspaces()` runs `jj workspace list`, counts non-empty
lines, and returns `true` if there are 2+.

## Preconditions and Verified Facts

The current tree contains:

- `pi/jj/lib/commit/jj.ts` with `absorb()` and `hasOtherWorkspaces()`.
- `pi/jj/lib/commit/pipeline.ts` with a hard skip when other workspaces exist.
- `pi/jj/lib/commit/pipeline.test.ts` with a test named
  `pipeline: skips absorb when other workspaces exist`.
- `pi/jj/lib/commit/jj.test.ts` with pure-function tests for `parseHunks`, `JjError`,
  and `runJj`, plus integration tests for `ControlledJj` gated by `HAS_JJ`.

The installed jj version exposes:

- `jj absorb --into <REVSETS>` (the `--into` flag, alias `--to`).
- `jj workspace list -T <TEMPLATE>` with `WorkspaceRef` type supporting `.name()`,
  `.target()` (returns a `Commit`), and `.target().commit_id()`.
- `jj log -r @ -T 'self.commit_id()' --no-graph` returns the full 40-char hex
  commit ID of the current workspace's working-copy commit.

Verified behaviors:

- `jj absorb --into 'none()'` succeeds with "Nothing changed." and exit code 0.
- `jj absorb --into '<revset>'` only rewrites commits matching the revset; changes
  with no matching destination remain in the source revision.

## Scope Boundaries

In scope:

- smarter absorb target computation for `/jj-commit`.
- new pure helper functions in `pi/jj/lib/commit/jj.ts`.
- new methods on `ControlledJj` in `pi/jj/lib/commit/jj.ts`.
- modified `absorb()` signature on `ControlledJj` (optional parameter added).
- pipeline behavior changes in `pi/jj/lib/commit/pipeline.ts`.
- unit tests in `pi/jj/lib/commit/jj.test.ts`.
- pipeline tests in `pi/jj/lib/commit/pipeline.test.ts`.

Out of scope:

- changing jj itself.
- new UI commands.
- changing `/git-commit`.
- any hunk-level custom absorb planner beyond jj's built-in behavior.

## Milestones

### Milestone 1: Workspace-aware helpers and absorb interface

Teach the jj adapter to return structured workspace information and compute safe
absorb revsets. At the end of this milestone, pure-function unit tests prove that
workspace-list output is parsed correctly, revsets are constructed correctly for
various edge cases, and the `absorb()` method accepts an optional `--into` revset.
Integration tests (gated by jj availability) prove that `listWorkspaceTargets()`,
`getCurrentCommitId()`, and `getScopedAbsorbRevset()` work against a real jj repo
with two workspaces.

### Milestone 2: Pipeline integration

Wire the new helpers into the pipeline. At the end of this milestone, the pipeline
calls `getScopedAbsorbRevset()` to determine the absorb strategy: if it returns a
revset string, absorb runs with `--into`; if it returns null, absorb runs plain
(single workspace or shared targets); if it throws, absorb is skipped conservatively
with a warning. When the scoped revset resolves to zero destination commits, jj does
nothing and the pipeline continues normally. Single-workspace behavior is unchanged.

### Milestone 3: Full-stack validation

An integration test using a real jj repo with two workspaces proves that scoped
absorb only rewrites private-stack commits and does not make sibling workspaces stale.
The full test suite passes. Manual validation in a temp repo confirms end-to-end
behavior.

## Concrete Steps

All commands run from the repository root unless stated otherwise. The test runner is:

    node --experimental-strip-types --test <file>

### Step 0: Verify baseline

Run the existing test suites to confirm the starting state is green.

    node --experimental-strip-types --test pi/jj/lib/commit/jj.test.ts

Expected: all tests pass (pure-function tests always; integration tests if jj is
available).

    node --experimental-strip-types --test pi/jj/lib/commit/pipeline.test.ts

Expected: all tests pass, including `pipeline: skips absorb when other workspaces exist`.

### Step 1: Add `WorkspaceTarget` interface

In `pi/jj/lib/commit/jj.ts`, after the `DiffHunk` interface (around line 12), add:

    export interface WorkspaceTarget {
      name: string;
      targetCommitId: string;
    }

No tests needed for this step alone.

### Step 2: Add `parseWorkspaceListOutput()` pure function

In `pi/jj/lib/commit/jj.ts`, after the `parseHunks()` function at the bottom of the
file, add an exported free function:

    export function parseWorkspaceListOutput(raw: string): WorkspaceTarget[]

This function takes the raw stdout of
`jj workspace list -T 'name ++ "\x1f" ++ self.target().commit_id() ++ "\n"'` and
returns an array of `WorkspaceTarget`. It splits on `\n`, filters out blank lines,
splits each line on `\x1f` (ASCII unit separator, character code 31), and returns
`{ name, targetCommitId }` for each valid line. Lines that do not contain exactly one
`\x1f` separator are silently skipped (defensive against unexpected output).

### Step 3: Write unit tests for `parseWorkspaceListOutput()`

In `pi/jj/lib/commit/jj.test.ts`, add these tests after the existing `parseHunks`
tests (before the `JjError` section). Import `parseWorkspaceListOutput` from
`./jj.ts` at the top of the file alongside the existing imports.

Test 1 — two workspaces:

    test("parseWorkspaceListOutput: parses two workspaces", () => {
      const raw = "default\x1fabc123def456abc123def456abc123def456abcd\n" +
                  "feature\x1f9876543210abcdef9876543210abcdef98765432\n";
      const result = parseWorkspaceListOutput(raw);
      assert.equal(result.length, 2);
      assert.deepStrictEqual(result[0], {
        name: "default",
        targetCommitId: "abc123def456abc123def456abc123def456abcd",
      });
      assert.deepStrictEqual(result[1], {
        name: "feature",
        targetCommitId: "9876543210abcdef9876543210abcdef98765432",
      });
    });

Test 2 — single workspace:

    test("parseWorkspaceListOutput: parses single workspace", () => {
      const raw = "default\x1fabc123def456abc123def456abc123def456abcd\n";
      const result = parseWorkspaceListOutput(raw);
      assert.equal(result.length, 1);
      assert.equal(result[0].name, "default");
    });

Test 3 — empty output:

    test("parseWorkspaceListOutput: returns empty array for empty output", () => {
      assert.deepStrictEqual(parseWorkspaceListOutput(""), []);
      assert.deepStrictEqual(parseWorkspaceListOutput("\n"), []);
      assert.deepStrictEqual(parseWorkspaceListOutput("\n\n"), []);
    });

Test 4 — trailing newline and blank lines:

    test("parseWorkspaceListOutput: handles trailing newlines and blank lines", () => {
      const raw = "default\x1fabc123\n\n\nfeature\x1fdef456\n\n";
      const result = parseWorkspaceListOutput(raw);
      assert.equal(result.length, 2);
    });

Test 5 — malformed lines are skipped:

    test("parseWorkspaceListOutput: skips malformed lines", () => {
      const raw = "default\x1fabc123\ngarbage-no-separator\nfeature\x1fdef456\n";
      const result = parseWorkspaceListOutput(raw);
      assert.equal(result.length, 2);
      assert.equal(result[0].name, "default");
      assert.equal(result[1].name, "feature");
    });

### Step 4: Run parser tests

    node --experimental-strip-types --test pi/jj/lib/commit/jj.test.ts

Expected: all existing tests still pass, and the 5 new `parseWorkspaceListOutput`
tests pass.

### Step 5: Add `buildScopedAbsorbRevset()` pure function

In `pi/jj/lib/commit/jj.ts`, after `parseWorkspaceListOutput()`, add:

    export function buildScopedAbsorbRevset(
      otherTargetCommitIds: string[],
    ): string | null

Behavior:

- If `otherTargetCommitIds` is empty, return `null`. This signals that plain absorb
  is safe (no other workspaces to protect). The caller decides whether to run absorb
  with no `--into` or to pass `mutable()` as the default.
- If non-empty, return the string:
  `mutable() & ancestors(@) & ~(ancestors(<id1> | <id2> | ...))` where each ID is a
  full commit ID from the input array. Use double quotes around each commit ID in the
  revset to avoid ambiguity, e.g.:
  `mutable() & ancestors(@) & ~(ancestors("abc123" | "def456"))`.

### Step 6: Write unit tests for `buildScopedAbsorbRevset()`

In `pi/jj/lib/commit/jj.test.ts`, add these tests after the `parseWorkspaceListOutput`
tests. Import `buildScopedAbsorbRevset` from `./jj.ts`.

Test 1 — no other targets:

    test("buildScopedAbsorbRevset: returns null when no other targets", () => {
      assert.equal(buildScopedAbsorbRevset([]), null);
    });

Test 2 — single other target:

    test("buildScopedAbsorbRevset: single other target", () => {
      const result = buildScopedAbsorbRevset(["abc123def456abc123def456abc123def456abcd"]);
      assert.equal(
        result,
        'mutable() & ancestors(@) & ~(ancestors("abc123def456abc123def456abc123def456abcd"))',
      );
    });

Test 3 — multiple other targets:

    test("buildScopedAbsorbRevset: multiple other targets", () => {
      const result = buildScopedAbsorbRevset(["aaa111", "bbb222", "ccc333"]);
      assert.equal(
        result,
        'mutable() & ancestors(@) & ~(ancestors("aaa111" | "bbb222" | "ccc333"))',
      );
    });

### Step 7: Run revset builder tests

    node --experimental-strip-types --test pi/jj/lib/commit/jj.test.ts

Expected: all existing tests pass, all parsing tests pass, and the 3 new
`buildScopedAbsorbRevset` tests pass.

### Step 8: Add `listWorkspaceTargets()` and `getCurrentCommitId()` to `ControlledJj`

In `pi/jj/lib/commit/jj.ts`, add two new methods to the `ControlledJj` class.

Method 1 — `listWorkspaceTargets()`:

    async listWorkspaceTargets(): Promise<WorkspaceTarget[]> {
      const { stdout } = await runJj(this.cwd, [
        "workspace", "list", "-T",
        'name ++ "\x1f" ++ self.target().commit_id() ++ "\n"',
      ]);
      return parseWorkspaceListOutput(stdout);
    }

Method 2 — `getCurrentCommitId()`:

    async getCurrentCommitId(): Promise<string> {
      const { stdout } = await runJj(this.cwd, [
        "log", "-r", "@", "-T", "self.commit_id()", "--no-graph",
      ]);
      return stdout.trim();
    }

### Step 9: Add `getScopedAbsorbRevset()` to `ControlledJj`

In `pi/jj/lib/commit/jj.ts`, add:

    async getScopedAbsorbRevset(): Promise<string | null> {
      const workspaces = await this.listWorkspaceTargets();
      if (workspaces.length <= 1) {
        return null;
      }
      const currentId = await this.getCurrentCommitId();
      const otherTargetIds = workspaces
        .filter((ws) => ws.targetCommitId !== currentId)
        .map((ws) => ws.targetCommitId);
      if (otherTargetIds.length === 0) {
        return null;
      }
      return buildScopedAbsorbRevset(otherTargetIds);
    }

This method returns `null` when plain absorb is safe (single workspace, or no other
targets after filtering). It returns a revset string when absorb needs scoping. It
throws if the jj commands fail; callers handle that.

### Step 10: Add optional `intoRevset` parameter to `ControlledJj.absorb()`

In `pi/jj/lib/commit/jj.ts`, change the `absorb()` method signature from:

    async absorb(): Promise<{ changed: boolean; output: string }>

to:

    async absorb(intoRevset?: string): Promise<{ changed: boolean; output: string }>

Inside the method, change the `runJj` call from:

    const { stdout, stderr } = await runJj(this.cwd, ["absorb"]);

to:

    const args = ["absorb"];
    if (intoRevset) {
      args.push("--into", intoRevset);
    }
    const { stdout, stderr } = await runJj(this.cwd, args);

All existing callers pass no arguments, so their behavior is unchanged.

### Step 11: Write integration tests for workspace helpers

In `pi/jj/lib/commit/jj.test.ts`, add these integration tests in the section with the
other `ControlledJj` integration tests (after the existing `setBookmark + pushBookmark`
test). These are gated by `{ skip: !HAS_JJ }`. They use the existing `createTempJjRepo`
helper and `execFileSync` from `node:child_process` (already imported in the file).

Test 1 — `listWorkspaceTargets` returns all workspaces:

    test("ControlledJj.listWorkspaceTargets: returns all workspaces", { skip: !HAS_JJ }, async () => {
      const dir = createTempJjRepo();
      try {
        // Create a commit so there is history
        fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
        execFileSync("jj", ["commit", "-m", "base"], { cwd: dir, timeout: 5000 });

        // Add a second workspace
        const ws2Dir = dir + "-ws2";
        execFileSync("jj", ["workspace", "add", ws2Dir], { cwd: dir, timeout: 10000 });

        const jj = new ControlledJj(dir);
        const targets = await jj.listWorkspaceTargets();
        assert.equal(targets.length, 2);
        const names = targets.map((t) => t.name).sort();
        assert.deepStrictEqual(names, ["default", path.basename(ws2Dir)]);
        // Each target should have a 40-char hex commit ID
        for (const t of targets) {
          assert.match(t.targetCommitId, /^[0-9a-f]{40}$/);
        }

        fs.rmSync(ws2Dir, { recursive: true, force: true });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

Test 2 — `getCurrentCommitId` returns 40-char hex:

    test("ControlledJj.getCurrentCommitId: returns 40-char hex commit id", { skip: !HAS_JJ }, async () => {
      const dir = createTempJjRepo();
      try {
        const jj = new ControlledJj(dir);
        const id = await jj.getCurrentCommitId();
        assert.match(id, /^[0-9a-f]{40}$/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

Test 3 — `getScopedAbsorbRevset` returns null for single workspace:

    test("ControlledJj.getScopedAbsorbRevset: returns null for single workspace", { skip: !HAS_JJ }, async () => {
      const dir = createTempJjRepo();
      try {
        const jj = new ControlledJj(dir);
        const revset = await jj.getScopedAbsorbRevset();
        assert.equal(revset, null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

Test 4 — `getScopedAbsorbRevset` returns a revset string for multi-workspace repo:

    test("ControlledJj.getScopedAbsorbRevset: returns revset for multi-workspace", { skip: !HAS_JJ }, async () => {
      const dir = createTempJjRepo();
      try {
        fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
        execFileSync("jj", ["commit", "-m", "base"], { cwd: dir, timeout: 5000 });

        const ws2Dir = dir + "-ws2";
        execFileSync("jj", ["workspace", "add", ws2Dir], { cwd: dir, timeout: 10000 });

        const jj = new ControlledJj(dir);
        const revset = await jj.getScopedAbsorbRevset();
        assert.ok(revset !== null, "should return a revset string");
        assert.ok(revset!.includes("mutable()"), "revset should include mutable()");
        assert.ok(revset!.includes("ancestors(@)"), "revset should include ancestors(@)");
        assert.ok(revset!.includes("ancestors("), "revset should subtract other targets");

        fs.rmSync(ws2Dir, { recursive: true, force: true });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

Test 5 — `absorb` with `intoRevset` passes `--into` flag:

    test("ControlledJj.absorb: accepts optional intoRevset", { skip: !HAS_JJ }, async () => {
      const dir = createTempJjRepo();
      try {
        fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");
        execFileSync("jj", ["commit", "-m", "base"], { cwd: dir, timeout: 5000 });
        // Edit the file
        fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");

        const jj = new ControlledJj(dir);
        // absorb with none() revset — should succeed with nothing changed
        const result = await jj.absorb("none()");
        assert.equal(result.changed, false);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

### Step 12: Run all jj adapter tests and commit

    node --experimental-strip-types --test pi/jj/lib/commit/jj.test.ts

Expected: all existing tests pass, all new pure-function tests pass, all new
integration tests pass (or skip if jj is not available).

Commit with message: `feat(jj-commit): add workspace-aware absorb helpers`

This commit adds `WorkspaceTarget`, `parseWorkspaceListOutput()`,
`buildScopedAbsorbRevset()`, `listWorkspaceTargets()`, `getCurrentCommitId()`,
`getScopedAbsorbRevset()`, and the optional `intoRevset` parameter on `absorb()`,
along with all their tests.

### Step 13: Write new pipeline tests (red phase)

In `pi/jj/lib/commit/pipeline.test.ts`, update the `MockJjOptions` interface and
`createMockJj()` helper to support the new methods. Add these fields to
`MockJjOptions`:

    scopedAbsorbRevset?: string | null;
    scopedAbsorbRevsetError?: boolean;

Add these mock methods to the object returned by `createMockJj()`:

    getScopedAbsorbRevset: async () => {
      if (opts.scopedAbsorbRevsetError) {
        throw new Error("workspace query failed");
      }
      return opts.scopedAbsorbRevset ?? null;
    },

Also update the `absorb` mock to capture the `intoRevset` argument:

    absorb: async (intoRevset?: string) => {
      // Store the intoRevset for assertion
      (jjObj as any)._lastAbsorbRevset = intoRevset;
      return opts.absorbResult ?? { changed: false, output: "" };
    },

Then replace the existing test `pipeline: skips absorb when other workspaces exist`
with these three new tests.

The pipeline's decision tree for absorb is:

1. Call `getScopedAbsorbRevset()`.
2. If it returns a string: run `absorb(revset)` with `--into`.
3. If it returns null: run `absorb()` plain (no other workspaces, or other workspaces
   share the same target — plain absorb is safe).
4. If it throws: skip absorb, emit warning.

There is no separate "other workspaces exist but absorb is skipped" case. If other
workspaces have different targets, `getScopedAbsorbRevset()` returns a revset and
absorb runs with `--into`. If `--into` resolves to zero destination commits, jj does
nothing ("Nothing changed.") and the pipeline continues normally.

Test 1 — scoped absorb when `getScopedAbsorbRevset()` returns a revset:

    test("pipeline: runs scoped absorb with revset from getScopedAbsorbRevset", async () => {
      let absorbCalled = false;
      let capturedRevset: string | undefined;
      const scopedRevset = 'mutable() & ancestors(@) & ~(ancestors("abc123"))';
      const jj = createMockJj({
        changedFiles: ["src/main.ts"],
        diff: "diff",
        stat: "stat",
        scopedAbsorbRevset: scopedRevset,
      });
      jj.absorb = async (intoRevset?: string) => {
        absorbCalled = true;
        capturedRevset = intoRevset;
        return { changed: false, output: "" };
      };

      const ctx = createBasicContext({ jj: jj as any });
      await runCommitPipeline(ctx);
      assert.ok(absorbCalled, "absorb should have been called");
      assert.equal(capturedRevset, scopedRevset);
    });

Test 2 — plain absorb when `getScopedAbsorbRevset()` returns null:

    test("pipeline: runs plain absorb when getScopedAbsorbRevset returns null", async () => {
      let absorbCalled = false;
      let capturedRevset: string | undefined;
      const jj = createMockJj({
        changedFiles: ["src/main.ts"],
        diff: "diff",
        stat: "stat",
        scopedAbsorbRevset: null,
      });
      jj.absorb = async (intoRevset?: string) => {
        absorbCalled = true;
        capturedRevset = intoRevset;
        return { changed: false, output: "" };
      };

      const ctx = createBasicContext({ jj: jj as any });
      await runCommitPipeline(ctx);
      assert.ok(absorbCalled, "absorb should have been called");
      assert.equal(capturedRevset, undefined, "should run plain absorb without --into");
    });

Test 3 — absorb skipped when `getScopedAbsorbRevset()` throws:

    test("pipeline: skips absorb when workspace query fails", async () => {
      let absorbCalled = false;
      const jj = createMockJj({
        changedFiles: ["src/main.ts"],
        diff: "diff",
        stat: "stat",
        scopedAbsorbRevsetError: true,
      });
      jj.absorb = async () => {
        absorbCalled = true;
        return { changed: false, output: "" };
      };

      const ctx = createBasicContext({ jj: jj as any });
      const result = await runCommitPipeline(ctx);
      assert.ok(!absorbCalled, "absorb should not be called when workspace query fails");
      assert.ok(result.warnings.some((w) => w.includes("Could not determine workspace")));
    });

### Step 14: Run pipeline tests (red phase)

    node --experimental-strip-types --test pi/jj/lib/commit/pipeline.test.ts

Expected: the three new tests fail because the pipeline still uses the old
`hasOtherWorkspaces()` logic. The old test
`pipeline: skips absorb when other workspaces exist` will also fail or need removal.
All other existing tests should still pass.

### Step 15: Update pipeline absorb logic

In `pi/jj/lib/commit/pipeline.ts`, replace the absorb pre-pass block (step 2 in
`runCommitPipeline`) with the new logic. The current code:

    if (!args.noAbsorb) {
      let absorbSafe = true;
      try {
        const hasOthers = await jj.hasOtherWorkspaces();
        if (hasOthers) {
          absorbSafe = false;
          warnings.push(
            "Skipping jj absorb: other workspaces detected. " +
            "Absorb rewrites ancestor commits which causes divergent commits across workspaces.",
          );
        }
      } catch {
        absorbSafe = false;
        warnings.push("Could not check for other workspaces; skipping absorb to be safe.");
      }

      if (absorbSafe) {
        progress("Running jj absorb...");
        try {
          const absorbResult = await jj.absorb();
          if (absorbResult.changed) {
            progress(`Absorb applied: ${absorbResult.output}`);
            changedFiles = await jj.getChangedFiles();
            if (changedFiles.length === 0) {
              return {
                committed: false,
                summary: "All changes were absorbed into ancestor commits.",
                warnings,
                messages,
              };
            }
          }
        } catch {
          warnings.push("jj absorb failed; continuing without absorb.");
        }
      }
    }

Replace it with:

    if (!args.noAbsorb) {
      let absorbRevset: string | undefined;
      let absorbAllowed = true;

      try {
        const scoped = await jj.getScopedAbsorbRevset();
        // scoped is null when no other workspaces → plain absorb is safe.
        // scoped is a revset string → pass to absorb --into.
        absorbRevset = scoped ?? undefined;
      } catch {
        absorbAllowed = false;
        warnings.push("Could not determine workspace absorb targets; skipping absorb to be safe.");
      }

      if (absorbAllowed) {
        progress("Running jj absorb...");
        try {
          const absorbResult = await jj.absorb(absorbRevset);
          if (absorbResult.changed) {
            progress(`Absorb applied: ${absorbResult.output}`);
            changedFiles = await jj.getChangedFiles();
            if (changedFiles.length === 0) {
              return {
                committed: false,
                summary: "All changes were absorbed into ancestor commits.",
                warnings,
                messages,
              };
            }
          }
        } catch {
          warnings.push("jj absorb failed; continuing without absorb.");
        }
      }
    }

Remove the existing `hasOtherWorkspaces` call from the pipeline. The method can remain
on `ControlledJj` for backward compatibility, but the pipeline no longer uses it.

### Step 16: Remove old pipeline test, run tests (green phase)

Remove the test `pipeline: skips absorb when other workspaces exist` from
`pi/jj/lib/commit/pipeline.test.ts`. It is replaced by the three new tests from step 13.

Also update the existing test `pipeline: runs absorb when not disabled` to add
`getScopedAbsorbRevset` to its mock (returning `null` so plain absorb runs). Update
`createMockJj` to always include `getScopedAbsorbRevset`.

    node --experimental-strip-types --test pi/jj/lib/commit/pipeline.test.ts

Expected: all tests pass, including the three new workspace-aware tests.

Commit with message: `feat(jj-commit): replace blanket absorb skip with workspace-scoped absorb`

### Step 17: Write integration test for scoped absorb safety

In `pi/jj/lib/commit/jj.test.ts`, add this integration test at the end of the file:

    test("ControlledJj: scoped absorb only rewrites private-stack commits", { skip: !HAS_JJ }, async () => {
      const dir = createTempJjRepo();
      const ws2Dir = dir + "-ws2";
      try {
        // Create shared base commit
        fs.writeFileSync(path.join(dir, "shared.txt"), "shared content\n");
        execFileSync("jj", ["commit", "-m", "shared base"], { cwd: dir, timeout: 5000 });

        // Add second workspace (branches off from shared base)
        execFileSync("jj", ["workspace", "add", ws2Dir], { cwd: dir, timeout: 10000 });

        // In default workspace, create a private commit on top of shared base
        fs.writeFileSync(path.join(dir, "private.txt"), "private content\n");
        execFileSync("jj", ["commit", "-m", "default private change"], { cwd: dir, timeout: 5000 });

        // Now edit both files in the default workspace's working copy
        fs.writeFileSync(path.join(dir, "shared.txt"), "shared MODIFIED\n");
        fs.writeFileSync(path.join(dir, "private.txt"), "private MODIFIED\n");

        // Get the scoped revset and run absorb
        const jj = new ControlledJj(dir);
        const revset = await jj.getScopedAbsorbRevset();
        assert.ok(revset !== null, "should have a scoped revset with two workspaces");

        const result = await jj.absorb(revset!);

        // The private file edit should have been absorbed
        // The shared file edit should remain in working copy
        const remaining = await jj.getChangedFiles();
        assert.ok(
          remaining.includes("shared.txt"),
          "shared.txt edit should remain in working copy (not absorbed into shared history)",
        );

        // Verify sibling workspace is not stale by running jj status in ws2
        // If the workspace were stale, jj would print a warning about it.
        // We check by running jj log in the sibling workspace — it should work
        // without any "stale" or "working copy is behind" messages.
        const ws2Result = execFileSync("jj", ["--color=never", "log", "-r", "@", "--no-graph", "-T", "description.first_line()"], {
          cwd: ws2Dir,
          encoding: "utf-8",
          timeout: 5000,
        });
        // The sibling workspace should not see any changes from the absorb
        // (its working copy should not be stale)
        const ws2Status = execFileSync("jj", ["--color=never", "status"], {
          cwd: ws2Dir,
          encoding: "utf-8",
          timeout: 5000,
        });
        assert.ok(
          !ws2Status.includes("stale"),
          "sibling workspace should not be stale after scoped absorb",
        );

        fs.rmSync(ws2Dir, { recursive: true, force: true });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        try { fs.rmSync(ws2Dir, { recursive: true, force: true }); } catch {}
      }
    });

### Step 18: Run integration test

    node --experimental-strip-types --test pi/jj/lib/commit/jj.test.ts

Expected: all tests pass. The new integration test proves the core safety claim.

Commit with message: `test(jj-commit): add integration test proving scoped absorb safety`

### Step 19: Run full test suite

    node --experimental-strip-types --test pi/jj/lib/commit/*.test.ts

Expected: all tests in all test files pass.

    node --experimental-strip-types --test test/extensions/jj-commit*.test.ts

Expected: all extension-level tests pass. These tests exercise command registration
and argument parsing, not absorb logic, so they should be unaffected.

### Step 20: Manual validation

Create a temporary jj repo with two workspaces and verify end-to-end behavior:

    cd /tmp
    rm -rf manual-absorb-test manual-absorb-test-ws2
    mkdir manual-absorb-test && cd manual-absorb-test
    jj git init --colocate
    jj config set --repo user.name "Test"
    jj config set --repo user.email "test@test.com"

    # Create shared base
    echo "shared" > shared.txt
    jj commit -m "shared base"

    # Add sibling workspace
    jj workspace add ../manual-absorb-test-ws2

    # Create private stack in default workspace
    echo "private" > private.txt
    jj commit -m "default private commit"

    # Edit both files
    echo "shared MODIFIED" > shared.txt
    echo "private MODIFIED" > private.txt

    # Check what getScopedAbsorbRevset would produce
    jj workspace list -T 'name ++ "\x1f" ++ self.target().commit_id() ++ "\n"'
    jj log -r @ -T 'self.commit_id()' --no-graph

    # Run scoped absorb manually
    # (substitute the actual other-workspace target commit ID below)
    jj absorb --into 'mutable() & ancestors(@) & ~(ancestors("<other-target-id>"))'

    # Verify: shared.txt edit should still be in working copy
    jj diff --name-only
    # Expected output includes shared.txt, does NOT include private.txt

    # Verify: sibling workspace is not stale
    cd ../manual-absorb-test-ws2
    jj status
    # Expected: no "stale" warning

    # Cleanup
    cd /tmp
    rm -rf manual-absorb-test manual-absorb-test-ws2

## Testing and Falsifiability

The plan adds these categories of tests:

Pure-function unit tests in `pi/jj/lib/commit/jj.test.ts` (always run, no jj needed):

1. `parseWorkspaceListOutput`: 5 tests covering two workspaces, single workspace,
   empty output, trailing newlines, and malformed lines. Each test specifies exact
   input strings and exact expected output.
2. `buildScopedAbsorbRevset`: 3 tests covering empty input (returns null), single
   target (exact revset string), and multiple targets (exact revset string with `|`
   separator).

Integration tests in `pi/jj/lib/commit/jj.test.ts` (gated by `{ skip: !HAS_JJ }`):

3. `listWorkspaceTargets` returns correctly parsed entries from a real two-workspace
   repo.
4. `getCurrentCommitId` returns a 40-char hex string.
5. `getScopedAbsorbRevset` returns null for a single-workspace repo.
6. `getScopedAbsorbRevset` returns a valid revset string for a multi-workspace repo.
7. `absorb` with `intoRevset` passes the `--into` flag correctly.
8. **Core safety test**: scoped absorb in a multi-workspace repo only absorbs the
   private-stack edit, leaves the shared-history edit in `@`, and does not make the
   sibling workspace stale.

Pipeline behavior tests in `pi/jj/lib/commit/pipeline.test.ts` (mock-based):

9. Scoped absorb runs with the revset when `getScopedAbsorbRevset` returns a string.
10. Plain absorb runs when `getScopedAbsorbRevset` returns null.
11. Absorb is skipped with a warning when `getScopedAbsorbRevset` throws.

The plan is falsified if any of the following occur:

- The integration test in item 8 fails: a sibling workspace reports "stale" after
  scoped absorb, or shared.txt is not in the remaining changed files.
- The pipeline test in item 9 shows that absorb is called without the `--into` revset
  when other workspaces exist.
- The pipeline test in item 11 shows that absorb is called despite a workspace query
  failure.

## Validation and Acceptance

Acceptance is behavior-based:

1. In a single-workspace repo, absorb behavior is unchanged (`getScopedAbsorbRevset`
   returns null, plain `absorb()` runs with no `--into` flag). Verified by pipeline
   test item 10 and by the existing `pipeline: runs absorb when not disabled` test.
2. In a multi-workspace repo, `/jj-commit` runs absorb scoped to the workspace-private
   revset. If the revset resolves to zero destination commits, jj does nothing and the
   pipeline continues. Verified by pipeline test item 9.
3. After scoped absorb, shared-history edits remain in `@` and sibling workspaces are
   not stale. Verified by integration test item 8.
4. When workspace introspection fails, absorb is skipped conservatively. Verified by
   pipeline test item 11.
5. Full jj commit test suites pass:
   `node --experimental-strip-types --test pi/jj/lib/commit/*.test.ts`
   `node --experimental-strip-types --test test/extensions/jj-commit*.test.ts`

## Rollout, Recovery, and Idempotence

This change is local to `/jj-commit` and reversible. If the scoped absorb logic proves
unsafe, revert the pipeline to the current full-skip behavior and keep the tests that
document the failure mode. Manual validation should always happen before trusting the
new behavior broadly.

If a temp-repo experiment goes wrong, recover with:

    jj op log
    jj op undo

The new helper logic is side-effect free until the actual absorb command runs. The
`parseWorkspaceListOutput` and `buildScopedAbsorbRevset` functions are pure. The
`getScopedAbsorbRevset` method only reads from jj; it does not mutate the repo.

## Artifacts and Notes

Important observed transcript from the investigation:

    $ jj absorb
    Absorbed changes into 2 revisions:
      qkuxwuty b17e57a3 ws private change
      tospkxqn b29b1e36 shared change

After that, the sibling workspace reported a stale working copy.

Important observed transcript for scoped absorb:

    $ jj absorb --into 'ancestors(@) ~ ancestors(<default-target>)'
    Absorbed changes into 1 revisions:
      xqoxpumr 71c93cc1 ws private change
    Remaining changes:
    M f.txt

After that, the sibling workspace remained healthy.

Important observed behavior for empty destination revset:

    $ jj absorb --into 'none()'
    Nothing changed.
    (exit code 0)

## Interfaces and Dependencies

In `pi/jj/lib/commit/jj.ts`, add the following types and functions:

    export interface WorkspaceTarget {
      name: string;
      targetCommitId: string;
    }

    export function parseWorkspaceListOutput(raw: string): WorkspaceTarget[]

    export function buildScopedAbsorbRevset(
      otherTargetCommitIds: string[],
    ): string | null

On `ControlledJj`, add these methods:

    async listWorkspaceTargets(): Promise<WorkspaceTarget[]>
    async getCurrentCommitId(): Promise<string>
    async getScopedAbsorbRevset(): Promise<string | null>

Change the existing `absorb()` signature to:

    async absorb(intoRevset?: string): Promise<{ changed: boolean; output: string }>

The pipeline depends on `getScopedAbsorbRevset()` and `absorb(intoRevset?)`. It no
longer calls `hasOtherWorkspaces()`.
