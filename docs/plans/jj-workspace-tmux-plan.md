# Replace virtual jj workspace CWD redirection with tmux-backed workspace sessions

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, `/ws-create <name>` will open a real tmux window running a real pi
process whose OS working directory is the jj workspace directory. That means the
built-in tools, `!` commands, other extensions, and the `@` file picker all operate
in the workspace naturally, without pretending the current directory changed inside a
single shared process.

A user should be able to start pi in the default workspace, run `/ws-create auth`, be
switched into a tmux window named `ws:auth`, use `@` to pick files under the
workspace directory, quit that pi process, later run `/ws-switch auth` to reopen the
window with `pi -c`, and finally run `/ws-finish auth` from the default window to
snapshot any remaining workspace files, merge the workspace into default, forget the
workspace, and delete the workspace directory.

## Problem Framing and Constraints

The current implementation in `pi/jj/extensions/jj-workspace.ts` is 911 lines of
virtual-CWD machinery. It overrides the built-in `read`, `write`, `edit`, and `bash`
tools, intercepts `user_bash`, rewrites the system prompt in `before_agent_start`,
persists workspace state with `appendEntry("jj-workspace-state", ...)`, restores that
state on `session_start`, and exposes `/ws-default` solely so one pi process can
pretend to be in several directories.

That approach works only as long as every path-sensitive behavior is intercepted.
The design document in `docs/designs/jj-workspace-tmux.md` correctly identifies the
main failures: the `@` picker is still tied to `process.cwd()`, other extensions can
accidentally observe the wrong directory, and the mental model is fragile because the
OS cwd, tool cwd, prompt cwd, and user-bash cwd are not actually the same thing.

This replacement must preserve the useful user workflow from the current extension:
create workspaces, switch among them, list them, and finish them with a deterministic
merge-and-cleanup path. It must also close the design review holes captured in
`docs/designs/jj-workspace-tmux.md`: `/ws-finish` must not silently lose dirty files
that exist only on disk in another workspace directory, `/ws-create` must start a
fresh pi session instead of accidentally reopening stale history, and the extension
must not rely on `process.cwd() === jj root` to distinguish the default workspace from
a named workspace because jj reports the current workspace root in both cases.

This repository already contains unrelated red tests in `test/extensions/fetch.test.ts`
and `test/extensions/web-search.test.ts` caused by plain Node test resolution of
`@mariozechner/pi-tui`. The plan therefore must use targeted workspace-related test
commands as its green bar until that pre-existing baseline is repaired separately.

## Strategy Overview

Rewrite `pi/jj/extensions/jj-workspace.ts` from a stateful virtual-CWD extension into
an orchestration extension that talks only to jj and tmux. The extension will stop
registering tool overrides and stop mutating session state. Instead, it will create
and manage tmux windows tagged with a tmux user option (`@pi-ws=<workspace-name>`),
and each workspace window will launch a separate pi process with its actual cwd set to
the workspace path.

The extension will continue to load in jj repositories, but the commands will be thin
orchestrators. `/ws-create` will create a jj workspace, create a tagged tmux window,
force `remain-on-exit off` on that window so it disappears when pi exits, and launch a
fresh `pi` process. `/ws-switch` will focus an existing tagged window or recreate one
with `pi -c` if the window is gone. `/ws-list` will join jj workspace state with tmux
window presence and report `window: open` or `window: —`, deliberately avoiding the
stronger but less reliable claim that a pi process is definitely live. `/ws-finish`
will kill any open workspace window, then run `jj status` with `cwd: <workspace-path>`
to snapshot remaining on-disk workspace edits into jj before calculating merge heads.
Only after that snapshot step will it run the existing conflict-safe merge, workspace
forget, and directory deletion logic.

To keep the rewrite proportionate, the footer will continue to work through its
existing jj-based workspace detection path. Any cleanup of the now-dead
`jj-workspace-state` fallback in `pi/jj/extensions/jj-footer.ts` is explicitly deferred
until the tmux rewrite is stable.

## Alternatives Considered

The simplest apparent alternative is to keep the current virtual-CWD extension and try
to patch only the `@` picker. That is insufficient because it fixes one symptom while
leaving every other extension and every future path-sensitive feature exposed to the
same fake-cwd trap.

Another alternative is to keep the tmux architecture but preserve “orchestrator-only”
command registration by suppressing all `/ws-*` commands in named workspace sessions.
That is possible, but it adds startup-time detection complexity for limited benefit.
The safer and smaller approach is to register the commands in jj repos everywhere,
then enforce default-workspace-only behavior in the handlers that need it. This keeps
command discoverability intact, avoids command-list drift between windows, and still
prevents destructive actions from running in the wrong place.

A third alternative is to use `pi -c` for both `/ws-create` and `/ws-switch`. That was
rejected because `-c` explicitly continues the most recent session in a cwd. If a
user deletes and later recreates the same workspace path, `/ws-create` could reopen an
old conversation instead of starting a fresh one. Bare `pi` on create and `pi -c` only
on switch/recreate matches the intended lifecycle more closely.

## Risks and Countermeasures

The biggest risk is silent data loss during `/ws-finish`. jj commands run from the
default workspace do not snapshot dirty files from another workspace directory. The
plan removes that hole by forcing a workspace-local `jj status` after any workspace
window is closed and before merge heads are calculated. That command snapshots the
workspace’s current filesystem state into jj so merge queries see it.

