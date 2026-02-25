# Build an agentic `jj commit` workflow for vanilla pi (oh-my-pi parity target)

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, you will be able to run a single command in pi (for example `/jj-commit`) and get intelligent commit handling similar to oh-my-pi: change analysis, conventional message generation, optional split commits for unrelated changes, changelog proposals, and safe execution with rollback guidance. The workflow will use jujutsu (`jj`) instead of git, including jj-native operations like `jj commit` with file arguments and optional `jj absorb` pre-pass. Model selection will default to a preferred model (Sonnet 4.6), then transparently fall back to the active session model if the preferred model is unavailable or fails. Implementation will follow strict TDD using Node’s built-in `node:test` runner so each behavior is proven by a failing test before code is written.

This plan now explicitly includes a hunk-support feasibility spike, bookmark movement for push flows, and a strict rule that changelog logic never creates new `CHANGELOG.md` files.

## Progress

- [x] (2026-02-25 17:45Z) Researched oh-my-pi commit architecture and mapped key modules.
- [x] (2026-02-25 17:47Z) Audited existing local jj capabilities in `shared/skills/jj-commit` and `packages/jj/extensions`.
- [ ] Add Node `node:test` coverage scaffold for `packages/jj/lib/commit`.
- [ ] Add Phase 0 spike to measure non-interactive hunk support feasibility in jj.
- [ ] Write failing tests for model resolver behavior (preferred Sonnet 4.6 -> session fallback).
- [ ] Write failing tests for `ControlledJj` command wrapping and error mapping.
- [ ] Write failing tests for proposal validation rules and split-plan coverage.
- [ ] Write failing tests for changelog detection/apply behavior (existing files only, no auto-create).
- [ ] Write failing tests for bookmark move + push flow.
- [ ] Implement model resolver: prefer Sonnet 4.6, fallback to current session model on failure.
- [ ] Create a new `jj commit` extension command with dry-run and execution modes.
- [ ] Implement `ControlledJj` adapter (status/diff/hunks/commit/absorb/bookmark/push helpers).
- [ ] Implement proposal validation (summary, scope, type consistency, split-plan coverage).
- [ ] Implement split commit execution with dependency ordering (file-level baseline).
- [ ] Implement optional hunk-level split path only if Phase 0 proves viable.
- [ ] Implement changelog targeting/proposal/application for existing changelog files only.
- [ ] Add docs + update `shared/skills/jj-commit` to route users to `/jj-commit`.
- [ ] Validate end-to-end on sample repos and real repo.

## Surprises & Discoveries

- Observation: oh-my-pi’s commit feature is not a thin prompt wrapper; it is a dedicated subsystem with agentic tools, validation, fallback, and changelog plumbing.
  Evidence: `/tmp/oh-my-pi/packages/coding-agent/src/commit/agentic/*`, `commit/changelog/*`.

- Observation: oh-my-pi split commits depend on git staging/hunk application (`git apply --cached`), which has no direct 1:1 jj non-interactive equivalent for hunk selection.
  Evidence: `/tmp/oh-my-pi/packages/coding-agent/src/commit/git/index.ts` (`stageHunks`).

- Observation: your current jj support already enforces “no mutating git” and has a commit skill with `jj absorb` guidance, which we can preserve as fallback behavior.
  Evidence: `packages/jj/extensions/block-git-mutating.ts`, `shared/skills/jj-commit/SKILL.md`.

- Observation: pushing via jj typically requires the intended bookmark (for example `main`) to point at the commit being pushed, so push automation must handle bookmark movement explicitly.
  Evidence: expected jj workflow patterns (`jj bookmark set ...`, `jj git push --bookmark ...`).

## Decision Log

- Decision: Implement as a pi extension command (`/jj-commit`) rather than forking pi core.
  Rationale: Keeps maintenance low, aligns with pi extension philosophy, and fits your package layout.
  Date: 2026-02-25

- Decision: Model selection for `/jj-commit` will prefer Sonnet 4.6, then fall back to the current session model if Sonnet 4.6 cannot be resolved, authenticated, or invoked successfully.
  Rationale: Gives consistent high-quality commit planning by default while preserving reliability in environments where the preferred model is unavailable.
  Date: 2026-02-25

