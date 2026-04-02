# Add Git worktree commands that emulate the jj workspace workflow

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, a user working in a plain Git repository can manage isolated coding sessions with the same mental model as the existing jj workspace flow. From the main worktree they can run `/ws-create auth`, get a sibling worktree opened in a dedicated tmux window running `pi`, switch back later with `/ws-switch auth`, inspect active worktrees with `/ws-list`, and merge-and-clean up with `/ws-finish auth`. The visible proof is that each worktree gets its own real OS-level current working directory, `@` file picking works naturally inside the worktree session, and finishing either merges cleanly into the main worktree or follows the same improved model-assisted conflict-handling flow now present in `pi/jj/extensions/jj-workspace.ts`.

## Problem Framing and Constraints

The repository already has a mature jj workspace flow in `pi/jj/extensions/jj-workspace.ts`, but the Git side only exposes `/git-commit`. Users who work in normal Git repositories do not have an equivalent way to create short-lived isolated sessions with tmux-backed `pi` windows. They must either manage `git worktree` manually or give up the convenient `/ws-*` lifecycle that now exists for jj.

This plan must stay proportionate. It should not try to unify Git and jj under one large abstraction, and it should not redesign the tmux session model that already works for jj. It does need to account for the current default jj workspace behavior during `/ws-finish`: merge conflicts can be left in place for model-assisted resolution, and the workspace cannot be forgotten while the default workspace still has unresolved conflicts. The Git implementation must mirror that operator experience even though Git uses different commands and does not have jj's operation-log rollback.

Constraints that materially shape the solution:

- `package.json` auto-loads both `./pi/git/extensions` and `./pi/jj/extensions`, so the Git feature must register only in plain Git repositories and must not interfere with jj repos.
- The existing tmux helper logic is already VCS-agnostic, so this plan should share that code instead of cloning it.
- Git worktrees are branch-based. Unlike jj workspaces, Git does not have a built-in logical workspace name or a `forget` command, so the feature must define a safe naming and cleanup scheme.
- Git cannot "snapshot" dirty worktree changes the way jj does. The Git flow must reject dirty worktrees at finish time instead of inventing surprise commits.
- Git linked worktrees still look like Git repos because their `.git` entry is a file rather than a directory. Repository detection must continue to work in both the main worktree and linked worktrees.

## Strategy Overview

Implement a new Git extension in `pi/git/extensions/git-worktree.ts` that registers the same `/ws-create`, `/ws-list`, `/ws-switch`, and `/ws-finish` commands, but only when `process.cwd()` is a Git repo and not a jj repo. The extension will manage a narrow class of "managed worktrees" identified by a dedicated branch namespace, `refs/heads/pi-ws/<name>`, and the same sibling-directory naming convention the jj flow already uses, `<repo-name>-ws-<name>`.

The implementation will stay close to the jj design but remain Git-specific where the semantics differ. Instead of duplicating tmux window code, first extract the existing helper from `pi/jj/lib/tmux-workspaces.ts` into a shared module at `pi/lib/tmux-workspaces.ts`, then point the jj extension and the new Git extension at that shared helper. Git worktree discovery will use `git worktree list --porcelain`, branch metadata will live in local Git config under `pi.worktree.<name>.baseBranch`, and finishing will merge the managed branch into the main worktree branch with `git merge --no-ff`. If a merge conflicts, the extension will enumerate conflicted files, ask whether the session model should attempt a resolution, and either abort the merge or leave it in progress for the model to fix, matching the current jj behavior as closely as Git permits.

The design deliberately keeps Git-specific parsing and cleanup logic separate from jj-specific workspace logic. The only shared code is the tmux window helper because it has no VCS semantics at all.

## Alternatives Considered

The simplest alternative is to tell users to run `git worktree add` and tmux commands manually. That is insufficient because it does not preserve the key benefit of the jj feature: one consistent, discoverable slash-command workflow inside `pi`.

Another alternative is to build a fully shared VCS-agnostic workspace engine used by both `pi/jj/extensions/jj-workspace.ts` and the new Git feature. That is too large for this problem. The tmux parts are identical and worth sharing, but create/finish semantics differ in important ways: jj uses named workspaces, mutable changesets, and operation-log rollback; Git uses worktrees, branches, merge state files, and explicit branch deletion. A forced common abstraction over those semantics would add risk exactly where the behaviors diverge most.

A third alternative is to use `/wt-*` command names instead of `/ws-*`. That would avoid any conceptual overload around the word "workspace", but it would also give users two different command sets for the same mental model. Because the repo already treats `/ws-*` as the user-facing lifecycle vocabulary, this plan keeps those names and instead prevents activation in jj repos.

A fourth alternative is to auto-commit or auto-stash dirty worktree changes during `/ws-finish`. That would reduce friction, but it would also mutate user history in surprising ways and create unclear recovery paths. This plan rejects dirty worktrees at finish time and tells the user to commit or stash intentionally.

## Risks and Countermeasures

The biggest risk is finishing the wrong branch or deleting the wrong worktree. The countermeasure is to manage only branches under `refs/heads/pi-ws/`, derive the user-visible name strictly from that prefix, store the original base branch in local Git config, verify that the main worktree is currently on the recorded base branch, and verify that the linked worktree still has `refs/heads/pi-ws/<name>` checked out before attempting cleanup.

Another risk is leaving the main worktree in a half-finished merge state. The countermeasure is to detect `MERGE_HEAD`, enumerate unresolved files with `git diff --name-only --diff-filter=U`, and support only three safe states: finalize an already-resolved finish merge with `git commit --no-edit`, abort immediately on user decline, or keep the merge open for model-assisted resolution and refuse branch deletion until the merge is either committed or aborted.

