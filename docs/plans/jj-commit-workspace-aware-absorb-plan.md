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
that workspace’s target. The solution must preserve safety first: it must never
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

Instead of treating “other workspaces exist” as a binary reason to skip absorb, the
pipeline will compute a workspace-private destination revset and pass it to
`jj absorb --into`.

The revset will be:

    mutable() & ancestors(@) & ~(ancestors(<other-workspace-targets>))

In plain language:

- `ancestors(@)` means only commits in the current workspace’s history.
- `ancestors(<other-workspace-targets>)` means commits that are reachable from any
  sibling workspace target.
- subtracting those gives the current workspace’s private stack.
- intersecting with `mutable()` preserves jj’s normal mutability rule.

This means:

- edits whose nearest matching ancestor is private can be absorbed safely.
- edits whose nearest matching ancestor is shared will remain in `@`.
- no shared ancestor will be rewritten.

The extension will still skip absorb if no private destination commits exist, or if
workspace parsing fails.

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
private stack relative to a named workspace, so the computed safe destination set may
be empty. That is acceptable; in that case the pipeline should skip absorb with a more
specific warning like “No workspace-private absorb targets were found.”

A third risk is revset quoting and commit-id formatting bugs. To reduce that risk, the
logic should use full commit IDs returned from `jj workspace list -T`, not shortest
IDs that may be ambiguous.

## Progress

- [x] (2026-04-10 16:24Z) Investigated repository history and confirmed this repo never implemented scoped multi-workspace absorb; current behavior was introduced by `c3e58275478b` and `cabd0e94ccf5`.
- [x] (2026-04-10 16:24Z) Reproduced that plain `jj absorb` rewrites shared ancestors across workspaces and leaves sibling workspaces stale.
- [x] (2026-04-10 16:24Z) Reproduced that `jj absorb --into 'ancestors(@) ~ ancestors(<other-target>)'` safely absorbs only private-stack edits and leaves shared-history edits in the working copy.
- [ ] Add workspace-target introspection helpers to `pi/jj/lib/commit/jj.ts`.
- [ ] Add tests for parsing workspace targets and computing safe absorb destination revsets.
- [ ] Add real pipeline tests covering multi-workspace safe absorb behavior.
- [ ] Replace binary “other workspaces exist” skip logic in `pi/jj/lib/commit/pipeline.ts` with scoped absorb logic.
- [ ] Validate behavior manually in a temp repo with both plain-shared and private-stack edits.
- [ ] Run full jj commit test suite.

## Surprises & Discoveries

- Observation: this repository never contained a smarter “workspace-private absorb” implementation. It started with plain `jj absorb` and later added a blanket skip when other workspaces exist.
  Evidence: file history for `pi/jj/lib/commit/pipeline.ts`, `pi/jj/lib/commit/jj.ts`, and `pi/jj/lib/commit/pipeline.test.ts` shows initial `/jj-commit` in `74c98cc558ed`, `hasOtherWorkspaces()` in `c3e58275478b`, and the skip guard in `cabd0e94ccf5`, with no intervening scoped absorb logic.

- Observation: plain `jj absorb` rewrites shared ancestors across workspaces and leaves sibling workspaces stale.
  Evidence: temp repo experiment produced `Absorbed changes into 2 revisions`, including the shared ancestor, and the sibling workspace then reported a stale working copy.

- Observation: `jj absorb --into 'ancestors(@) ~ ancestors(<other-target>)'` safely absorbed only the private-stack edit and left the shared-history edit in the working copy.
  Evidence: temp repo experiment after restricted absorb showed only the shared-history file still modified, while the sibling workspace remained unaffected.

## Decision Log

- Decision: use `jj absorb --into <workspace-private-revset>` instead of inventing a custom per-file absorb planner.
  Rationale: jj already leaves unresolved changes in the source revision when no allowed destination applies, which matches the desired safe behavior.
  Date: 2026-04-10

- Decision: define workspace-private destinations as `mutable() & ancestors(@) & ~(ancestors(<other-workspace-targets>))`.
  Rationale: this excludes all commits shared with any sibling workspace target while preserving the current workspace’s private stack.
  Date: 2026-04-10