The next risk is misclassifying dead workspace windows as live because some tmux
configurations keep windows after the command exits. The plan avoids depending on the
user’s tmux config by setting `remain-on-exit off` on each workspace window during
creation. `/ws-list` will still report only `window: open` or `window: —`, not “live
pi”, so the UI remains honest even if a user manually repurposes a tagged window.

Another risk is using the wrong heuristic to decide whether a command is running from
the default workspace. Repository experiments already showed that `jj root` returns
the current workspace root, not always the default repo root. The plan therefore uses
workspace identity detection based on the current `@` change ID matched against
`jj workspace list`, exactly the approach already used by the footer fallback.

The blast radius is moderate because the extension is a rewrite of an existing command
surface. Recovery is straightforward: the old implementation remains available in git
history, the new command surface is small, and the rollout can be done in one branch
with targeted tests after each milestone. If the rewrite stalls midway, the tree must
not be left with partially removed tool overrides and partially working tmux commands;
that is why the milestones below isolate helper extraction, command rewrites, and
cleanup into separate green commits.

## Progress

- [x] (2026-03-22 22:58Z) Audited the current design draft, current extension, current footer logic, current tests, and pi session/tmux documentation.
- [x] (2026-03-22 22:58Z) Verified repository facts needed for the rewrite: `jj 0.39.0`, `tmux 3.6a`, current `jj-workspace.ts` is 911 lines, targeted workspace-related tests pass, and unrelated fetch/web-search tests currently fail in plain Node due to `@mariozechner/pi-tui` resolution.
- [x] (2026-03-22 22:58Z) Verified with a temporary jj repo that `jj root` returns the current workspace root and that `jj status` run in a named workspace snapshots on-disk edits into that workspace’s working-copy commit.
- [x] (2026-03-22 22:58Z) Authored this ExecPlan in `docs/plans/jj-workspace-tmux-plan.md`.
- [x] (2026-03-22 23:29Z) Milestone 1 complete: added `pi/jj/lib/workspace.ts`, `pi/jj/lib/tmux-workspaces.ts`, and green helper tests in `pi/jj/lib/workspace.test.ts` and `pi/jj/lib/tmux-workspaces.test.ts`.
- [x] (2026-03-22 23:29Z) Milestone 2 complete: rewrote `/ws-create`, `/ws-switch`, and `/ws-list` in `pi/jj/extensions/jj-workspace.ts` to use real tmux windows with bare `pi` on create and `pi -c` on recreate.
- [x] (2026-03-22 23:29Z) Milestone 3 complete: rewrote `/ws-finish` to close tagged windows, snapshot workspace state via `jj status` in `cwd: wsPath`, then merge/forget/delete with conflict rollback.
- [x] (2026-03-22 23:29Z) Milestone 4 partial: removed virtual-CWD tool overrides, prompt rewriting, session-state persistence, and `/ws-default`; rewrote `test/extensions/jj-workspace.test.ts`; and passed the targeted workspace-related test command (`56` passing).
- [ ] Milestone 4 remaining: perform manual tmux smoke validation in a real attached tmux session and capture the results in this document.

## Surprises & Discoveries

- Observation: `jj root` is not a reliable “default workspace vs named workspace” detector.
  Evidence: in a temporary repo, `jj root` returned the default workspace path when run in the default workspace and the named workspace path when run from that named workspace.

- Observation: `jj status` run with `cwd` set to a named workspace snapshots dirty files into that workspace’s working-copy commit, while `jj status` run from the default workspace does not snapshot another workspace directory.
  Evidence: before running `jj status` in the named workspace, `jj log -r 'test@' -T 'change_id.short() ++ "|" ++ empty'` showed `empty=true`; after `jj status` in that workspace, the same query showed `empty=false`.

- Observation: the current targeted workspace-related test subset is green, but full `npm test` is not a valid gate for this work yet.
  Evidence: `node --experimental-strip-types --test pi/jj/lib/footer.test.ts pi/jj/lib/utils.test.ts pi/jj/lib/workspace.test.ts pi/jj/lib/tmux-workspaces.test.ts test/extensions/block-git-mutating.test.ts test/extensions/jj-workspace.test.ts` passed `56` tests, while `npm test` still failed in `test/extensions/fetch.test.ts` and `test/extensions/web-search.test.ts` with `ERR_MODULE_NOT_FOUND` for `@mariozechner/pi-tui`.

- Observation: the current design draft already found the right direction, but its liveness language was too strong.
  Evidence: the implementation and tests use the narrower contract “tagged window is open” plus explicit `remain-on-exit off` on creation, not process-liveness inference.

- Observation: helper extraction did not require touching the footer implementation.
  Evidence: `pi/jj/lib/workspace.ts` now contains reusable workspace parsing helpers, but `pi/jj/lib/footer.test.ts` stayed green unchanged, so footer churn was safely avoided for this pass.

## Decision Log

- Decision: register `/ws-*` commands in jj repos regardless of whether the current window is default or named workspace, then enforce default-workspace-only behavior inside handlers that require it.
  Rationale: this keeps commands discoverable, avoids startup-time branching complexity, and still prevents destructive actions from running in the wrong place.
  Date: 2026-03-22

- Decision: `/ws-create` launches bare `pi`, while `/ws-switch` recreates missing windows with `pi -c`.
  Rationale: create should start a fresh workspace session; switch should reconnect to the most recent session for an already-existing workspace directory.
  Date: 2026-03-22