A third risk is command collision with the jj extension. The countermeasure is to use `isGitRepo(process.cwd())` plus a tiny local jj-repo detector and early-return when a `.jj` directory exists anywhere above `process.cwd()`.

A fourth risk is that users may manually change the linked worktree to some other branch. The countermeasure is to read the linked worktree's current symbolic ref during `/ws-finish` and stop with a repair message if it no longer points at `refs/heads/pi-ws/<name>`.

A fifth risk is concurrent or repeated command execution. The countermeasure is to treat Git as the serialization boundary: every create, merge, remove, and delete operation must still check the actual Git state after the command runs and surface the real Git error instead of relying only on preflight checks.

A sixth risk is introducing duplicated tmux logic that drifts later. The countermeasure is to extract the existing helper into `pi/lib/tmux-workspaces.ts` and re-point jj to it before adding any Git worktree command logic.

## Progress

- [x] (2026-04-02 21:15Z) Read the current jj workspace implementation, the tmux helper, the Git extension layout, and the existing jj workspace plan.
- [x] (2026-04-02 21:25Z) Verified that `package.json` loads both `./pi/git/extensions` and `./pi/jj/extensions`, so the Git feature must avoid jj repos.
- [x] (2026-04-02 21:35Z) Verified the intended jj conflict UX and documented the Git feature to match it.
- [x] (2026-04-02 22:05Z) Rebased this workspace onto the current `default@` and confirmed that `pi/jj/extensions/jj-workspace.ts` now includes conflicted-file discovery, optional model-assisted resolution, and the guard against forgetting while the default workspace remains conflicted.
- [x] (2026-04-02 22:10Z) Verified that `pi/jj/lib/tmux-workspaces.ts` contains no jj-specific behavior and is safe to extract into a shared helper.
- [x] (2026-04-02 22:40Z) Extracted `pi/lib/tmux-workspaces.ts`, moved helper tests to `pi/lib/tmux-workspaces.test.ts`, updated `pi/jj/extensions/jj-workspace.ts`, and removed the jj-local helper copies.
- [x] (2026-04-02 22:55Z) Added Git worktree parsing helpers in `pi/git/lib/worktree.ts` with fixture-driven unit coverage in `pi/git/lib/worktree.test.ts`.
- [x] (2026-04-02 23:25Z) Implemented `/ws-create` in `pi/git/extensions/git-worktree.ts`, including main-worktree checks, branch/path collision checks, base-branch config writes, and tmux rollback cleanup.
- [x] (2026-04-02 23:35Z) Implemented `/ws-list` in `pi/git/extensions/git-worktree.ts` for managed worktrees only, including base-branch repair hints and tmux window state.
- [x] (2026-04-02 23:45Z) Implemented `/ws-switch` in `pi/git/extensions/git-worktree.ts`, including existing-window selection and `pi -c` recreation.
- [x] (2026-04-03 00:10Z) Implemented `/ws-finish` in `pi/git/extensions/git-worktree.ts`, including clean merges, already-merged cleanup, conflict-decline abort, model-assisted conflict handoff, rerun-after-resolution commit finalization, and dirty-state guards.
- [x] (2026-04-03 00:20Z) Added unit coverage for Git worktree parsing and extension lifecycle behavior in `test/extensions/git-worktree.test.ts`.
- [x] (2026-04-03 00:32Z) Ran targeted tests plus `npm test`; both passed (`npm test`: 672 passed, 1 skipped).
- [ ] Manually validate create, switch, finish, conflict-decline, and conflict-accept flows in a real Git repo inside tmux.

## Surprises & Discoveries

- Observation: after rebasing onto the current `default@`, the jj workspace feature already includes the model-assisted finish-conflict flow this Git plan wants to mirror.
  Evidence: `pi/jj/extensions/jj-workspace.ts` now contains `getConflictedFiles()`, a conflict confirmation prompt, a `pi.sendUserMessage(...)` handoff, and a guard that blocks `workspace forget` while `default@` still reports `conflict=true`.

- Observation: the current tmux helper is already generic.
  Evidence: `pi/jj/lib/tmux-workspaces.ts` only shells out to `tmux`, tags windows with `@pi-ws`, and never refers to jj-specific commands or data structures.

- Observation: the Git side currently has no worktree lifecycle support at all.
  Evidence: before implementation, `pi/git/extensions` contained `git-commit.ts` only.

- Observation: the Git extension can stay self-contained even while reusing the shared tmux helper.
  Evidence: the final implementation adds Git-only state handling in `pi/git/extensions/git-worktree.ts` and `pi/git/lib/worktree.ts`, while `pi/lib/tmux-workspaces.ts` remains VCS-agnostic and jj tests still pass.

- Observation: repository-wide automated validation stayed green after the extraction and Git feature landed.
  Evidence: `node --experimental-strip-types --test 'pi/lib/tmux-workspaces.test.ts' 'pi/git/lib/worktree.test.ts' 'test/extensions/git-worktree.test.ts' 'test/extensions/jj-workspace.test.ts'` passed, and `npm test` finished with 672 passed, 1 skipped, 0 failed.

## Decision Log

- Decision: keep the user-facing command names `/ws-create`, `/ws-list`, `/ws-switch`, and `/ws-finish` for Git repos.
  Rationale: users should get the same lifecycle vocabulary across jj and Git.
  Date: 2026-04-02