- Decision: keep the fallback conservative when workspace parsing fails or the safe revset would be empty.
  Rationale: this preserves the current safety guarantee and limits the blast radius of bugs in revset construction.
  Date: 2026-04-10

## Outcomes & Retrospective

(To be filled at major milestones and at completion.)

## Context and Orientation

`pi/jj/lib/commit/jj.ts` is the CLI adapter for jj operations such as `diff`, `stat`,
`commit`, `absorb`, and workspace queries. `pi/jj/lib/commit/pipeline.ts` orchestrates
the `/jj-commit` flow and currently decides whether absorb runs before model planning.
`pi/jj/lib/commit/pipeline.test.ts` contains the pipeline behavior tests, including the
current “skip absorb when other workspaces exist” assertion.

Today `ControlledJj.absorb()` runs plain `jj absorb`. Today
`ControlledJj.hasOtherWorkspaces()` only answers a yes/no question by counting
`jj workspace list` rows. That is too weak for the smarter behavior we want.

## Preconditions and Verified Facts

The current tree contains:

- `pi/jj/lib/commit/jj.ts` with `absorb()` and `hasOtherWorkspaces()`.
- `pi/jj/lib/commit/pipeline.ts` with a hard skip when other workspaces exist.
- `pi/jj/lib/commit/pipeline.test.ts` with a test named
  `pipeline: skips absorb when other workspaces exist`.

The installed jj version exposes:

- `jj absorb --into <REVSETS>`.
- `jj workspace list -T <TEMPLATE>`.

The tested repo experiments confirm that:

- plain `jj absorb` rewrites shared ancestors across workspaces.
- restricted `--into` revsets can limit absorb to private-stack commits only.

## Scope Boundaries

In scope:

- smarter absorb target computation for `/jj-commit`.
- new helpers in `pi/jj/lib/commit/jj.ts`.
- pipeline behavior changes in `pi/jj/lib/commit/pipeline.ts`.
- unit and integration tests for multi-workspace absorb safety.

Out of scope:

- changing jj itself.
- new UI commands.
- changing `/git-commit`.
- any hunk-level custom absorb planner beyond jj’s built-in behavior.

## Milestones

First, teach the jj adapter to return enough structured workspace information to reason
about sibling targets instead of only counting them. At the end of this milestone, a
test should prove we can obtain the current workspace target and the other workspace
targets.

Second, compute a workspace-private absorb revset and test it in isolation. At the end
of this milestone, pure tests should show that the revset excludes shared ancestors and
includes only private-stack candidates.

Third, wire the revset into the pipeline. At the end of this milestone, the pipeline
should run absorb in multi-workspace repos when private targets exist, and should skip
with a narrower warning when they do not.

Fourth, prove the behavior in a real temp repo. At the end of this milestone, a manual
transcript should show that private-stack edits absorb, shared-history edits remain in
`@`, and sibling workspaces are not made stale.

## Plan of Work

In `pi/jj/lib/commit/jj.ts`, replace the boolean-only workspace check with structured
workspace inspection. Add a method that runs:

    jj workspace list -T 'name ++ "\x1f" ++ self.target().commit_id() ++ "\n"'

Parse each line into `{ name, targetCommitId }`. Add another helper that identifies the
current workspace target commit from the current cwd’s `@` or current workspace name as
needed, and returns the set of sibling target commit IDs.

Still in `pi/jj/lib/commit/jj.ts`, add a helper that builds the safe absorb destination
revset string. Given the sibling target commit IDs, produce:

    mutable() & ancestors(@) & ~(ancestors(id1 | id2 | ...))

If there are no sibling targets, the helper may return `mutable() & ancestors(@)` or
signal that plain absorb is safe. If the subtraction would yield no useful private
destinations, the caller will skip absorb.

In `pi/jj/lib/commit/pipeline.ts`, remove the current binary “other workspaces exist”
guard. Replace it with:

- ask jj for sibling workspace targets.
- if that query fails, skip absorb conservatively.
- if no sibling targets exist, run the current absorb flow.
- if sibling targets exist, compute the scoped revset.
- run `jj absorb --into <revset>`.
- if absorb makes no changes, continue.
- if some changes remain in `@`, continue with normal commit planning.