- Decision: workspace windows are tagged with `@pi-ws=<name>` and explicitly forced to `remain-on-exit off`.
  Rationale: the tag makes lookup independent of window renames or tmux-title icon mutations, and `remain-on-exit off` prevents dead windows from lingering because of user-global tmux settings.
  Date: 2026-03-22

- Decision: `/ws-list` reports `window: open` or `window: —`, not “live pi”.
  Rationale: window existence is the trustworthy contract; stronger claims about process liveness are unnecessary and brittle.
  Date: 2026-03-22

- Decision: `/ws-finish` must run a workspace-local snapshot step (`jj status` with `cwd: wsPath`) after any open workspace window is closed and before merge-head evaluation.
  Rationale: this closes the main data-loss hole in the current design by ensuring dirty on-disk workspace files become visible to jj before finishing.
  Date: 2026-03-22

- Decision: require tmux 3.2 or later in the rewritten extension.
  Rationale: the current environment already satisfies it (`tmux 3.6a`), it aligns with pi’s tmux docs, and it avoids supporting older tmux behavior while the first tmux-backed implementation is stabilizing.
  Date: 2026-03-22

- Decision: leave `pi/jj/extensions/jj-footer.ts` functionally unchanged for v1 of the tmux rewrite.
  Rationale: its existing fallback detection already works when cwd is real; removing the old `jj-workspace-state` shortcut can happen later without blocking this feature.
  Date: 2026-03-22

## Outcomes & Retrospective

Interim outcome (2026-03-22): the virtual-CWD architecture has been replaced in code with a tmux-backed orchestration model. `pi/jj/extensions/jj-workspace.ts` no longer registers tool overrides, no longer rewrites the prompt, no longer intercepts `user_bash`, no longer persists workspace state, and no longer exposes `/ws-default`. The extension now registers only `/ws-create`, `/ws-switch`, `/ws-list`, and `/ws-finish`, and the implementation uses real tmux windows plus real process cwd instead of in-process path redirection.

The main safety gap from the design review is also closed in code: `/ws-finish` now runs `jj status` with `cwd: wsPath` after any tagged window is closed and before merge-head evaluation. Automated tests cover that ordering, tmux tagging, create-vs-switch launch semantics, window reuse through mutated titles, snapshot failure aborts, and conflict rollback.

The remaining gap is manual validation in an attached tmux session. Until that smoke test is run, the plan is not complete because the user-visible behavior of window focus, window disappearance after pi exit, and `@` picker rooting has not yet been observed end-to-end in a real terminal.

## Context and Orientation

This repository is a pi package rooted at `/home/bromanko.linux/Code/llm-agents`. The root `package.json` auto-loads extensions from `./pi/jj/extensions` and `./pi/tmux-titles/extensions`, so any `.ts` file under those extension directories is discovered automatically by pi.

The files directly relevant to this change are:

- `docs/designs/jj-workspace-tmux.md` — the debated design draft this plan implements.
- `docs/plans/jj-workspace-extension-plan.md` — the old plan for the virtual-CWD implementation now being replaced.
- `pi/jj/extensions/jj-workspace.ts` — the rewritten tmux-backed workspace extension.
- `pi/jj/extensions/jj-footer.ts` — current footer extension that already knows how to infer a workspace name from jj state.
- `pi/jj/lib/footer.ts` — shared footer helpers including `detectWorkspaceName(...)` and the command constants used by that detection logic.
- `pi/jj/lib/workspace.ts` — new shared workspace parsing and validation helpers added during this implementation.
- `pi/jj/lib/tmux-workspaces.ts` — new tmux window discovery and creation helpers added during this implementation.
- `pi/jj/lib/utils.ts` — `isJjRepo(dir)` helper used by jj extensions.
- `pi/tmux-titles/extensions/tmux-titles.ts` — proves the repository already detects tmux and mutates window titles; its title mutations are the reason name-based workspace lookup is fragile.
- `test/extensions/jj-workspace.test.ts` — rewritten extension test file for the tmux model.
- `test/helpers.ts` — the mock `ExtensionAPI` and `exec` harness used by extension tests.

`pi/jj/extensions/jj-workspace.ts` now focuses on four concerns only: jj command execution, tmux readiness checks, tmux window lifecycle, and finish/merge cleanup. The old fake-cwd parts have been removed: no tool override registration, no `user_bash` interception, no prompt rewriting, and no saved workspace restoration.

The current footer already contains a reliable fallback workspace detector in
`pi/jj/lib/footer.ts`: it runs `jj log -r @ -T change_id --no-graph`, then runs
`jj workspace list -T 'name ++ ":" ++ self.target().change_id() ++ "\\n"'`, and matches
the current `@` change ID against the workspace list. That detection logic is the
correct basis for default-vs-named workspace checks in the new extension because it
tracks workspace identity instead of comparing paths.

## Preconditions and Verified Facts

The following facts were verified against the current tree and current environment:

- Root test command: `npm test` runs `node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'` from the repository root.
- Current workspace-specific green test command is:

      node --experimental-strip-types --test \
        pi/jj/lib/footer.test.ts \
        pi/jj/lib/utils.test.ts \
        pi/jj/lib/workspace.test.ts \
        pi/jj/lib/tmux-workspaces.test.ts \
        test/extensions/block-git-mutating.test.ts \
        test/extensions/jj-workspace.test.ts

  It currently passes `56` tests.