- Decision: manage only branches under `refs/heads/pi-ws/<name>` and sibling directories named `<repo-name>-ws-<name>`.
  Rationale: this creates a safe, enumerable subset of worktrees that the extension can clean up without guessing.
  Date: 2026-04-02

- Decision: extract the existing tmux helper into `pi/lib/tmux-workspaces.ts` and reuse it from both jj and Git.
  Rationale: the helper is already VCS-agnostic, so copying it into `pi/git/lib` would create avoidable drift and maintenance risk.
  Date: 2026-04-02

- Decision: reject dirty Git worktrees during `/ws-finish`.
  Rationale: Git has no jj-like automatic snapshotting, and surprise commits or auto-stashes would make rollback and auditability worse.
  Date: 2026-04-02

- Decision: mirror the current jj finish conflict UX as closely as Git allows.
  Rationale: users explicitly asked for jj-workspace parity, and the latest jj change is the improved merge-conflict flow.
  Date: 2026-04-02

## Outcomes & Retrospective

As of 2026-04-03 00:32Z, the planned code work is complete. Plain Git repositories now register `/ws-create`, `/ws-list`, `/ws-switch`, and `/ws-finish` via `pi/git/extensions/git-worktree.ts`; jj repositories still only register the jj implementation because the Git extension exits early when a `.jj` directory is present. Shared tmux orchestration now lives in `pi/lib/tmux-workspaces.ts`, with jj updated to consume that shared helper.

The implemented Git flow matches the intended operator experience closely: managed worktrees use the `pi-ws/<name>` branch namespace and sibling `<repo>-ws-<name>` directories; `/ws-create` records the base branch in local Git config and rolls back on tmux setup failure; `/ws-list` reports only managed worktrees; `/ws-switch` reuses or recreates tmux windows; and `/ws-finish` handles clean merges, already-merged cleanup, dirty-state rejection, conflict abort, model-assisted conflict resolution handoff, and rerun-after-resolution completion.

The remaining gap is manual tmux-backed validation in a real Git repository. Automated coverage is now in place and passing, but the acceptance scenarios in the Validation section should still be exercised manually before calling the feature fully production-validated.

## Context and Orientation

The extension entry points loaded by `pi` live under `pi/*/extensions`. The Git extension area now contains both `pi/git/extensions/git-commit.ts` and the new `pi/git/extensions/git-worktree.ts`, with Git repo detection in `pi/git/lib/utils.ts` and Git worktree parsing helpers in `pi/git/lib/worktree.ts`. The jj workspace implementation that this feature emulates lives in `pi/jj/extensions/jj-workspace.ts`. Shared tmux window orchestration now lives in `pi/lib/tmux-workspaces.ts`, which both jj and Git consume. The jj workspace naming helpers live in `pi/jj/lib/workspace.ts`. Test scaffolding for extensions lives in `test/helpers.ts`, and the relevant lifecycle tests now live in `test/extensions/jj-workspace.test.ts` and `test/extensions/git-worktree.test.ts`.

A "managed worktree" in this plan means a Git linked worktree created by this extension, backed by branch `refs/heads/pi-ws/<name>`, located at sibling directory `<repo-name>-ws-<name>`, and tracked in local Git config with key `pi.worktree.<name>.baseBranch`. The "main worktree" means the original Git checkout whose `.git` directory is the common Git directory for linked worktrees. `/ws-create` and `/ws-finish` run only from the main worktree session. Linked worktree sessions are ordinary `pi` sessions opened in tmux windows whose OS-level current working directory is the worktree path.

Git commands in this plan use two kinds of outputs that the tests must model directly. The first is `git worktree list --porcelain`, which emits records separated by blank lines. The second is merge-state inspection, where `MERGE_HEAD` and `git diff --name-only --diff-filter=U` describe whether a previous `/ws-finish` is still unresolved.

## Preconditions and Verified Facts

The implementation depends on these repository facts, all verified in the current tree after rebasing this workspace onto `default@`:

- `package.json` includes both `./pi/git/extensions` and `./pi/jj/extensions` in `pi.extensions`.
- `pi/git/extensions/git-commit.ts` and `pi/git/extensions/git-worktree.ts` are now the Git extension entry points.
- `pi/git/lib/utils.ts` already exports `isGitRepo(dir: string): boolean` and works for linked Git worktrees because it checks `existsSync(join(current, ".git"))`, which succeeds for both `.git` directories and `.git` files.
- `pi/jj/extensions/jj-workspace.ts` already demonstrates the command surface, tmux orchestration pattern, and finish lifecycle that Git should imitate.
- `pi/jj/extensions/jj-workspace.ts` now includes the conflict workflow to mirror: conflicted-file discovery, a confirmation prompt that offers model-assisted resolution, a `pi.sendUserMessage(...)` handoff when the user accepts, and a guard that blocks cleanup while the default workspace remains conflicted.
- `pi/lib/tmux-workspaces.ts` and `pi/lib/tmux-workspaces.test.ts` now provide the shared tmux helper and tests consumed by both jj and Git.
- `pi/jj/lib/workspace.ts` already exports `isValidWorkspaceName(name: string): boolean`; the Git feature should reuse that validation rule instead of inventing a second naming policy.
- `test/helpers.ts` provides the mock `ExtensionAPI` used by extension tests.

The implementation also depends on these Git command facts, which the tests should encode as raw fixtures instead of requiring the implementer to look them up externally.

