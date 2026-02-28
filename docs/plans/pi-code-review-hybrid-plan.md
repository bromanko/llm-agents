# Build a hybrid code-review workflow with revision ranges and severity-based auto-fix

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

After this change, `/review` in `packages/code-review/` will keep its current strengths (language/type skill selection, dedupe, one-by-one finding triage, queued follow-up fixes) and add two high-value controls:

1. a single explicit revision-range selector (`-r/--revisions`) for what to review, and
2. a severity threshold (`--fix`) to auto-queue fixes for findings at/above that level.

The user-visible result is simple and predictable:

- run `/review gleam -r main..@` to review a meaningful range, and
- run `/review gleam -r @ --fix high` to immediately queue fixes for all HIGH findings.

No “custom scope mode” is included in this plan.


## Progress

- [x] (2026-02-28 04:24Z) Compared current `packages/code-review` extension with oh-my-pi `/review` command and reviewer stack.
- [x] (2026-02-28 04:37Z) Authored initial hybrid-mode ExecPlan.
- [x] (2026-02-28 05:01Z) Revised plan to adopt unified range-based scope and severity-based auto-fix (`--fix`).
- [x] (2026-02-28 06:03Z) Added `packages/code-review/lib/review-range.ts` and `packages/code-review/lib/review-range.test.ts` with parsing and jj→git range resolution coverage.
- [x] (2026-02-28 06:24Z) Refactored `packages/code-review/extensions/index.ts` to use range parsing/resolution and support `--fix` auto-queue behavior.
- [x] (2026-02-28 06:35Z) Added extension behavior tests in `test/extensions/code-review.test.ts` for default range, explicit range, and fix thresholds.
- [x] (2026-02-28 06:40Z) Updated `README.md` with `/review` grammar, examples, and range resolution notes.
- [x] (2026-02-28 06:48Z) Ran validation: targeted code-review tests, full `npm test`, and `selfci check` all passing.


## Surprises & Discoveries

- Observation: Current review UX is already strong once findings exist, so this plan should improve launch/range semantics and auto-fix behavior without replacing the existing finding loop.
  Evidence: `packages/code-review/extensions/index.ts` and `packages/code-review/lib/fix-flow.js`.

- Observation: Existing tests cover parser/skills/fix-flow modules but not extension command flow behavior.
  Evidence: `packages/code-review/lib/*.test.*` exists, but no extension-level review command tests were present under `test/extensions/`.

- Observation: “branch mode” language is ambiguous without explicit range semantics; expressing scope as a revision range removes that ambiguity.
  Evidence: user clarification in this thread.

- Observation: Extension-level tests cannot import runtime-only packages (`@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`) in plain Node test runs, so eager imports fail test loading.
  Evidence: `ERR_MODULE_NOT_FOUND` while loading `packages/code-review/extensions/index.ts` from `test/extensions/code-review.test.ts`; resolved by lazy runtime imports inside `runReviews`/`showFinding`.


## Decision Log

- Decision: Scope is always expressed as a revision range via `-r/--revisions`.
  Rationale: One mental model is simpler than multiple overlapping modes.
  Date: 2026-02-28

- Decision: Default range is `@` (working set / current working copy delta).
  Rationale: preserves current no-flag behavior while making range explicit when desired.
  Date: 2026-02-28

- Decision: Add `--fix <high|medium|low|all>` to auto-queue fixes by severity threshold.
  Rationale: this is the user’s primary workflow improvement request.
  Date: 2026-02-28

- Decision: Remove “custom scope/instructions” from this plan.
  Rationale: user explicitly does not care about prompt-steering instructions for review.
  Date: 2026-02-28

- Decision: Keep `/review <language> [types...]` backward-compatible and optional flags additive.
  Rationale: avoid breaking current usage and existing muscle memory.
  Date: 2026-02-28

- Decision: In git fallback mode, resolve single-revision ranges with `git show --format= --patch <rev>` instead of `git diff <rev>`.
  Rationale: `git show` aligns better with “review this commit” semantics while `git diff <rev>` compares working tree against that revision.
  Date: 2026-02-28

- Decision: Convert runtime package imports in `packages/code-review/extensions/index.ts` to lazy imports inside execution paths.
  Rationale: keeps extension behavior in pi runtime unchanged while allowing extension tests to import and exercise command logic in plain Node.
  Date: 2026-02-28


## Outcomes & Retrospective