- Current full suite baseline is still red for unrelated reasons: `test/extensions/fetch.test.ts` and `test/extensions/web-search.test.ts` fail with `ERR_MODULE_NOT_FOUND` for `@mariozechner/pi-tui` when run under plain Node in this repo.
- `pi/jj/extensions/jj-workspace.ts` now has `766` lines.
- `pi/jj/extensions/jj-workspace.ts` now registers only the commands `ws-create`, `ws-list`, `ws-switch`, and `ws-finish`.
- `pi/jj/extensions/jj-workspace.ts` no longer registers tool overrides and no longer attaches `user_bash`, `before_agent_start`, or `session_start` handlers.
- `pi/jj/lib/workspace.ts` now exports workspace-name validation and workspace-list parsing helpers shared by the rewrite.
- `pi/jj/lib/tmux-workspaces.ts` now exports tmux environment detection, version parsing, tagged-window parsing, and create/select/kill/list helpers.
- `pi/jj/lib/utils.ts` exports `isJjRepo(dir: string): boolean` by walking parents looking for `.jj`.
- `pi/jj/lib/footer.ts` still exports `JJ_FOOTER_COMMANDS` containing:
  - `currentChangeId: ["--color=never", "log", "-r", "@", "-T", "change_id", "--no-graph"]`
  - `workspaceList: ["--color=never", "workspace", "list", "-T", 'name ++ ":" ++ self.target().change_id() ++ "\\n"']`
- `tmux-titles` mutates `#{window_name}` and therefore makes name-only workspace lookup fragile.
- `jj --version` is `0.39.0` in the current environment.
- `tmux -V` is `tmux 3.6a` in the current environment.
- pi CLI docs confirm:
  - bare `pi` starts a normal interactive session,
  - `pi -c` / `--continue` continues the most recent session,
  - `--session-dir <dir>` exists but is optional,
  - sessions are organized by working directory.
- jj experiment verified:
  - `jj root` returns the current workspace root, not a global “main repo root”,
  - `jj status` in a named workspace snapshots workspace-local file changes into jj,
  - default-workspace jj commands do not automatically snapshot another workspace’s filesystem state.

## Scope Boundaries

In scope for this plan are the `jj-workspace` extension rewrite, the supporting helper
module(s) needed to keep it small and testable, the removal of now-obsolete command
and handler behavior from that extension, and the corresponding test rewrite.

Also in scope are small helper adjustments in `pi/jj/lib/footer.ts` if they make the
workspace-identification logic reusable without changing footer behavior. If that
reuse would require a larger refactor than expected, duplicate the minimal parse logic
in the extension and record the follow-up cleanup in the Outcomes section instead of
expanding scope.

Out of scope for this plan are non-tmux workspace backends, pane orchestration,
automatic pruning of pi session files for deleted workspaces, inherited conversation
state between default and workspace sessions, changes to `tmux-titles`, and cleanup of
legacy `jj-workspace-state` handling in the footer unless that cleanup is trivial after
the rewrite lands.

The command surface after this work should be exactly four commands:

- `/ws-create <name>`
- `/ws-switch <name>`
- `/ws-list`
- `/ws-finish <name>`

`/ws-default` is removed because tmux window switching replaces its role.

## Milestones

### Milestone 1: Foundations and red/green scaffolding

Introduce the helper code and tests that make the rewrite safe before changing the
command behavior. By the end of this milestone, the codebase will have a clear way to
identify whether the current cwd belongs to the default workspace or a named
workspace, and a small tmux helper layer that can list/tag/create/select/kill windows
through mocked `pi.exec` calls.

This milestone comes first because it proves the two facts the design debate exposed as
most error-prone: default-workspace detection and tmux-window identity.

### Milestone 2: `/ws-create`, `/ws-switch`, and `/ws-list` on real tmux windows

Rewrite the creation, switch, and listing flows to use jj plus tmux, with no tool
overrides and no session state persistence. At the end of this milestone, users can
create a workspace, switch to it in a real tmux window, close it, and recreate it with
`/ws-switch`.

This milestone is independently valuable even before `/ws-finish` is rewritten because
it delivers the main user-visible benefit: real process cwd isolation and a working `@`
picker inside workspace windows.

### Milestone 3: safe `/ws-finish`

Add the safe finish path: detect and close any open workspace window, snapshot the
workspace filesystem with `jj status` in that workspace, rerun merge-head queries,
merge with rollback on conflict, forget the workspace, and delete the directory.

This milestone is sequenced after creation/switch because it depends on the tmux tag
and window lifecycle model established there.

### Milestone 4: remove obsolete virtual-CWD machinery and complete validation

Delete the fake-cwd code paths that are no longer needed, tighten the tests around the
new minimal extension, and perform manual tmux smoke validation in an actual attached
tmux session.

This final milestone leaves the tree in the intended steady state instead of shipping a
hybrid implementation with dead code and confusing handlers.

## Plan of Work

First, add or extract small pure helpers for workspace identification and tmux output
parsing. The preferred shape is a new `pi/jj/lib/workspace.ts` for workspace-name
parsing and validation plus a new `pi/jj/lib/tmux-workspaces.ts` for tmux-specific
operations. If that feels too large once implementation starts, keep the modules
private to the extension, but do not reintroduce a monolithic 900-line file.