Update warnings so they distinguish between:

- multi-workspace repos with no safe private absorb targets.
- workspace-query failures.
- actual absorb failures.

## Concrete Steps

From the repo root, inspect current helper shape before editing:

    node --experimental-strip-types --test pi/jj/lib/commit/pipeline.test.ts

Expected: tests pass, including the current absorb skip test.

Then edit `pi/jj/lib/commit/jj.ts` to add structured workspace helpers and a scoped
absorb method or revset builder. Add tests in a new file if needed, or extend existing
jj tests if that is where CLI parsing helpers already live.

Run the targeted tests:

    node --experimental-strip-types --test pi/jj/lib/commit/jj.test.ts

Expected: new helper tests pass.

Next edit `pi/jj/lib/commit/pipeline.test.ts`. Replace the old blanket-skip test with
two tests:

1. a multi-workspace case where a safe revset exists and `absorb()` is called with that
   revset.
2. a multi-workspace case where no safe revset exists and absorb is skipped with a
   specific warning.

Run:

    node --experimental-strip-types --test pi/jj/lib/commit/pipeline.test.ts

Expected: the new tests fail before pipeline implementation.

Then edit `pi/jj/lib/commit/pipeline.ts` to use the new workspace-aware absorb logic.
Re-run the same test command until green.

After that, run the full jj commit suite:

    node --experimental-strip-types --test pi/jj/lib/commit/*.test.ts test/extensions/jj-commit*.test.ts

Expected: all tests pass.

Finally, do manual validation in a temp repo with two workspaces:

- create one shared ancestor commit.
- create one workspace-private descendant in a named workspace.
- make one worktree edit against shared history and one against workspace-private history.
- run `/jj-commit --dry-run` or invoke the pipeline path.
- verify only the private-stack edit is absorbed.
- verify the sibling workspace does not become stale.

## Testing and Falsifiability

Add or modify tests so they prove the new behavior and would fail if shared ancestors
were still eligible for absorb.

At minimum:

- In `pi/jj/lib/commit/pipeline.test.ts`, add a case where sibling workspace targets
  exist and the jj mock returns a non-empty safe revset. Assert `absorb()` runs.
- In the same file, add a case where sibling targets consume all ancestors except
  shared history. Assert absorb is skipped and the warning mentions no private targets.
- In the jj adapter tests, add parsing tests for workspace list template output and
  revset construction with one and multiple sibling targets.

For manual falsifiability, the plan is wrong if a sibling workspace becomes stale after
scoped absorb. The exact check is:

- after running absorb in one workspace, switch to the sibling workspace and run
  `jj log -r @`.
- if jj reports the working copy is stale, the strategy is not safe.

## Validation and Acceptance

Acceptance is behavior-based:

1. In a single-workspace repo, absorb behavior is unchanged.
2. In a multi-workspace repo with no private stack, `/jj-commit` skips absorb with a
   specific safety warning.
3. In a multi-workspace repo with a private stack, `/jj-commit` absorbs only
   workspace-private edits and leaves shared-history edits in `@`.
4. After scoped absorb in one workspace, sibling workspaces do not become stale.
5. Full jj commit tests pass.

## Rollout, Recovery, and Idempotence

This change is local to `/jj-commit` and reversible. If the scoped absorb logic proves
unsafe, revert the pipeline to the current full-skip behavior and keep the tests that
document the failure mode. Manual validation should always happen before trusting the
new behavior broadly.

If a temp-repo experiment goes wrong, recover with:

    jj op log
    jj op undo

The new helper logic should be side-effect free until the actual absorb command runs.

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

## Interfaces and Dependencies

In `pi/jj/lib/commit/jj.ts`, define or equivalent:

    export interface WorkspaceTarget {
      name: string;
      targetCommitId: string;
    }

    async listWorkspaceTargets(): Promise<WorkspaceTarget[]>

    buildScopedAbsorbRevset(otherWorkspaceTargetCommitIds: string[]): string | null

If preferred, expose a higher-level helper instead:

    async getScopedAbsorbRevsetForCurrentWorkspace(): Promise<string | null>

The pipeline should depend on that higher-level helper rather than rebuilding revsets
itself.