Representative `git worktree list --porcelain` fixture:

    worktree /tmp/repo
    HEAD 1111111111111111111111111111111111111111
    branch refs/heads/main

    worktree /tmp/repo-ws-auth
    HEAD 2222222222222222222222222222222222222222
    branch refs/heads/pi-ws/auth

    worktree /tmp/repo-ws-detached
    HEAD 3333333333333333333333333333333333333333
    detached

Representative successful `git rev-parse` fixture values:

    git rev-parse --show-toplevel
    /tmp/repo-ws-auth

    git rev-parse --git-common-dir
    /tmp/repo/.git

Representative merge-conflict fixture outputs:

    git merge --no-ff --no-edit refs/heads/pi-ws/auth -m finish workspace auth
    Auto-merging src/app.ts
    CONFLICT (content): Merge conflict in src/app.ts
    Automatic merge failed; fix conflicts and then commit the result.

    git diff --name-only --diff-filter=U
    src/app.ts
    src/lib/auth.ts

    git rev-parse MERGE_HEAD
    2222222222222222222222222222222222222222

## Scope Boundaries

In scope:

- Extract shared tmux helpers into `pi/lib/tmux-workspaces.ts` and `pi/lib/tmux-workspaces.test.ts`.
- Small jj import updates needed to consume the shared tmux helper after extraction.
- New Git-specific worktree parsing helpers in `pi/git/lib/worktree.ts`.
- New extension entry point `pi/git/extensions/git-worktree.ts`.
- New tests in `pi/git/lib/worktree.test.ts` and `test/extensions/git-worktree.test.ts`.
- Any small supporting edits needed in package-loaded extension discovery, which should remain automatic once the new file exists.

Out of scope:

- Refactoring jj workspace semantics beyond the shared tmux helper extraction.
- A generic cross-VCS workspace engine.
- Automatic branch checkout or default-branch switching in the main worktree.
- Auto-committing or auto-stashing dirty worktrees.
- Support for arbitrary manually created worktrees that do not use the managed `pi-ws/` branch namespace.

## Milestones

Milestone 1 extracts the shared tmux helper and establishes the Git-specific parsing primitives without changing user-visible Git behavior yet. At the end of it, `pi/lib/tmux-workspaces.ts` is the single tmux helper used by jj, jj tests still pass, and a developer can parse `git worktree list --porcelain` output into a safe internal model, detect the main worktree, and derive managed worktree names from `refs/heads/pi-ws/<name>`. This milestone exists to prove that the shared helper extraction and the Git data model are both solid before command wiring begins.

Milestone 2 adds `/ws-create` for Git repos. At the end of it, a user in the main worktree can create a linked worktree on a managed branch, get a tmux window for it, and see safe rollback if tmux setup fails.

Milestone 3 adds `/ws-list` and `/ws-switch` for Git repos. At the end of it, a user can inspect managed worktrees and switch to an already-open or recreated tmux window for one of them.

Milestone 4 implements `/ws-finish` for the clean-success path and the two improved conflict paths. At the end of it, a clean merge removes the Git worktree and deletes the managed branch, a declined conflict aborts the merge and preserves the worktree, and an accepted conflict hands control to the model and blocks cleanup until the merge is fully resolved.

Milestone 5 hardens the feature with tests and real-command validation. At the end of it, targeted tests and the full test suite pass, and manual runs prove the behavior in a temporary Git repo inside tmux.

## Plan of Work

Start by extracting the tmux helper into `pi/lib/tmux-workspaces.ts`. Copy the existing file from `pi/jj/lib/tmux-workspaces.ts` without changing its public API, move the tests into `pi/lib/tmux-workspaces.test.ts`, update `pi/jj/extensions/jj-workspace.ts` to import from the shared path, and then delete the jj-local helper file and test. This should be a behavior-preserving move with no jj semantic changes.

Next create `pi/git/lib/worktree.ts`. Define a small set of pure helpers that do not depend on `ExtensionAPI`: derivation of managed branch names, parsing of `git worktree list --porcelain` records, extraction of managed worktree names from `refs/heads/pi-ws/<name>`, validation that a linked worktree is still on its managed branch, and helpers for determining whether the current checkout is the main worktree. Keep this file focused on data modeling and parsing so it can be tested without shelling out.

Then add `pi/git/extensions/git-worktree.ts`. At the top of the extension, early-return unless the repo is a plain Git repo. Use `isGitRepo(process.cwd())` plus a tiny local `.jj`-directory walk to avoid registering in jj repos. Inside the extension, implement `runGit(args, options)` using `pi.exec("git", ...)`, `listManagedWorktrees()`, `resolveManagedWorktree(name)`, `getMainWorktreeRoot()`, `getCurrentBranch(cwd)`, `getCurrentBranchRef(cwd)`, `worktreeIsDirty(wsPath)`, `mainWorktreeHasMergeInProgress()`, `listUnmergedFiles(cwd)`, `createManagedWorktree(name)`, and cleanup helpers for `git worktree remove` plus `git branch -d`.

Implement `/ws-create` first. It must validate that the current session is in the main worktree, that `HEAD` is on a branch rather than detached, that no merge is in progress, that no managed branch `refs/heads/pi-ws/<name>` already exists, and that the sibling path `<repo-name>-ws-<name>` does not already exist. It then creates the worktree with `git worktree add -b pi-ws/<name> <path> <baseBranch>`, records `pi.worktree.<name>.baseBranch=<baseBranch>` in local Git config, creates the tmux window, and if tmux window creation fails, removes the worktree and deletes the branch before returning an error.