- Decision: Implementation will use strict TDD with Node’s built-in `node:test` framework (`import test from "node:test"`, `import assert from "node:assert/strict"`).
  Rationale: Commit workflow logic has many edge cases (split coverage, fallback ordering, changelog safety, bookmark push semantics). Test-first development reduces regressions and provides objective acceptance criteria.
  Date: 2026-02-25

- Decision: Keep file-level split execution as guaranteed baseline; treat hunk-level split as a gated optional enhancement.
  Rationale: jj supports deterministic file-level splitting cleanly (`jj commit -m ... <files...>`). Hunk-level non-interactive support may require complicated workarounds; we will only ship it after a feasibility spike.
  Date: 2026-02-25

- Decision: `--push` flow will move a configured/default bookmark to the resulting commit(s) before running `jj git push`.
  Rationale: User requirement and practical jj push behavior for bookmark-based publishing.
  Date: 2026-02-25

- Decision: Never create new `CHANGELOG.md` files. Changelog automation operates only when existing changelog files are discovered.
  Rationale: User requirement and conservative behavior.
  Date: 2026-02-25

- Decision: Keep current `shared/skills/jj-commit` as fallback/manual mode even after command lands.
  Rationale: Useful when command is unavailable or for explicit human-guided commits.
  Date: 2026-02-25

## Outcomes & Retrospective

(To be filled at major milestones and at completion.)

## Context and Orientation

You currently have three relevant jj assets:

1. `packages/jj/extensions/block-git-mutating.ts` blocks mutating git commands in jj repos.
2. `packages/jj/extensions/jj-footer.ts` shows jj info in footer.
3. `shared/skills/jj-commit/SKILL.md` gives manual commit workflow instructions (`jj status`, `jj diff`, optional `jj absorb`, then grouped commits).

oh-my-pi’s commit engine is much more advanced. It provides:

- Agentic inspection tools (`git_overview`, `git_file_diff`, `git_hunk`, `recent_commits`, optional subanalysis).
- Finalization tools (`propose_commit`, `split_commit`, `propose_changelog`) with strict validation.
- Execution layer that applies plans and creates commit(s).
- Fallback behavior when the model fails.
- Changelog target detection and update application.

For jj, we will preserve the architecture but swap command semantics:

- `git diff --cached` => `jj diff --git`
- “staged files” => “changed paths in working copy”
- split commits => repeated `jj commit -m "..." <files...>` over remaining working-copy changes
- optional pre-pass: `jj absorb`
- push flow => set/move bookmark, then `jj git push --bookmark <name>`

## Plan of Work

We will implement a new extension command `/jj-commit` in `packages/jj/extensions/` and a supporting library in `packages/jj/lib/commit/`.

Phase 0 is a feasibility spike focused on hunk-level splitting in jj. We will test whether we can reliably and non-interactively isolate hunks per commit. If the result is unstable, we stop at file-level splitting for this release and document hunk mode as future work.

After the spike, build a `ControlledJj` API that abstracts jj operations (`status`, `diff`, `stat`, `hunks`, `commit`, `push`, `absorb`, `bookmark`, `log`). This mirrors oh-my-pi’s `ControlledGit`, but with jj semantics.

All implementation work follows a strict red/green/refactor loop: write a failing `node:test` case first, run the targeted test command to confirm failure, implement the minimal code to pass, then run the focused test and the full jj-commit test suite. No behavior is implemented without a prior failing test unless it is pure wiring with zero logic.

Then implement the planner layer:

- A proposal schema for single commit and split commit plans.
- Validation rules adapted from oh-my-pi: summary length/tense, scope validity, detail caps, type/file consistency.
- Split-plan validation: all changed files covered exactly once, dependencies acyclic.

Then implement command orchestration:

- Resolve model for commit planning as: preferred `anthropic/claude-sonnet-4.6` (or exact Sonnet 4.6 ID in registry), then fallback to current session model if preferred resolution/auth/invocation fails.
- `/jj-commit --dry-run`: produce a plan and print commit message(s) without mutating repo.
- `/jj-commit` (execute): run optional `jj absorb` pre-pass, apply split or single commits.
- `/jj-commit --push`: move bookmark to target commit and run `jj git push --bookmark <bookmark>`.
- `/jj-commit --no-changelog`: skip changelog logic.

Then implement changelog behavior matching oh-my-pi style, constrained to existing files:

- Find nearest existing `CHANGELOG.md` per changed file.
- If none found, skip changelog stage entirely.
- Ask model for entries/deletions for discovered changelog targets only.
- Apply updates under `[Unreleased]`.
- Ensure changelog file paths are included in final commit plan.