Then rewrite `pi/jj/extensions/jj-workspace.ts` around four concerns only: jj command
execution, tmux readiness checks, window lifecycle commands, and finish/merge logic.
The file should no longer import or dynamically load built-in tool factories. It
should no longer call `pi.registerTool(...)`, `pi.appendEntry(...)`, or attach
`user_bash`, `before_agent_start`, or `session_start` handlers.

Use the footer-style workspace identity logic instead of path equality. The extension
needs an async helper roughly equivalent to: run `currentChangeId` and `workspaceList`
with `pi.exec`, then return the matched non-default workspace name or `null` for the
default workspace. That helper is the only valid gate for “must run from default
workspace.”

Use a tmux helper that always tags workspace windows with `@pi-ws=<name>`, forces
`remain-on-exit off`, and looks windows up by the tag rather than by `window_name`.
The human-facing name should still be `ws:<name>` for visibility in the tmux status
line.

When implementing `/ws-finish`, the order matters. Kill or verify closed any open
workspace window first, because a running pi process could still be writing files.
Only after the workspace window is gone should the extension run `jj status` with
`cwd: wsPath`. After that snapshot step, all merge queries must be recomputed from jj,
not reused from before the snapshot. This is the key safety property of the new design.

## Concrete Steps

1. Create `pi/jj/lib/workspace.ts`.
   In this file, define:

       export interface WorkspaceHead {
         name: string;
         changeId: string;
       }

       export const WORKSPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
       export const WORKSPACE_NAME_MAX_LENGTH = 128;
       export const JJ_WORKSPACE_COMMANDS = {
         currentChangeId: ["--color=never", "log", "-r", "@", "-T", "change_id", "--no-graph"],
         workspaceList: ["--color=never", "workspace", "list", "-T", 'name ++ ":" ++ self.target().change_id() ++ "\\n"'],
       } as const;

   Also define pure helpers:
   - `isValidWorkspaceName(name: string): boolean`
   - `parseWorkspaceHeads(output: string): WorkspaceHead[]`
   - `parseWorkspaceNameFromOutput(ourChangeId: string, workspaceListOutput: string): string | null`

2. Update `pi/jj/lib/footer.ts` only if the extraction is cheap.
   Replace the inline workspace-name parsing loop with the new pure helper from
   `pi/jj/lib/workspace.ts`, but preserve the existing `jj-workspace-state` entry
   fallback and preserve current test behavior exactly. If sharing this helper causes
   friction, stop and leave footer unchanged.

3. Add a new helper file `pi/jj/lib/tmux-workspaces.ts`.
   Define:

       export interface TmuxWorkspaceWindow {
         windowId: string;
         windowName: string;
         wsName: string;
         active: boolean;
       }

   Implement helpers that take `ExtensionAPI` or simple strings and remain testable:
   - `inTmuxEnv(env = process.env): boolean`
   - `parseTmuxVersion(output: string): number | null`
   - `parseWorkspaceWindows(output: string): TmuxWorkspaceWindow[]`
   - `listWorkspaceWindows(pi)`
   - `findWorkspaceWindow(pi, wsName)`
   - `selectWindow(pi, windowId)`
   - `killWindow(pi, windowId)`
   - `createWorkspaceWindow(pi, { wsName, cwd, continueRecent })`

   `createWorkspaceWindow` must:
   - run `tmux new-window -d -P -F '#{window_id}' -n 'ws:<name>' -c <cwd> <command>`
   - use bare `pi` when `continueRecent=false`
   - use `pi -c` when `continueRecent=true`
   - set `@pi-ws=<name>` on the created window
   - set `remain-on-exit off` on that window
   - select the window after tagging
   - on any failure after the window exists, kill the created window before returning an error

4. Add or update tests for the new pure helpers.
   Prefer a new file `pi/jj/lib/workspace.test.ts` for name parsing and a new file
   `pi/jj/lib/tmux-workspaces.test.ts` for tmux output parsing and version parsing.
   Add concrete cases:
   - workspace list output with ANSI-stripped names and change IDs
   - current change ID matching a named workspace returns that name
   - current change ID matching `default` returns `null`
   - invalid workspace names fail regex/length rules
   - tmux output with icon-mutated names still parses by `@pi-ws`
   - `parseTmuxVersion("tmux 3.6a") === 3.6`
   - `parseTmuxVersion("garbage") === null`

5. Run the new helper tests in red.
   From the repo root, run:

       node --experimental-strip-types --test pi/jj/lib/workspace.test.ts pi/jj/lib/tmux-workspaces.test.ts

   Expect at least one failing test before helper implementation is complete.

6. Implement the helper files until the helper tests pass.
   Commit when green with a message like:

       refactor(jj-workspace): add shared workspace and tmux helpers

7. Rewrite the top of `pi/jj/extensions/jj-workspace.ts`.
   Remove imports and code related to:
   - `AgentToolResult`, `AgentToolUpdateCallback`, `BashOperations`, `ExtensionContext`
   - `loadToolFactories()` and fallback tool factories
   - `WORKSPACE_STATE_ENTRY`, `CWD_LINE_RE`, `parseSavedWorkspace()`, `setActiveWorkspace()`, `persistWorkspaceState()`
   - any cached active cwd or active workspace state

   Keep only jj helpers still needed for list/create/finish, plus imports from the new
   workspace/tmux helper module(s).