Implement `/ws-list` next. It should list only managed linked worktrees, not the main worktree and not arbitrary unrelated worktrees. For each managed worktree, show its logical name, path, branch, base branch from config, and tmux window status. If the config key is missing, display `<unknown>` and mark the entry as needing repair rather than guessing.

Implement `/ws-switch` after that. It verifies that the managed worktree exists. If a tagged tmux window already exists, it selects it. Otherwise it verifies that the worktree path still exists on disk, creates a new tmux window with `pi -c`, and warns if selection fails.

Finish with `/ws-finish`. First verify that the command runs from the main worktree and that the current branch equals the recorded base branch for the target worktree. Then verify that the linked worktree still has `refs/heads/pi-ws/<name>` checked out. Then handle three mutually exclusive states in this order.

First, if a merge is already in progress in the main worktree, inspect whether it is the in-progress finish merge for this target by comparing `git rev-parse MERGE_HEAD` to `git rev-parse refs/heads/pi-ws/<name>`. If it is not, abort with an error saying another merge is already in progress. If it is and unresolved files remain, error without cleanup. If it is and no unresolved files remain, finalize the merge with `git commit --no-edit` and continue to cleanup.

Second, if no merge is in progress, verify that the linked worktree is clean with `git -C <wsPath> status --porcelain`. If it is dirty, error and tell the user to commit or stash in the worktree first. Also verify that the main worktree is clean before starting a merge. If the managed branch is already merged into the current base branch, skip directly to cleanup.

Third, if a merge is needed, run `git merge --no-ff --no-edit refs/heads/pi-ws/<name> -m "finish workspace <name>"`. If it succeeds, continue to cleanup. If it fails with conflicts, gather conflicted files via `git diff --name-only --diff-filter=U`, prompt the user whether the session model should attempt to resolve them, and then either run `git merge --abort` on decline or send a `pi.sendUserMessage(...)` instruction block on acceptance. If `git merge` fails and `MERGE_HEAD` is absent, surface the raw Git error and stop without attempting cleanup because this is not a managed conflict path.

Cleanup means, in order: confirm the tmux window is gone or kill it if present, run `git worktree remove <wsPath>`, run `git branch -d pi-ws/<name>`, clear `pi.worktree.<name>.baseBranch` with `git config --local --unset`, refresh cached worktree data, and notify with a recent-history summary using `git log --oneline -n 4`. If `git worktree remove` succeeds but branch deletion fails, stop and notify rather than force-deleting anything. If `git worktree remove` fails because the path is unexpectedly missing, do not `rm -rf`; report the error and leave manual recovery explicit.

## Concrete Steps

All commands below are run from the repository root.

1. Extract the shared tmux helper.
   - Create `pi/lib/tmux-workspaces.ts` by copying the implementation from `pi/jj/lib/tmux-workspaces.ts` without changing function names or result shapes.
   - Create `pi/lib/tmux-workspaces.test.ts` by moving the current tests from `pi/jj/lib/tmux-workspaces.test.ts`.
   - Update `pi/jj/extensions/jj-workspace.ts` to import from `../../lib/tmux-workspaces.ts`.
   - Delete `pi/jj/lib/tmux-workspaces.ts` and `pi/jj/lib/tmux-workspaces.test.ts` after the new shared file is in place.
   - Run:

        node --experimental-strip-types --test 'pi/lib/tmux-workspaces.test.ts' 'test/extensions/jj-workspace.test.ts'

   - Expect all tests to pass.
   - Commit point: `refactor(tmux): share workspace window helper across jj and git`

2. Add pure Git parsing helpers.
   - Create `pi/git/lib/worktree.ts`.
   - Create `pi/git/lib/worktree.test.ts`.
   - Start by pasting the porcelain fixture from the Preconditions section into the test file.
   - Write failing tests for:
     - parsing the fixture with main, managed, and detached worktrees,
     - extracting `auth` from `refs/heads/pi-ws/auth`,
     - rejecting unrelated branches such as `refs/heads/feature/auth`,
     - validating legal and illegal workspace names through the shared naming rule,
     - computing the main worktree root from the `--show-toplevel` and `--git-common-dir` fixture values,
     - rejecting a linked worktree that no longer has `refs/heads/pi-ws/<name>` checked out.
   - Run:

        node --experimental-strip-types --test 'pi/git/lib/worktree.test.ts'

   - Expect initial `not ok` output, then zero failures after implementation.
   - Commit point: `feat(git-worktree): add managed worktree parsing helpers`

3. Implement `/ws-create`.
   - Create `pi/git/extensions/git-worktree.ts`.
   - Create `test/extensions/git-worktree.test.ts`.
   - Add failing tests first for:
     - no-op outside Git repos,
     - no-op inside jj repos,
     - `/ws-create` missing name,
     - `/ws-create` from a linked worktree instead of the main worktree,
     - `/ws-create` detached HEAD,
     - `/ws-create` branch collision,
     - `/ws-create` path collision,
     - `/ws-create` tmux setup rollback.
   - In the test file, model Git command outputs with `execMock` fixtures rather than shelling out. Use exact fixture strings for `git worktree add`, `git config --local`, `git rev-parse --show-toplevel`, and branch detection.
   - Run:

        node --experimental-strip-types --test 'test/extensions/git-worktree.test.ts'

   - Expect the new `/ws-create` tests to fail first, then pass after implementation.
   - Commit point: `feat(git-worktree): create managed worktrees`