Finally, tighten UX and recovery:

- Clear progress output during command run.
- Explicit warnings when fallback path is used.
- On failure, print `jj op log` guidance and exact `jj op undo <op>` instructions.

## Concrete Steps

From repository root (`/home/bromanko.linux/Code/llm-agents`):

1. Create commit subsystem files and test files together (tests first is mandatory):

    mkdir -p packages/jj/lib/commit/{agentic,changelog,prompts}
    touch packages/jj/lib/commit/{types.ts,jj.ts,validation.ts,pipeline.ts,hunk-spike.md}
    touch packages/jj/extensions/jj-commit.ts
    touch packages/jj/lib/commit/{model-resolver.test.js,jj.test.js,validation.test.js,pipeline.test.js,changelog.test.js}

Expected result: directories and files exist without overwriting existing jj extensions.

2. Verify Node test runner works in this repository before writing commit tests:

    node --test packages/code-review/lib/fix-flow.test.js

Expected output includes `pass` tests and zero failures.

2a. Add jj package-level test ergonomics for repeatable runs:

- In `packages/jj/package.json`, add scripts:
  - `"test:commit": "node --test lib/commit/*.test.js"`
  - `"test:commit:watch": "node --test --watch lib/commit/*.test.js"`
- If repeated ESM warnings are noisy during test runs, set `"type": "module"` in `packages/jj/package.json`.

Expected result: commit test suite can be run consistently from `packages/jj` with built-in Node test tooling.

3. Run Phase 0 hunk feasibility spike and capture results in `packages/jj/lib/commit/hunk-spike.md`.

Try concrete non-interactive strategies and record pass/fail:

    # Strategy A: diff scope + commit with file selection only (control baseline)
    jj diff --git

    # Strategy B: interactive split behavior in scripted environment (likely non-deterministic)
    jj split -i

    # Strategy C: edit/squash variants for selective movement
    jj squash -i --from @ --into @-

Expected result: documented conclusion whether hunk-level automation is robust enough for production.

4. TDD milestone: model resolution logic.

Write failing tests in `packages/jj/lib/commit/model-resolver.test.js` for:

- preferred Sonnet 4.6 success path,
- fallback to session model when preferred cannot be resolved,
- fallback to session model when preferred invocation fails,
- explicit warning message when fallback occurs.

Run red phase:

    node --test packages/jj/lib/commit/model-resolver.test.js

Expected result: failing assertions describing missing behavior.

Implement minimal model resolver in pipeline/helper, then rerun:

    node --test packages/jj/lib/commit/model-resolver.test.js

Expected result: all tests pass.

5. TDD milestone: `ControlledJj` wrapper.

Write failing tests in `packages/jj/lib/commit/jj.test.js` for:

- `getChangedFiles()` parsing,
- `getDiffGit(files?)` command formation,
- `getHunks(file)` extraction,
- `commit(message, files?)` behavior,
- `setBookmark()` + `pushBookmark()` command behavior,
- error propagation with actionable messages.

Run red phase:

    node --test packages/jj/lib/commit/jj.test.js

Implement `ControlledJj` in `packages/jj/lib/commit/jj.ts` with methods:

- `getChangedFiles()`
- `getDiffGit(files?)`
- `getStat()`
- `getHunks(file)`
- `getRecentCommits(count)`
- `commit(message, files?)`
- `absorb()`
- `setBookmark(bookmark, rev)`
- `pushBookmark(bookmark)`

Run green phase:

    node --test packages/jj/lib/commit/jj.test.js

Expected result: all wrapper tests pass.

6. TDD milestone: validation rules.

Write failing tests in `packages/jj/lib/commit/validation.test.js` for:

- summary length and past-tense checks,
- scope formatting checks,
- split-plan full file coverage,
- duplicate file detection across split commits,
- dependency cycle detection.

Run red phase:

    node --test packages/jj/lib/commit/validation.test.js

Implement `types.ts` + `validation.ts` (minimal to pass), then rerun green phase with same command.

7. TDD milestone: changelog behavior (existing files only).

Write failing tests in `packages/jj/lib/commit/changelog.test.js` for:

- nearest existing changelog discovery,
- skip behavior when no changelog exists,
- apply entries under `[Unreleased]`,
- explicit assertion that no new `CHANGELOG.md` file is created.