8. Add a small async helper inside `pi/jj/extensions/jj-workspace.ts`:

       async function getCurrentNamedWorkspace(pi: ExtensionAPI, cwd: string): Promise<string | null>

   This helper must use the extracted `JJ_WORKSPACE_COMMANDS` and
   `parseWorkspaceNameFromOutput(...)`, not `jj root`, to determine whether the current
   cwd is in a named workspace.

9. Add a tmux readiness helper inside the extension.
   It should:
   - return a descriptive error if not in tmux,
   - run `tmux -V`, parse the version, and reject when parsing fails or the version is
     below the chosen minimum,
   - be used by every `/ws-*` handler before it performs tmux work.

   The user-facing error text should be concrete, for example:

       Workspace commands require tmux. Start pi inside tmux and retry.

   or:

       Workspace commands require tmux 3.2 or later. Found: tmux 2.9.

10. Rewrite command registration in `pi/jj/extensions/jj-workspace.ts`.
    Register exactly four commands:
    - `ws-create`
    - `ws-switch`
    - `ws-list`
    - `ws-finish`

    Delete `ws-default` registration entirely.

11. Rewrite `/ws-create`.
    The handler must:
    - validate name with `isValidWorkspaceName`
    - require tmux readiness
    - require `getCurrentNamedWorkspace(pi, process.cwd()) === null`
    - get the current default workspace root from `jj root`
    - compute `wsPath = resolve(defaultRoot, "..", `${basename(defaultRoot)}-ws-${name}`)`
    - fail if the workspace already exists in `jj workspace list`
    - fail if `existsSync(wsPath)` is true
    - run `jj workspace add --name <name> <wsPath>`
    - create a workspace window with `continueRecent=false`
    - on tmux failure after workspace add, run `jj workspace forget <name>` and `safeDeleteWorkspaceDir(wsPath, defaultRoot)`
    - notify success with the window name and path

12. Rewrite `/ws-switch`.
    The handler must:
    - validate name
    - require tmux readiness
    - verify the workspace exists via `jj workspace list`
    - look up a tagged window by `@pi-ws`
    - when found, run `tmux select-window -t <windowId>`
    - when missing, resolve `wsPath`, verify it exists on disk, and create a window with `continueRecent=true`
    - notify whether it switched to an existing window or recreated one

13. Rewrite `/ws-list`.
    The handler must:
    - require tmux readiness
    - refresh jj workspace heads
    - query `listWorkspaceWindows(pi)`
    - for each non-default workspace, resolve its path and annotate it with:
      - `window: open` when a tagged window exists
      - `window: —` when none exists
      - `active window` marker when the tmux window is active
    - render a stable, multiline notification

14. Rewrite command completions.
    `/ws-switch` and `/ws-finish` should still provide completion from the current jj
    workspace list, excluding `default`. No cached virtual-workspace state should be
    involved.

15. Rewrite the extension tests for the new command surface before finishing the
    implementation.
    In `test/extensions/jj-workspace.test.ts`, replace the current expectations with
    the new steady state:
    - only four commands are registered
    - no tools are registered
    - no `user_bash`, `before_agent_start`, or `session_start` handlers are attached
    - `/ws-create` errors outside tmux
    - `/ws-create` errors from a named workspace session even when `process.cwd()` equals `jj root` there
    - `/ws-create` issues tmux commands with bare `pi`
    - `/ws-switch` reuses tagged windows independent of mutated window names
    - `/ws-switch` recreates missing windows with `pi -c`
    - `/ws-list` shows `window: open` vs `window: —`

16. Run the targeted extension suite in red, then green.
    From the repo root, run:

       node --experimental-strip-types --test test/extensions/jj-workspace.test.ts

    Update the tests until they pass. When this milestone is green, commit with:

       feat(jj-workspace): launch and switch real tmux workspace sessions

17. Rewrite `/ws-finish` around the safe order of operations.
    The handler must:
    - validate name and reject `default`
    - require tmux readiness
    - require `getCurrentNamedWorkspace(pi, process.cwd()) === null`
    - verify the target workspace exists and resolve `wsPath`
    - find any tagged window for that workspace
    - if a window is open, show a confirm dialog explaining that the window will be closed before finishing
    - kill the window and verify it is gone before proceeding
    - run `jj status` with `cwd: wsPath` and capture the output
    - if `jj status` fails, abort finish and leave the workspace untouched
    - if `jj status` reports working-copy changes, show a second confirmation that those changes were snapshotted and will be merged
    - only after the snapshot step, call `getUniqueWorkspaceChanges(name)` and continue with conflict checks, default dirty check, empty-commit cleanup, merge, forget, and deletion

18. Keep the current merge engine, but recompute after snapshot.
    Reuse the existing logic in `pi/jj/extensions/jj-workspace.ts` for:
    - `getUniqueWorkspaceChanges(name)`
    - `getPreMergeOpId()`
    - `jj new default@ <heads...> -m 'finish workspace <name>'`
    - conflict detection on `@`
    - `jj op restore <preMergeOpId>` on merge conflict
    - `safeDeleteWorkspaceDir(wsPath, repoRoot)`

    The important change is that these queries must happen after the workspace-local
    snapshot step, not before it.

19. Update `/ws-finish` tests.
    Add explicit cases in `test/extensions/jj-workspace.test.ts` for:
    - rejecting finish from a named workspace session detected via current change ID
    - killing a tagged window before snapshot and aborting if the window still exists
    - running `jj status` with `cwd: wsPath`
    - surfacing `jj status` failure without forgetting/deleting the workspace
    - showing a second confirmation when `jj status` reported changes
    - merge success after snapshot
    - merge conflict rollback after snapshot
    - no `appendEntry` calls anywhere in the new flow