Implemented outcome: `/review` now supports explicit revision ranges and severity-threshold auto-fix while preserving existing interactive triage when `--fix` is omitted. The command grammar is now deterministic (`-r/--revisions`, `--fix`), and both parser-level and extension-level tests cover the new behavior.

What worked well: reusing `queueFixFollowUp` + `notifyQueueSummary` kept the new auto-fix path small and consistent with existing queued-fix UX. Introducing `packages/code-review/lib/review-range.ts` isolated parsing/range resolution logic and made it easy to test without UI or model dependencies.

Tradeoffs: extension tests required lazy imports for runtime-only pi packages so that plain Node test runs can import the module. This adds small runtime indirection, but testability improved significantly and behavior remains unchanged for real sessions.

Validation outcome: targeted code-review tests, full `npm test`, and `selfci check` all passed on this branch.


## Context and Orientation

Repository root:

    /home/bromanko.linux/Code/llm-agents

Current extension entrypoint:

- `packages/code-review/extensions/index.ts`

Current helper modules:

- `packages/code-review/lib/parser.ts`
- `packages/code-review/lib/skills.ts`
- `packages/code-review/lib/fix-flow.js`

Current test files:

- `packages/code-review/lib/parser.test.ts`
- `packages/code-review/lib/skills.test.ts`
- `packages/code-review/lib/fix-flow.test.js`

Extension tests belong in:

- `test/extensions/`

Helper for extension mocks:

- `test/helpers.ts`

This plan introduces a new range module:

- `packages/code-review/lib/review-range.ts`

and extension-level behavior tests:

- `test/extensions/code-review.test.ts`


## Interface Contract (User-facing)

Final command grammar:

    /review <language> [types...] [-r|--revisions <range>] [--fix <level>]

Where:

- `types` is any subset of `code security performance test`
- default range is `@`
- `--fix` levels:
  - `high` => auto-fix only HIGH findings
  - `medium` => auto-fix HIGH + MEDIUM findings
  - `low` => auto-fix HIGH + MEDIUM + LOW findings
  - `all` => equivalent to `low`

Examples:

    /review gleam
    /review gleam -r @ --fix high
    /review gleam code security -r main..@
    /review fsharp test -r abc123 --fix medium


## Range Resolution Rules

This plan is explicit about how ranges are interpreted:

1. In a jj repo, use jj first:

    jj diff -r <range> --git

2. If jj range command fails or repo is not jj, use git fallback with deterministic support:

    - `git diff HEAD` for `@`
    - `git diff <range>` for range expressions containing `..`
    - `git show --format= --patch <rev>` for single revisions

3. If both fail, return a clear error message that includes the range and underlying command error.

4. No implicit branch magic. `main..@` means exactly `main..@`. `origin/main..@` means exactly that.


## Plan of Work

Milestone 1 adds tests for CLI parsing and new behavior. Milestone 2 adds range gathering and range-resolution logic. Milestone 3 adds severity-based auto-fix queueing. Milestone 4 updates docs and final validation.

Each milestone is additive and ends in a passing state.


## Concrete Steps

All commands run from repo root:

    /home/bromanko.linux/Code/llm-agents

### Milestone 1: parser and extension behavior tests

1. Create extension test file:

    touch test/extensions/code-review.test.ts

2. Create range-module test file:

    touch packages/code-review/lib/review-range.test.ts

3. Add failing tests in `packages/code-review/lib/review-range.test.ts` for:

- parse default range to `@` when omitted
- parse `-r <range>` and `--revisions <range>`
- reject missing range value with deterministic error
- parse `--fix` values (`high|medium|low|all`)
- reject invalid `--fix` values with deterministic error

4. Add failing tests in `test/extensions/code-review.test.ts` for:

- `/review gleam` uses default `@` range and no auto-fix
- `/review gleam -r main..@` routes range to range module
- `/review gleam --fix high` queues only HIGH findings
- `/review gleam --fix medium` queues HIGH+MEDIUM and skips LOW
- no `--fix` preserves interactive `showFinding` loop behavior

5. Run red phase:

    node --experimental-strip-types --test packages/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts

Expected: failures due to missing module and unsupported flags.


### Milestone 2: revision range module and extension wiring

6. Create `packages/code-review/lib/review-range.ts` and export:

- `type ReviewOptions = { range: string; fixLevel?: "high" | "medium" | "low" | "all" }`
- `parseReviewArgs(args: string): { language?: string; types?: string[]; options: ReviewOptions; error?: string }`
- `gatherRangeDiff(pi, ctx, range): Promise<{ diff: string | null; source: "jj" | "git"; error?: string }>`