Run red phase:

    node --test packages/jj/lib/commit/changelog.test.js

Implement changelog helpers and rerun green phase.

8. TDD milestone: pipeline orchestration.

Write failing tests in `packages/jj/lib/commit/pipeline.test.js` for:

- dry-run output without repo mutation,
- optional `jj absorb` pre-pass,
- single vs split proposal execution,
- model fallback behavior,
- bookmark move + push flow,
- deterministic fallback path when both preferred and session model fail.

Run red phase:

    node --test packages/jj/lib/commit/pipeline.test.js

Implement `pipeline.ts` minimally, rerun green phase.

9. Wire command in `packages/jj/extensions/jj-commit.ts` (thin integration layer).

Write/extend failing command-level tests (in `pipeline.test.js` or separate `command.test.js`) that verify argument parsing and pipeline invocation.

Run:

    node --test packages/jj/lib/commit/pipeline.test.js

Then implement:

- Register `/jj-commit`.
- Parse flags from command arguments (`--dry-run`, `--push`, `--bookmark`, `--no-changelog`, `--no-absorb`, `--context`).
- Call pipeline.
- Show summary + next actions.

10. Update skill fallback behavior in `shared/skills/jj-commit/SKILL.md`:

- Prefer `/jj-commit` when available.
- Keep manual path as fallback.
- Preserve warning that `jj commit -m` without file args commits all remaining changes.