20. Run the workspace-related green bar.
    From the repo root, run:

       node --experimental-strip-types --test \
         pi/jj/lib/footer.test.ts \
         pi/jj/lib/utils.test.ts \
         pi/jj/lib/workspace.test.ts \
         pi/jj/lib/tmux-workspaces.test.ts \
         test/extensions/block-git-mutating.test.ts \
         test/extensions/jj-workspace.test.ts

    Expect all tests in that targeted set to pass. Record the exact count in the
    Progress section when implementation reaches this point.

21. Remove the last obsolete virtual-CWD code paths.
    In `pi/jj/extensions/jj-workspace.ts`, confirm that none of the following remain:
    - `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`
    - `registerToolOverride(...)`
    - `pi.registerTool(...)`
    - `pi.on("user_bash", ...)`
    - `pi.on("before_agent_start", ...)`
    - `pi.on("session_start", ...)`
    - `pi.appendEntry(...)`
    - `/ws-default`

22. Re-run the targeted green bar and commit the cleanup.
    Use a commit message like:

       refactor(jj-workspace): remove virtual cwd state and prompt rewriting

23. Perform manual tmux validation in a real attached tmux session.
    From a shell inside tmux, in this repository, run:

       pi

    Then perform these scenarios:

    Scenario A — create and real cwd:
    - run `/ws-create demo`
    - verify tmux switches to a window named `ws:demo` (icons from `tmux-titles` are acceptable)
    - in that window, run `!pwd` and expect the workspace path, not the repo root
    - use `@` and verify the picker roots at the workspace directory

    Scenario B — close and reopen:
    - quit pi in the workspace window
    - verify the workspace window disappears instead of remaining as a dead pane
    - go back to the default window and run `/ws-switch demo`
    - verify a new `ws:demo` window appears running `pi -c`

    Scenario C — finish snapshots dirty files:
    - in the workspace window, edit a tracked file without making an explicit jj commit
    - quit pi
    - from the default window, run `/ws-finish demo`
    - accept the warning about snapshotted working-copy changes
    - verify the change appears in the merge result and the workspace directory is deleted

    Scenario D — conflict rollback:
    - create conflicting edits in default and in a named workspace
    - run `/ws-finish <name>` from the default window
    - verify the extension reports a merge conflict and restores the repo to the pre-finish state
    - verify `jj workspace list` still contains the workspace and its directory still exists

24. Record the manual validation results in this ExecPlan’s Progress and Outcomes sections.

## Testing and Falsifiability

Every behavior change in this rewrite must be provable with targeted automated tests or
manual tmux validation.

Automated tests to add or modify:

- `pi/jj/lib/workspace.test.ts`
  - parse named workspace from change-id match
  - return `null` for default workspace match
  - validate name regex and max length

- `pi/jj/lib/tmux-workspaces.test.ts`
  - parse tmux version
  - parse tagged-window listings
  - verify name mutations do not affect tag-based matching

- `test/extensions/jj-workspace.test.ts`
  - registration no longer installs tools or event handlers
  - `/ws-create` uses bare `pi`
  - `/ws-switch` uses `pi -c` when recreating
  - `/ws-create` rolls back jj workspace creation on tmux setup failure
  - `/ws-list` merges jj and tmux state
  - `/ws-finish` kills a window before snapshot
  - `/ws-finish` runs `jj status` with `cwd: wsPath`
  - `/ws-finish` aborts on snapshot failure
  - `/ws-finish` keeps rollback behavior on merge conflict after snapshot

The primary targeted green command is:

    node --experimental-strip-types --test \
      pi/jj/lib/footer.test.ts \
      pi/jj/lib/utils.test.ts \
      pi/jj/lib/workspace.test.ts \
      pi/jj/lib/tmux-workspaces.test.ts \
      test/extensions/block-git-mutating.test.ts \
      test/extensions/jj-workspace.test.ts

The plan is false if any of the following occur after implementation:

- `test/extensions/jj-workspace.test.ts` still observes tool registration or virtual-CWD event handlers.
- `/ws-create` reopens an old session instead of launching a fresh one.
- `/ws-switch` cannot rediscover a workspace whose window title was mutated by `tmux-titles`.
- `/ws-finish` evaluates merge heads before running workspace-local `jj status`.
- a workspace window remains open after pi exits because `remain-on-exit off` was not enforced.
- `@` still points at the default repo instead of the workspace directory in a workspace window.

Do not use `npm test` as the sole acceptance gate for this work until the unrelated
`fetch` and `web-search` module-resolution failures are repaired. That existing red
baseline must be called out honestly in progress updates.

## Validation and Acceptance

This change is accepted when all of the following are true:

1. The targeted automated test command passes with zero failures.
2. `test/extensions/jj-workspace.test.ts` shows the new steady state: four commands,
   zero tool overrides, zero prompt/user-bash/session handlers.
3. In a real tmux session, `/ws-create demo` opens a new tmux window whose `!pwd`
   output is the workspace path.
4. In that workspace window, the `@` picker browses workspace files rather than the
   default repo files.
5. After quitting pi in the workspace window, the window disappears and `/ws-switch
demo` recreates it with `pi -c`.
6. `/ws-finish demo` from the default window snapshots dirty workspace files with
   `jj status`, merges them, forgets the workspace, and deletes the workspace
   directory.