7. In `packages/code-review/extensions/index.ts`:

- Replace old implicit context gathering in handler with:
  - parse args via `parseReviewArgs`
  - gather diff via `gatherRangeDiff`
- Keep language/type completion and filtering behavior unchanged.
- If range gathering fails, notify deterministic error and return.

8. Add/adjust tests to prove jj-first then git fallback behavior with command stubs.

9. Run green phase:

    node --experimental-strip-types --test packages/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts

10. Commit:

    git add packages/code-review/lib/review-range.ts packages/code-review/lib/review-range.test.ts packages/code-review/extensions/index.ts test/extensions/code-review.test.ts
    git commit -m "feat(code-review): add revision range parsing and jj/git diff resolution"


### Milestone 3: severity-threshold auto-fix behavior

11. In `packages/code-review/extensions/index.ts`, after findings are parsed/deduped/sorted:

- if `--fix` is set:
  - do not prompt per finding
  - build fix messages for findings matching threshold
  - queue them using existing `queueFixFollowUp` path
  - show summary notification (queued count / failures)
- if `--fix` is not set:
  - keep current interactive behavior unchanged

12. Add helper function in extension or new module:

- `matchesFixThreshold(severity, fixLevel): boolean`

13. Add tests:

- in `test/extensions/code-review.test.ts` for threshold mapping behavior
- in `packages/code-review/lib/fix-flow.test.js` only if shared helpers are touched

14. Run green phase:

    node --experimental-strip-types --test test/extensions/code-review.test.ts packages/code-review/lib/fix-flow.test.js

15. Commit:

    git add packages/code-review/extensions/index.ts test/extensions/code-review.test.ts packages/code-review/lib/fix-flow.test.js
    git commit -m "feat(code-review): support --fix severity threshold auto-queueing"


### Milestone 4: docs and full validation

16. Update `README.md` review usage examples with final grammar and examples.

17. Ensure plan progress and decision log are updated with implementation facts.

18. Run full tests:

    npm test

19. Run self-check (from environment where `selfci` is available):

    selfci check

20. Commit docs/plan updates:

    git add README.md docs/plans/pi-code-review-hybrid-plan.md
    git commit -m "docs(code-review): document range-based scope and --fix threshold"


## Validation and Acceptance

Implementation is accepted when all are true:

1. `/review <language>` still works and defaults to reviewing range `@`.
2. `-r/--revisions` controls review scope and is used to gather diff via jj first, git fallback second.
3. Invalid range flag usage and invalid `--fix` values produce deterministic, clear errors.
4. `--fix high|medium|low|all` queues only findings at/above expected severity threshold.
5. Without `--fix`, the interactive finding triage loop still behaves as before.
6. `npm test` passes.
7. `selfci check` passes.


## Idempotence and Recovery

All steps are safe to rerun.

If a milestone fails midway:

- rerun the milestone-specific test command first,
- restore unintended file edits:

    git restore --source=HEAD -- <path>

- reapply changes and retest.

If command parsing/regression becomes hard to untangle, restore and replay from commits:

    git restore --source=HEAD -- packages/code-review/extensions/index.ts packages/code-review/lib/review-range.ts


## Artifacts and Notes

Implementation validation transcripts:

    node --experimental-strip-types --test packages/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts
    # tests 14
    # pass 14
    # fail 0

    node --experimental-strip-types --test packages/code-review/lib/parser.test.ts packages/code-review/lib/skills.test.ts packages/code-review/lib/fix-flow.test.js packages/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts
    # tests 53
    # pass 53
    # fail 0

    npm test
    # tests 356
    # pass 356
    # fail 0

    selfci check
    # passed: Validate Claude plugins
    # passed: Validate pi extensions
    # passed: Run tests


## Interfaces and Dependencies

Expected new interfaces at completion:

In `packages/code-review/lib/review-range.ts`:

    export type ReviewOptions = {
      range: string;
      fixLevel?: "high" | "medium" | "low" | "all";
    };

    export function parseReviewArgs(args: string): ...;
    export async function gatherRangeDiff(...): ...;

No new third-party dependencies are required. Use existing Node built-ins and current test tooling.


Revision note (2026-02-28): Replaced prior scope-mode design (branch/commit/custom mode picker) with a single range-first model (`-r/--revisions`) plus severity-based auto-fix (`--fix`), based on user feedback.

Revision note (2026-02-28): Implemented milestones end-to-end, including new range module/tests, extension wiring, `--fix` threshold behavior, README updates, and full validation (`npm test`, `selfci check`).