4. Implement `/ws-list`.
   - Extend `test/extensions/git-worktree.test.ts` with failing tests for:
     - `/ws-list` rendering of managed worktrees and live versus missing windows,
     - `/ws-list` omitting the main worktree and unrelated linked worktrees,
     - `/ws-list` showing `<unknown>` when `pi.worktree.<name>.baseBranch` is missing.
   - Use the porcelain fixture from the Preconditions section and add a mock `tmux list-windows` fixture in the same test file.
   - Re-run:

        node --experimental-strip-types --test 'test/extensions/git-worktree.test.ts'

   - Commit point: `feat(git-worktree): list managed worktrees`

5. Implement `/ws-switch`.
   - Extend `test/extensions/git-worktree.test.ts` with failing tests for:
     - `/ws-switch` selecting existing windows,
     - `/ws-switch` recreating missing windows with `pi -c`,
     - `/ws-switch` erroring when the managed worktree no longer exists.
   - Use the same targeted test command.
   - Commit point: `feat(git-worktree): switch managed worktrees`

6. Implement `/ws-finish` success and cleanup path.
   - Extend `test/extensions/git-worktree.test.ts` with failing tests for:
     - `/ws-finish nonexistent` errors cleanly,
     - finish only from the main worktree,
     - finish requires the current branch to equal the recorded base branch,
     - finish errors if the linked worktree no longer has `refs/heads/pi-ws/<name>` checked out,
     - dirty linked worktree is rejected,
     - dirty main worktree is rejected,
     - already-merged managed branch skips merge and proceeds to cleanup,
     - clean merge runs `git merge --no-ff --no-edit` then `git worktree remove` and `git branch -d`.
   - Use the targeted test command and implement the minimal passing code.
   - Commit point: `feat(git-worktree): finish and cleanup managed worktrees`

7. Implement the improved conflict paths.
   - Add failing tests for:
     - merge conflict plus user decline runs `git merge --abort` and preserves worktree and branch,
     - merge conflict plus user accept sends exactly one `pi.sendUserMessage(...)` instruction block and does not abort or clean up,
     - rerunning finish while unresolved files remain errors and does not clean up,
     - rerunning finish after conflicts are resolved but before the merge is committed runs `git commit --no-edit` and then cleans up,
     - another unrelated merge already in progress blocks `/ws-finish`,
     - a non-conflict `git merge` failure with no `MERGE_HEAD` surfaces the Git error and performs no cleanup.
   - Build these tests around the exact merge-conflict fixture outputs listed in Preconditions.
   - Use the same targeted test command.
   - Commit point: `feat(git-worktree): add model-assisted finish conflict flow`

8. Run the full suite and manual validation.
   - Run:

        node --experimental-strip-types --test 'pi/lib/tmux-workspaces.test.ts' 'pi/git/lib/worktree.test.ts' 'test/extensions/git-worktree.test.ts' 'test/extensions/jj-workspace.test.ts'

   - Expect zero failing tests.
   - Then run:

        npm test

   - Expect zero failing tests.
   - In a temporary Git repo inside tmux, exercise the scenarios listed in the Validation section below.
   - Commit point: `test(git-worktree): validate git worktree workspace lifecycle`

## Testing and Falsifiability

Add or modify tests exactly as follows.

In `pi/lib/tmux-workspaces.test.ts`, keep the current jj tmux helper tests unchanged in spirit. The move to shared code is correct only if `test/extensions/jj-workspace.test.ts` still passes without any jj behavior changes.

In `pi/git/lib/worktree.test.ts`, add pure tests for parsing and naming. Use this exact porcelain fixture as the baseline parsing input:

    worktree /tmp/repo
    HEAD 1111111111111111111111111111111111111111
    branch refs/heads/main

    worktree /tmp/repo-ws-auth
    HEAD 2222222222222222222222222222222222222222
    branch refs/heads/pi-ws/auth

    worktree /tmp/repo-ws-detached
    HEAD 3333333333333333333333333333333333333333
    detached

Add a test where only the `refs/heads/pi-ws/auth` record is treated as managed. Include a negative test for `refs/heads/feature/auth` so the parser proves it will not accidentally manage arbitrary branches. Include a test that `computeMainWorktreeRoot("/tmp/repo-ws-auth", "/tmp/repo/.git")` returns `/tmp/repo`, and a test that `computeMainWorktreeRoot("/tmp/repo", ".git")` returns `/tmp/repo`.

In `test/extensions/git-worktree.test.ts`, model the suite after `test/extensions/jj-workspace.test.ts`. Use the same mock `ExtensionAPI` and the same `withCwd` / `withEnv` style. Mock Git command outputs with exact strings, not ad hoc booleans, so the tests prove that parsing logic and command sequencing both work. Include these raw fixtures in the test file:

    git worktree list --porcelain
    worktree /tmp/repo
    HEAD 1111111111111111111111111111111111111111
    branch refs/heads/main

    worktree /tmp/repo-ws-auth
    HEAD 2222222222222222222222222222222222222222
    branch refs/heads/pi-ws/auth

    git merge conflict stderr
    Auto-merging src/app.ts
    CONFLICT (content): Merge conflict in src/app.ts
    Automatic merge failed; fix conflicts and then commit the result.

    git diff --name-only --diff-filter=U
    src/app.ts
    src/lib/auth.ts

Cover, at minimum:

- registration outside Git repos and inside jj repos,
- `/ws-create` usage errors and rollback behavior,
- `/ws-create` rejection from a linked worktree,
- `/ws-list` output formatting,
- `/ws-switch` existing-window and recreate-window flows,
- `/ws-finish` nonexistent-target error,
- `/ws-finish` clean success,
- `/ws-finish` dirty-main and dirty-worktree rejections,
- `/ws-finish` wrong-branch-in-linked-worktree rejection,
- `/ws-finish` conflict-decline path with `git merge --abort`,
- `/ws-finish` conflict-accept path with `pi.sendUserMessage(...)`,
- `/ws-finish` rerun after unresolved conflicts still exist,
- `/ws-finish` rerun after conflicts are resolved and ready for `git commit --no-edit`,
- `/ws-finish` non-conflict merge failure.

The plan is falsified if any of these happen during tests or manual runs:

- `/ws-create` registers inside a jj repo.
- `/ws-create` succeeds from a linked worktree instead of the main worktree.
- `/ws-finish` deletes a worktree whose branch is not in `refs/heads/pi-ws/`.
- A merge conflict decline leaves `MERGE_HEAD` present.
- A merge conflict accept deletes the worktree before the merge is committed.
- A second `/ws-finish` run forgets cleanup state even though unresolved conflicts still exist.
- The shared tmux helper extraction regresses `test/extensions/jj-workspace.test.ts`.
- `npm test` regresses the existing jj workspace tests.

## Validation and Acceptance

The feature is accepted only if all of the following are true.

1. In a plain Git repo running inside tmux, `/ws-create auth` creates sibling directory `<repo-name>-ws-auth`, branch `pi-ws/auth`, and a tmux window named `ws:auth` running `pi`.
2. Inside the created worktree window, `pwd` shows the worktree path and `@` file picking works normally because the process CWD is real.
3. `/ws-list` in the main worktree shows each managed worktree with name, path, branch, base branch, and whether its tmux window is live.
4. `/ws-switch auth` focuses the existing worktree window, or recreates it with `pi -c` if the window was closed.
5. If the managed branch merges cleanly, `/ws-finish auth` creates a merge commit on the recorded base branch, removes the linked worktree, deletes branch `pi-ws/auth`, clears local config key `pi.worktree.auth.baseBranch`, and shows recent `git log --oneline -n 4` output.
6. If finishing conflicts and the user declines model help, `/ws-finish auth` runs `git merge --abort`, leaves the worktree and branch intact, and reports that finish was cancelled.
7. If finishing conflicts and the user accepts model help, the extension sends one user message that names the conflicted files, tells the model to resolve conflict markers, and instructs the user to rerun `/ws-finish auth` afterward. No cleanup happens yet.
8. If the user reruns `/ws-finish auth` while unresolved files still exist in the main worktree, the command errors and performs no cleanup.
9. If the user reruns `/ws-finish auth` after the conflicts are resolved, the command finalizes the merge with `git commit --no-edit` and then performs normal cleanup.
10. `node --experimental-strip-types --test 'pi/lib/tmux-workspaces.test.ts' 'pi/git/lib/worktree.test.ts' 'test/extensions/git-worktree.test.ts' 'test/extensions/jj-workspace.test.ts'` passes.
11. `npm test` passes.

Manual validation setup:

- Create a temporary Git repo and initial commit:

      tmpdir="$(mktemp -d)"
      cd "$tmpdir"
      mkdir demo-repo
      cd demo-repo
      git init -b main
      printf 'base\n' > README.md
      git add README.md
      git commit -m 'initial commit'

- Start tmux and `pi` from that repo:

      tmux new-session -s pi-git-worktree-demo
      cd "$tmpdir/demo-repo"
      pi

Manual validation scenarios:

Scenario A: full clean lifecycle.
- From the main worktree on branch `main`, run `/ws-create feature-test`.
- In the `ws:feature-test` window, edit a file and commit it.
- Back in the main worktree window, run `/ws-finish feature-test`.
- Observe a new merge commit on `main`, the linked worktree directory removed, and `git branch --list 'pi-ws/*'` no longer showing `pi-ws/feature-test`.

Scenario B: switch after window exit.
- Create `temp-ws`.
- Exit `pi` in the worktree window so tmux destroys the window.
- Run `/ws-switch temp-ws` from the main worktree.
- Observe a new `ws:temp-ws` window started with `pi -c` in the worktree path.

Scenario C: conflict, decline model.
- Create a worktree branch and make conflicting edits in the main worktree branch and the worktree branch.
- Run `/ws-finish conflict-ws`.
- Decline model assistance.
- Observe no lingering merge in progress and that the worktree still exists.

Scenario D: conflict, accept model, resolve, rerun.
- Repeat the conflict setup.
- Run `/ws-finish conflict-ws` and accept model assistance.
- Observe the warning message and the model instructions.
- Resolve the files in the main worktree session.
- Rerun `/ws-finish conflict-ws`.
- Observe the merge commit completes and cleanup happens only after resolution.

Scenario E: dirty-state guards.
- Try `/ws-finish dirty-ws` while the linked worktree has uncommitted changes.
- Expect an error instructing the user to commit or stash in the worktree first.
- Try again with a dirty main worktree.
- Expect an error instructing the user to clean the main worktree before merging.

Scenario F: linked worktree manually changed to another branch.
- Create `auth`.
- In the linked worktree, manually check out `main` or another non-managed branch.
- Run `/ws-finish auth` from the main worktree.
- Expect an error explaining that the linked worktree is no longer on `pi-ws/auth` and must be repaired manually before finish can continue.

## Rollout, Recovery, and Idempotence

The feature is additive because it creates a new extension file under `pi/git/extensions`, extracts a generic tmux helper into `pi/lib`, and does not change any user-visible Git command behavior outside the new `/ws-*` commands.