7. A conflicting finish attempt restores the pre-finish operation state and leaves the
   workspace present for later repair.

An acceptable success transcript for the targeted tests looks like:

    ℹ tests <updated-count>
    ℹ pass <updated-count>
    ℹ fail 0

An acceptable manual success transcript fragment for the snapshot step looks like:

    /ws-finish demo
    Workspace 'demo' has an open tmux window. Close it and continue?
    ...
    Snapshot detected working-copy changes in /path/to/repo-ws-demo.
    These changes will be merged into default. Continue?

## Rollout, Recovery, and Idempotence

Roll out this rewrite as a single branch-based replacement of the current extension,
but keep the work split into the commit points above so each commit is green on the
targeted workspace-related test set.

If `/ws-create` fails after `jj workspace add` succeeds but before tmux setup is fully
complete, the handler must best-effort restore the pre-command state by forgetting the
workspace and deleting the just-created workspace directory. That makes `/ws-create`
retryable and prevents users from accumulating half-created workspaces.

If `/ws-finish` fails before `jj workspace forget`, the workspace must remain present.
If it fails after the merge but before directory deletion, the handler must tell the
user exactly what succeeded and what cleanup remains. Directory deletion is already
best-effort through `safeDeleteWorkspaceDir`; keep that behavior and preserve its
current safety guards.

Re-running `/ws-switch <name>` is idempotent: if the tagged window exists, it only
selects it; if it does not, it recreates it. Re-running `/ws-list` is read-only.
Re-running `/ws-finish <name>` on a workspace that was already forgotten must fail
cleanly with a “workspace does not exist” message.

## Artifacts and Notes

Evidence from the jj snapshot experiment that motivated the finish preflight:

    --- default status ---
    The working copy has no changes.
    ...
    --- test@ log before ws status ---
    ltplpxrxrlsv|true|
    --- workspace status ---
    Working copy changes:
    M a.txt
    ...
    --- test@ log after ws status ---
    ltplpxrxrlsv|false|

Evidence for the current targeted test baseline:

    node --experimental-strip-types --test \
      pi/jj/lib/footer.test.ts \
      pi/jj/lib/utils.test.ts \
      test/extensions/jj-workspace.test.ts \
      test/extensions/block-git-mutating.test.ts

    ℹ tests 54
    ℹ pass 54
    ℹ fail 0

Evidence for the current unrelated full-suite failures that must not be misattributed
to this rewrite:

    Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@mariozechner/pi-tui'
    imported from /home/bromanko.linux/Code/llm-agents/pi/web/extensions/fetch.ts

## Interfaces and Dependencies

`pi/jj/extensions/jj-workspace.ts` must remain the extension entrypoint and default
export. Prefer these helper-level interfaces by the end of the rewrite:

In `pi/jj/lib/workspace.ts`, define:

    export interface WorkspaceHead {
      name: string;
      changeId: string;
    }

    export const JJ_WORKSPACE_COMMANDS: {
      readonly currentChangeId: readonly string[];
      readonly workspaceList: readonly string[];
    };

    export function isValidWorkspaceName(name: string): boolean;
    export function parseWorkspaceHeads(output: string): WorkspaceHead[];
    export function parseWorkspaceNameFromOutput(
      ourChangeId: string,
      workspaceListOutput: string,
    ): string | null;

In `pi/jj/lib/tmux-workspaces.ts`, define:

    export interface TmuxWorkspaceWindow {
      windowId: string;
      windowName: string;
      wsName: string;
      active: boolean;
    }

    export function inTmuxEnv(env?: NodeJS.ProcessEnv): boolean;
    export function parseTmuxVersion(output: string): number | null;
    export function parseWorkspaceWindows(output: string): TmuxWorkspaceWindow[];

    export async function listWorkspaceWindows(
      pi: ExtensionAPI,
    ): Promise<TmuxWorkspaceWindow[]>;

    export async function findWorkspaceWindow(
      pi: ExtensionAPI,
      wsName: string,
    ): Promise<TmuxWorkspaceWindow | null>;

`pi/jj/extensions/jj-workspace.ts` should keep private helper functions for jj command
execution and merge cleanup similar to the current ones:

    async function runJj(args: string[], options?: { cwd?: string; timeout?: number }): Promise<JjResult>
    async function resolveWorkspacePath(name: string): Promise<string | null>
    async function getUniqueWorkspaceChanges(name: string): Promise<WorkspaceChange[]>
    async function getPreMergeOpId(): Promise<string>
    async function safeDeleteWorkspaceDir(wsPath: string, repoRoot: string): Promise<{ deleted: boolean; reason?: string }>
    async function getCurrentNamedWorkspace(cwd: string): Promise<string | null>

The tmux helper must use the real `pi.exec("tmux", args, ...)` path so existing mock
extension infrastructure in `test/helpers.ts` can keep validating argv, cwd, and
error-handling behavior deterministically.

Revision note (2026-03-22): Created this ExecPlan from the debated design in
`docs/designs/jj-workspace-tmux.md`. The plan resolves the main design-review gaps by
requiring a workspace-local snapshot step during `/ws-finish`, splitting fresh-vs-
continue pi launch semantics, avoiding `jj root` as a default-workspace detector, and
softening tmux liveness claims to a simpler tagged-window contract backed by
`remain-on-exit off`.