11. Run full jj-commit test suite after each green milestone and before manual E2E:

    node --test packages/jj/lib/commit/*.test.js

Expected result: zero failures.

12. Validate with a temp repo:

    mkdir -p /tmp/jj-commit-e2e && cd /tmp/jj-commit-e2e
    jj git init --colocate
    echo "a" > a.ts && echo "b" > b.md
    jj status

Expected: working copy shows both files modified/untracked.

13. Run dry-run commit planning in pi session:

    /jj-commit --dry-run

Expected: either one conventional commit message or a split plan with multiple messages and file mapping.

14. Run execution:

    /jj-commit

Expected: new jj change(s) created with proposed descriptions; remaining working copy clean (or only intentionally uncommitted files).

15. Validate push/bookmark behavior:

    /jj-commit --push --bookmark main

Expected: bookmark points at the new commit and push succeeds.

## Validation and Acceptance

Acceptance is behavior-based:

- Every behavioral change in jj-commit logic is introduced by a failing `node:test` case first (red), then implemented to pass (green), then optionally refactored.
- The full jj-commit test suite passes with zero failures.
- When there are no changes, `/jj-commit` reports “nothing to commit” and exits cleanly.
- For a single cohesive change, `/jj-commit --dry-run` outputs one valid conventional commit summary.
- For unrelated changes across multiple files, `/jj-commit --dry-run` outputs a split plan covering all changed files exactly once.
- Executing split plan creates multiple jj commits in declared dependency order.
- If Phase 0 declares hunk mode non-viable, command still succeeds using file-level split only.
- If changelog targets exist and changelog is enabled, `[Unreleased]` entries are updated and included in commit set.
- If no changelog file exists for changed paths, changelog phase is skipped without creating new files.
- If `--push` is used, bookmark movement + push path succeeds or reports an explicit actionable error.
- If preferred Sonnet 4.6 cannot be used, workflow falls back to the active session model and reports the fallback.
- If both preferred and session model paths fail, workflow falls back to deterministic proposal and clearly indicates fallback.
- Existing `block-git-mutating` still prevents accidental mutating git commands.

Automated validation commands:

    node --test packages/jj/lib/commit/model-resolver.test.js
    node --test packages/jj/lib/commit/jj.test.js
    node --test packages/jj/lib/commit/validation.test.js
    node --test packages/jj/lib/commit/changelog.test.js
    node --test packages/jj/lib/commit/pipeline.test.js
    node --test packages/jj/lib/commit/*.test.js

Expected result: all tests pass, zero failures.

Manual verification commands:

    jj status
    jj log -r 'ancestors(@, 5)' -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"'
    jj bookmark list
    jj diff --git

Expected: clean status after execution, readable commit history, expected bookmark position, and diffs matching plan.

## Idempotence and Recovery

The workflow is safe to rerun because dry-run mode makes no repo changes, and execution mode only mutates via jj operations.

If execution fails mid-way:

1. Inspect operation history:

    jj op log

2. Undo the last operation if needed:

    jj op undo

3. Re-run `/jj-commit --dry-run` to verify new plan before retry.

If changelog parsing fails for a target file, skip only that changelog target and continue commit planning, while surfacing a warning.

## Artifacts and Notes

Key reference files from oh-my-pi used as blueprint:

- `/tmp/oh-my-pi/packages/coding-agent/src/commit/agentic/index.ts`
- `/tmp/oh-my-pi/packages/coding-agent/src/commit/agentic/tools/propose-commit.ts`
- `/tmp/oh-my-pi/packages/coding-agent/src/commit/agentic/tools/split-commit.ts`
- `/tmp/oh-my-pi/packages/coding-agent/src/commit/changelog/index.ts`
- `/tmp/oh-my-pi/packages/coding-agent/src/commit/agentic/validation.ts`

Local baseline files to extend:

- `packages/jj/extensions/block-git-mutating.ts`
- `packages/jj/extensions/jj-footer.ts`
- `shared/skills/jj-commit/SKILL.md`

## Interfaces and Dependencies

In `packages/jj/lib/commit/types.ts`, define:

    export type CommitType = "feat" | "fix" | "refactor" | "perf" | "docs" | "test" | "build" | "ci" | "chore" | "style" | "revert";

    export interface ConventionalDetail {
      text: string;
      changelogCategory?: "Added" | "Changed" | "Fixed" | "Deprecated" | "Removed" | "Security" | "Breaking Changes";
      userVisible: boolean;
    }

    export interface CommitProposal {
      type: CommitType;
      scope: string | null;
      summary: string;
      details: ConventionalDetail[];
      issueRefs: string[];
      warnings: string[];
    }

    export interface SplitCommitGroup {
      files: string[];
      hunks?: { type: "all" } | { type: "indices"; indices: number[] };
      type: CommitType;
      scope: string | null;
      summary: string;
      details: ConventionalDetail[];
      issueRefs: string[];
      dependencies: number[];
    }

    export interface SplitCommitPlan {
      commits: SplitCommitGroup[];
      warnings: string[];
      mode: "file" | "hunk";
    }

In `packages/jj/lib/commit/jj.ts`, define:

    export class ControlledJj {
      constructor(cwd: string);
      getChangedFiles(): Promise<string[]>;
      getDiffGit(files?: string[]): Promise<string>;
      getStat(files?: string[]): Promise<string>;
      getHunks(file: string): Promise<Array<{ index: number; header: string; content: string }>>;
      getRecentCommits(count: number): Promise<string[]>;
      absorb(): Promise<{ changed: boolean; output: string }>;
      commit(message: string, files?: string[]): Promise<void>;
      setBookmark(name: string, rev: string): Promise<void>;
      pushBookmark(name: string): Promise<void>;
    }

In `packages/jj/extensions/jj-commit.ts`, register:

- `/jj-commit` command with flags:
  - `--dry-run`
  - `--push`
  - `--bookmark <name>`
  - `--no-changelog`
  - `--no-absorb`
  - `--context <text>`

- Model preference policy (no user-facing model flag in this release):
  - Preferred: Sonnet 4.6
  - Fallback: current session model
  - Final fallback: deterministic proposal path if both model paths fail

Test files to define under `packages/jj/lib/commit/`:

- `model-resolver.test.js`
- `jj.test.js`
- `validation.test.js`
- `changelog.test.js`
- `pipeline.test.js`

Each test file should use built-in Node APIs:

    import test from "node:test";
    import assert from "node:assert/strict";

and should mock process execution boundaries (`jj` invocations) instead of shelling out to real jj for unit tests.

Dependency notes:

- Use existing `jj` CLI (no new external service required).
- Use built-in Node test modules only (`node:test`, `node:assert/strict`), avoiding external test frameworks.
- Reuse existing `isJjRepo()` helper from `packages/jj/lib/utils.ts`.
- Keep compatibility with current `shared/skills/jj-commit`.

## Revision Notes

2026-02-25: Incorporated reviewer feedback to (1) add a hunk-support feasibility spike before committing to implementation, (2) add explicit bookmark movement in push workflows, (3) enforce that changelog automation only updates existing `CHANGELOG.md` files and never creates new ones, (4) default model selection to Sonnet 4.6 with fallback to the active session model, and (5) adopt strict TDD with built-in `node:test` coverage for all jj-commit logic.