Recovery rules:

- If the shared tmux helper extraction breaks jj tests, stop and fix the extraction before adding any Git worktree code.
- If `/ws-create` succeeds at `git worktree add` but fails while creating the tmux window, immediately run `git worktree remove <wsPath>` and `git branch -D pi-ws/<name>` before returning an error.
- If `/ws-finish` hits conflicts and the user declines model assistance, immediately run `git merge --abort` and stop.
- If `/ws-finish` hits conflicts and the user accepts model assistance, do not abort, do not remove the worktree, and do not delete the branch. The safe retry is to resolve the files and rerun `/ws-finish <name>`.
- If `/ws-finish` fails with a non-conflict Git merge error and `MERGE_HEAD` is absent, surface the Git error and stop. Do not guess at recovery.
- If branch deletion fails after worktree removal, stop and notify. Manual recovery is then:

      git branch -d pi-ws/<name>

- If a stale config key remains after a failed cleanup, manual recovery is:

      git config --local --unset pi.worktree.<name>.baseBranch

Idempotence expectations:

- Re-running `/ws-create <name>` fails cleanly if branch `pi-ws/<name>` or path `<repo-name>-ws-<name>` already exists.
- Re-running `/ws-switch <name>` on an already-open window just selects that window again.
- Re-running `/ws-finish <name>` after a clean successful finish fails cleanly because the managed worktree no longer exists.

## Artifacts and Notes

Expected create transcript excerpt:

    /ws-create auth
    # notification: Created worktree 'auth' at ../repo-ws-auth.
    # notification: Opened tmux window ws:auth.

Expected clean finish transcript excerpt:

    /ws-finish auth
    # notification: Finished workspace auth, merged into main, removed worktree ../repo-ws-auth, deleted branch pi-ws/auth.

Expected conflict-decline excerpt:

    /ws-finish conflict-ws
    # notification (error): Merge conflict detected while finishing conflict-ws. Merge aborted. Resolve in the worktree and retry.

Expected conflict-accept excerpt:

    /ws-finish conflict-ws
    # notification (warning): Merge conflict in: src/app.ts, src/lib/auth.ts. Asking model to resolve. Run /ws-finish conflict-ws again after resolution.

Representative Git conflict markers the model handoff should mention:

    <<<<<<< HEAD
    current branch content
    =======
    worktree branch content
    >>>>>>> pi-ws/auth

## Interfaces and Dependencies

`pi/git/lib/worktree.ts` should define and export the narrow data model used by the extension:

    export interface GitWorktreeEntry {
      path: string;
      head: string;
      branchRef: string | null;
      bare: boolean;
      detached: boolean;
      locked: boolean;
      prunable: boolean;
    }

    export interface ManagedGitWorktree {
      name: string;
      path: string;
      branchRef: string;
      head: string;
    }

    export const MANAGED_WORKTREE_BRANCH_PREFIX = "refs/heads/pi-ws/";
    export function managedBranchRef(name: string): string;
    export function managedNameFromBranchRef(branchRef: string | null): string | null;
    export function parseGitWorktreeList(output: string): GitWorktreeEntry[];
    export function toManagedGitWorktree(entry: GitWorktreeEntry): ManagedGitWorktree | null;
    export function computeMainWorktreeRoot(showTopLevel: string, gitCommonDir: string): string;
    export function linkedWorktreeOnManagedBranch(currentBranchRef: string | null, name: string): boolean;

`pi/lib/tmux-workspaces.ts` should export the same interface shape the jj extension already uses:

    export interface TmuxWorkspaceWindow {
      windowId: string;
      windowName: string;
      wsName: string;
      active: boolean;
    }

    export function inTmuxEnv(env?: Record<string, string | undefined>): boolean;
    export function parseTmuxVersion(output: string): number | null;
    export function parseWorkspaceWindows(output: string): TmuxWorkspaceWindow[];
    export async function listWorkspaceWindows(pi: ExtensionAPI): Promise<TmuxWorkspaceWindow[]>;
    export async function findWorkspaceWindow(pi: ExtensionAPI, wsName: string): Promise<TmuxWorkspaceWindow | null>;
    export async function selectWindow(pi: ExtensionAPI, windowId: string): Promise<boolean>;
    export async function killWindow(pi: ExtensionAPI, windowId: string): Promise<boolean>;
    export async function createWorkspaceWindow(pi: ExtensionAPI, options: { wsName: string; cwd: string; continueRecent: boolean }): Promise<{ ok: true; windowId: string; selected: boolean } | { ok: false; error: string }>;

`pi/git/extensions/git-worktree.ts` should remain the only command-registration file for this feature and should keep helpers private unless tests force extraction. It will depend on:

- `pi/git/lib/utils.ts` for `isGitRepo`.
- `pi/jj/lib/workspace.ts` for the shared `isValidWorkspaceName(name: string)` rule.
- `pi/git/lib/worktree.ts` for parsing and name derivation.
- `pi/lib/tmux-workspaces.ts` for tmux window management.
- `node:fs` and `node:path` only for lightweight repo-marker and path checks.

The conflict-resolution handoff message must use Git conflict marker examples, not jj conflict markers.

Revision note (2026-04-02): rebased this workspace onto the current `default@`, confirmed the jj model-assisted conflict flow already exists, replaced the duplicated Git-local tmux-helper plan with a shared extraction into `pi/lib/tmux-workspaces.ts`, split command implementation into finer-grained steps, and added concrete Git fixture outputs plus missing edge cases called out during plan review.
