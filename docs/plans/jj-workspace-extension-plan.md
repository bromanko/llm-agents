# Replace Workspace Skill with CWD-Redirecting Extension

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries, Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

After this change, a user can manage jj workspaces entirely inside one Pi session. They can run `/ws-create my-feature`, immediately have all `read`/`write`/`edit`/`bash` tool calls resolve against that workspace directory, and later run `/ws-finish` to merge workspace work into the default workspace and clean up. They do not need to manually prefix commands with `cd ... && ...`, and the LLM sees the correct current working directory in its system prompt.

The old `shared/skills/workspace/SKILL.md` attempted this with prompt instructions alone. That approach cannot actually redirect built-in tool CWD. This plan replaces it with a jj extension that overrides tools and manages workspace lifecycle with explicit commands.


## Progress

- [x] (2026-02-26 20:10Z) Milestone 1.1: Created `packages/jj/extensions/jj-workspace.ts` with `isJjRepo()` early return.
- [x] (2026-02-26 20:10Z) Milestone 1.2: Added `activeCwd`/`activeWorkspace` state and `getActiveCwd()` helper.
- [x] (2026-02-26 20:10Z) Milestone 1.3: Overrode `read`, `write`, `edit`, and `bash` tools with dynamic CWD delegation.
- [x] (2026-02-26 20:10Z) Milestone 1.4: Implemented `user_bash` interception so `!` and `!!` resolve to workspace CWD.
- [x] (2026-02-26 20:10Z) Milestone 2.1: Added `runJj()`, templated workspace-list parsing, and completion helpers.
- [x] (2026-02-26 20:10Z) Milestone 2.2: Implemented `/ws-create` with collision checks and persistence.
- [x] (2026-02-26 20:10Z) Milestone 2.3: Implemented `/ws-list`, `/ws-switch`, `/ws-default`, and command completions.
- [x] (2026-02-26 20:10Z) Milestone 3.1: Implemented `/ws-finish` preflight checks and deterministic merge path.
- [x] (2026-02-26 20:10Z) Milestone 3.2: Added rollback via `jj op restore` on conflict plus guarded directory deletion.
- [x] (2026-02-26 20:10Z) Milestone 4.1: Added `before_agent_start` system prompt CWD rewrite + workspace rules.
- [x] (2026-02-26 20:10Z) Milestone 5.1: Added `session_start` restoration from `jj-workspace-state` entries.
- [x] (2026-02-26 20:10Z) Milestone 6.1: Added automated coverage in `test/extensions/jj-workspace.test.ts`.
- [x] (2026-02-26 20:10Z) Milestone 6.2: Ran `node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'` with zero failures.
- [x] (2026-02-26 20:10Z) Milestone 7.1: Removed `shared/skills/workspace/SKILL.md` and `shared/skills/workspace/`.
- [x] (2026-02-26 20:10Z) Milestone 7.2: Removed obsolete `plugins/jj/workspace-agent-plan.md`.
- [x] (2026-02-26 20:17Z) Milestone 7.3: Executed scenarios A-E end-to-end with a headless extension harness and real jj commands (`/tmp/jj-workspace-manual-validation.mjs`).


## Surprises & Discoveries

- Observation: Test execution in this workspace does not resolve `@mariozechner/pi-coding-agent` as a normal npm dependency.
  Evidence: Initial test run failed with `ERR_MODULE_NOT_FOUND` when importing runtime tool factories.

- Observation: Running manual scenarios in this non-interactive harness required command-level simulation instead of direct `/ws-*` entry through the Pi TUI.
  Evidence: Executed `/tmp/jj-workspace-manual-validation.mjs`, which loaded the extension, invoked command handlers, and exercised real jj operations for scenarios A-E.

- Observation: Dynamic runtime import with fallback keeps production tool factories available while still allowing repository-local tests without installed npm dependency wiring.
  Evidence: After switching to async `loadToolFactories()`, `node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'` passed (14/14), and `npm test` passed (267/267).


## Decision Log

- Decision: Use an extension with tool overrides instead of a skill with LLM instructions.
  Rationale: Skills cannot change built-in tool path resolution. Tool override factories (`createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`) can.
  Date: 2026-02-26

- Decision: Override only built-in `read`, `write`, `edit`, `bash`, and intercept `user_bash`.
  Rationale: These are the only operations that must be CWD-aware for this workflow. URL-based tools (e.g. `fetch`) do not use CWD.
  Date: 2026-02-26

- Decision: Use user-driven slash commands (`/ws-create`, `/ws-finish`, `/ws-list`, `/ws-switch`, `/ws-default`) instead of LLM-callable tools.
  Rationale: Workspace lifecycle is an explicit user action and should not be autonomous agent behavior.
  Date: 2026-02-26

- Decision: Keep extension in `packages/jj/extensions/jj-workspace.ts`.
  Rationale: The feature is jj-specific and belongs with `block-git-mutating.ts`, `jj-commit.ts`, and `jj-footer.ts`.
  Date: 2026-02-26

- Decision: No workspace registry file.
  Rationale: `jj workspace root --name <name>` (jj 0.38+) provides authoritative paths.
  Date: 2026-02-26

- Decision: Parse `jj workspace list` only through a template.
  Rationale: Human-readable default output is not stable enough for machine parsing. Use `jj workspace list -T 'name ++ "|" ++ self.target().change_id() ++ "\\n"'`.
  Date: 2026-02-26

- Decision: Deterministic `/ws-finish` merge uses `jj new default@ <name>@ -m "finish workspace <name>"`.
  Rationale: This creates one explicit merge point between default and workspace heads, avoids brittle `squash` behavior against immutable roots, and works for one or many workspace commits.
  Date: 2026-02-26

- Decision: On merge conflict in `/ws-finish`, immediately roll back the merge operation with `jj op restore <preMergeOpId>`.
  Rationale: Leaves repository in a clean pre-finish state while preserving the workspace for later retry.
  Date: 2026-02-26

- Decision: The Pi `@` file picker will remain tied to process CWD.
  Rationale: No extension API currently rewires picker root. Tool execution remains correct even with this limitation.
  Date: 2026-02-26

- Decision: Load tool factories via async runtime `import()` with an internal fallback for tests.
  Rationale: Repository tests run outside the Pi runtime and may not resolve `@mariozechner/pi-coding-agent` as an npm dependency, while production Pi sessions should still use the real exported tool factories.
  Date: 2026-02-26


## Outcomes & Retrospective

Implemented a full `jj-workspace` extension in `packages/jj/extensions/jj-workspace.ts` with CWD-aware tool overrides, slash command lifecycle management, conflict-safe finish behavior, prompt rewriting, and session-state restoration.

Added end-to-end unit coverage in `test/extensions/jj-workspace.test.ts` for registration behavior, command lifecycle, merge success/conflict handling, persistence, and prompt/user-bash integration. Targeted and full test runs both pass.

Removed the deprecated workspace skill and the obsolete workspace planning artifact:

- `shared/skills/workspace/SKILL.md`
- `plugins/jj/workspace-agent-plan.md`

Manual scenario validation is complete: scenarios A-E were exercised in a headless extension harness (`/tmp/jj-workspace-manual-validation.mjs`) using real jj commands and command-handler invocation, including conflict rollback behavior.


## Context and Orientation

The repository root is `/home/bromanko.linux/Code/llm-agents`.

Relevant directories:

- `packages/jj/extensions/` — jj extensions currently loaded by Pi.
- `packages/jj/lib/utils.ts` — exports `isJjRepo(cwd: string): boolean`.
- `shared/skills/workspace/SKILL.md` — legacy workspace skill to remove.
- `test/helpers.ts` — shared mock ExtensionAPI utilities.
- `test/extensions/` — extension tests.

`package.json` includes:

    {
      "scripts": {
        "test": "node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'"
      },
      "pi": {
        "extensions": [
          "./packages/jj/extensions",
          "./packages/tmux-titles/extensions",
          "./packages/code-review/extensions",
          "./shared/extensions"
        ]
      }
    }

Because `packages/jj/extensions` is in `pi.extensions`, every `.ts` file there is auto-loaded as an extension.

Pi APIs used by this feature:

- Tool override factories: `createReadTool`, `createWriteTool`, `createEditTool`, `createBashTool`.
- Commands: `pi.registerCommand(name, { description, handler, getArgumentCompletions? })`.
- Events: `before_agent_start`, `user_bash`, `session_start`.
- Persistence: `pi.appendEntry(customType, data)` and `ctx.sessionManager.getEntries()`.
- Command completion shape: `getArgumentCompletions(prefix) => AutocompleteItem[] | null` where each item has `{ value, label }`.

Jujutsu commands used:

- `jj workspace add --name <name> <path>`
- `jj workspace list -T 'name ++ "|" ++ self.target().change_id() ++ "\\n"'`
- `jj workspace root --name <name>`
- `jj workspace forget <name>`
- `jj root`
- `jj new default@ <name>@ -m "finish workspace <name>"`
- `jj log -r '@' -T 'conflict ++ "|" ++ change_id.short() ++ "\\n"' --no-graph`
- `jj op log -n 1 --no-graph -T 'id.short()'`
- `jj op restore <op-id>`

### Embedded implementation skeletons (self-contained reference)

Tool override pattern:

    const defaultCwd = process.cwd();
    const defaultRead = createReadTool(defaultCwd);

    pi.registerTool({
      ...defaultRead,
      async execute(id, params, signal, onUpdate) {
        const tool = createReadTool(getActiveCwd());
        return tool.execute(id, params, signal, onUpdate);
      },
    });

`user_bash` CWD redirection pattern:

    pi.on("user_bash", (_event) => {
      if (!activeWorkspace) return;
      const bashTool = createBashTool(getActiveCwd());
      return { operations: bashTool.operations as BashOperations };
    });


## Plan of Work

Implementation is split into seven milestones. Each milestone has explicit validation and a commit point with passing tests.

### Milestone 1: Core CWD state + tool overrides

Create `packages/jj/extensions/jj-workspace.ts` and wire CWD-aware tool overrides.

1. Add extension skeleton with early guard:
   - At top of default export, `if (!isJjRepo(process.cwd())) return;`.
2. Add module-level state:
   - `let activeCwd: string = defaultCwd;`
   - `let activeWorkspace: { name: string; path: string } | null = null;`
   - `function getActiveCwd(): string`.
3. Register overrides for `read`, `write`, `edit`, `bash` by delegating to fresh tool instances created with `getActiveCwd()`.
4. Add `user_bash` handler returning custom operations when `activeWorkspace !== null`.

Verification:

- Start Pi in a jj repo.
- Startup shows override notices for `read`, `write`, `edit`, `bash`.
- `!pwd` prints repo root path while no workspace is active.
- Behavior is identical to built-ins when `activeWorkspace === null`.

Expected observable output examples:

    !pwd
    /home/bromanko.linux/Code/llm-agents

Commit:

- `feat(jj-workspace): core CWD management with tool overrides`

Before committing, run:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

Expected: no `not ok` lines.

### Milestone 2: Workspace creation/switch/list/default commands

Implement command surface except finish.

Create helper functions in `packages/jj/extensions/jj-workspace.ts` first:

- `async function runJj(pi: ExtensionAPI, args: string[], cwd: string = defaultCwd): Promise<{ stdout: string; stderr: string; code: number }>`
- `async function listWorkspaceHeads(pi: ExtensionAPI): Promise<Array<{ name: string; changeId: string }>>`
- `async function resolveWorkspacePath(pi: ExtensionAPI, name: string): Promise<string | null>`
- `function workspaceCompletionItems(names: string[], prefix: string): Array<{ value: string; label: string }> | null`

Important: `listWorkspaceHeads()` must parse only templated output:

    jj workspace list -T 'name ++ "|" ++ self.target().change_id() ++ "\n"'

Then implement commands:

1. `/ws-create <name>`
   - Validate non-empty name.
   - Build path as `<repo-root>/../<repo-name>-ws-<name>`.
   - Fail if workspace name exists or directory exists.
   - Run `jj workspace add --name <name> <path>`.
   - Set active state + append `pi.appendEntry("jj-workspace-state", { name, path })`.
   - Notify success.
2. `/ws-list`
   - Show non-default workspaces with name, path, change ID, active marker.
3. `/ws-switch <name>`
   - Validate existence via templated list + root resolution.
   - Set active state and persist.
4. `/ws-default`
   - Reset to default state and persist `null`.
5. Add `getArgumentCompletions` for `/ws-switch` and `/ws-finish` returning `{ value, label }[] | null`.

Verification examples:

    /ws-create test-m2
    # notification: Switched to workspace test-m2 at /.../llm-agents-ws-test-m2

    !pwd
    /home/bromanko.linux/Code/llm-agents-ws-test-m2

    /ws-default
    # notification: Switched back to default workspace. Workspace test-m2 is preserved.

Commit:

- `feat(jj-workspace): workspace commands create/list/switch/default`

Before committing, run:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

Expected: all tests pass, no `not ok`.

### Milestone 3: Deterministic `/ws-finish`

Implement safe workspace finish with explicit rollback behavior.

Add helpers:

- `async function resolveFinishTarget(args: string, activeWorkspace: { name: string; path: string } | null): Promise<string | null>`
- `async function getPreMergeOpId(pi: ExtensionAPI): Promise<string>`
- `async function getUniqueWorkspaceChanges(pi: ExtensionAPI, name: string): Promise<Array<{ changeId: string; description: string; empty: boolean; conflict: boolean }>>`
- `async function safeDeleteWorkspaceDir(pi: ExtensionAPI, wsPath: string, repoRoot: string): Promise<{ deleted: boolean; reason?: string }>`

Use this exact algorithm:

1. Resolve workspace name from args or `activeWorkspace`.
2. Reject `default`.
3. Verify workspace exists and get `wsPath`.
4. Confirm with user.
5. Query workspace-unique mutable commits with:

       jj log -r 'ancestors(<name>@) & mutable() & ~ancestors(default@)' --no-graph -T 'change_id ++ "|" ++ description.first_line() ++ "|" ++ empty ++ "|" ++ conflict ++ "\n"'

6. If any listed commit has `conflict=true`, abort and notify user.
7. If all listed commits are empty, abandon them and re-query.
8. If no remaining commits after cleanup:
   - No merge command; proceed directly to forget/delete cleanup.
9. If commits remain:
   - Capture pre-merge operation id:

         jj op log -n 1 --no-graph -T 'id.short()'

   - Run merge from default cwd:

         jj new default@ <name>@ -m 'finish workspace <name>'

   - Detect conflict on current `@`:

         jj log -r '@' --no-graph -T 'conflict ++ "|" ++ change_id.short() ++ "\n"'

   - If `conflict=true`, run rollback:

         jj op restore <preMergeOpId>

     then notify error and return without forgetting/deleting workspace.
10. On success, set `activeCwd = defaultCwd`, `activeWorkspace = null`, persist `null`.
11. Run `jj workspace forget <name>`.
12. Delete workspace directory only if:
    - basename contains `-ws-`
    - path is not `/`
    - path is not equal to repo root
    - path is not an ancestor of repo root
13. Notify summary with:

       jj log -r 'ancestors(@, 4)' --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"'

Expected success output example:

    /ws-finish test-m3
    # notification: Finished workspace test-m3, merged into default, forgot workspace, deleted /.../llm-agents-ws-test-m3

Expected conflict output example:

    /ws-finish conflict-ws
    # notification (error): Merge conflict detected while finishing conflict-ws. Repository restored to pre-finish state. Resolve in workspace and retry.

Commit:

- `feat(jj-workspace): deterministic ws-finish with rollback`

Before committing, run:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

Expected: all tests pass.

### Milestone 4: System prompt integration

Add `before_agent_start` handler in `packages/jj/extensions/jj-workspace.ts`.

Behavior:

1. If no active workspace, return nothing.
2. Replace `Current working directory: <defaultCwd>` with `Current working directory: <activeCwd>`.
3. Append:

       You are working in jj workspace "<name>".
       - Use `jj` for version control. NEVER use `git` commands directly.
       - The full history is available via `jj log`.
       - Keep commits incremental and descriptive.

Verification:

- In active workspace, ask: “What is your current working directory?”
- Expected answer includes workspace path.
- After `/ws-default`, same question returns default repo path.

Commit:

- `feat(jj-workspace): system prompt workspace awareness`

Run tests before commit:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

### Milestone 5: Session persistence and resume

Add `session_start` handler.

1. Read last custom entry with `customType === "jj-workspace-state"`.
2. If entry is `null`, keep default state.
3. If entry has `{ name, path }`, verify:
   - workspace name exists in templated `jj workspace list`
   - `test -d <path>` succeeds
4. If both pass: restore active state.
5. If either fails: notify warning and keep default state.

Expected warning example:

    Workspace 'persist-ws' no longer exists, returning to default workspace.

Commit:

- `feat(jj-workspace): restore workspace state on session start`

Run tests before commit:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

### Milestone 6: Automated tests (required)

Create `test/extensions/jj-workspace.test.ts` and implement tests in red/green order.

Test groups and minimum cases:

1. Registration/no-op:
   - No commands/tools registered outside jj repo.
   - Commands/tools registered in jj repo.
2. `/ws-create`:
   - Missing name -> usage error.
   - Name collision -> error.
   - Path collision -> error.
   - Success -> state persisted and success notification.
3. `/ws-switch` and `/ws-default`:
   - Missing name -> usage error.
   - Missing workspace -> error.
   - Switch success -> active state updated and persisted.
   - Default success -> state reset and persisted null.
4. `/ws-list`:
   - Renders non-default workspaces with active marker.
5. `/ws-finish`:
   - Missing target -> error.
   - Reject `default`.
   - Workspace missing -> error.
   - No unique commits -> forget+delete only.
   - Merge success -> runs `jj new default@ <name>@ ...`, forgets, deletes, clears state.
   - Merge conflict -> runs `jj op restore <preMergeOpId>`, does not forget/delete, preserves workspace.
6. Persistence:
   - Restores valid saved workspace on `session_start`.
   - Ignores stale saved workspace and warns.
7. Prompt integration:
   - `before_agent_start` rewrites CWD line only when workspace active.

Red/green workflow requirement:

- For each group: add failing test first, run test file, observe `not ok`, then implement minimal code to pass.

Commands:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

Expected before implementation:

    ...
    not ok <new test name>

Expected after implementation:

    ...
    # pass <N>
    # fail 0

Then run full suite:

    npm test

Expected: all repository tests pass; no failing tests.

Commit:

- `test(jj-workspace): add coverage for workspace command lifecycle`

### Milestone 7: Remove legacy skill and final manual validation

1. Delete `shared/skills/workspace/SKILL.md`.
2. Delete empty directory `shared/skills/workspace/`.
3. Delete obsolete `plugins/jj/workspace-agent-plan.md`.
4. Manual validation scenarios:

Scenario A: Full lifecycle

1. `/ws-create feature-test`
2. Create `hello.txt` via LLM.
3. `!pwd` shows workspace path.
4. `/ws-finish`
5. `!pwd` now shows default repo path.
6. `!ls hello.txt` in default should succeed (merged content now visible in default working copy).

Scenario B: Switch without finish

1. `/ws-create temp-ws`
2. Create file.
3. `/ws-default`
4. `/ws-list` shows `temp-ws`.
5. `/ws-switch temp-ws` returns to workspace path.
6. `/ws-finish temp-ws` succeeds.

Scenario C: Resume

1. `/ws-create persist-ws`
2. Exit Pi.
3. `pi -c`
4. `!pwd` shows persisted workspace path.

Scenario D: Conflict rollback

1. Create conflicting edits in default and workspace.
2. `/ws-finish conflict-ws`
3. Confirm error notification indicates rollback.
4. `jj workspace list` still includes `conflict-ws`.

Scenario E: Non-jj directory

1. Start Pi outside any jj repo.
2. No `/ws-*` commands and no tool override warnings.

Final commit:

- `chore: remove deprecated workspace skill and obsolete workspace plan`

Run before final commit:

    npm test

Expected: all tests pass.


## Concrete Steps

All commands below are run from `/home/bromanko.linux/Code/llm-agents` unless noted.

Create extension file:

    touch packages/jj/extensions/jj-workspace.ts

Create test file:

    touch test/extensions/jj-workspace.test.ts

Run targeted tests repeatedly during development:

    node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'

Run complete test suite before each commit:

    npm test

Start interactive Pi for manual checks:

    pi

Useful jj diagnostics while debugging finish behavior:

    jj workspace list -T 'name ++ "|" ++ self.target().change_id() ++ "\n"'
    jj log -r 'ancestors(@, 6)' --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ " conflict=" ++ conflict ++ "\n"'
    jj op log -n 5 --no-graph -T 'id.short() ++ " " ++ time.start() ++ " " ++ description ++ "\n"'


## Validation and Acceptance

The implementation is accepted only if all conditions below are true.

1. `/ws-create <name>` creates workspace and switches active tool CWD to workspace path.
2. `/ws-switch <name>` switches to existing workspace without creating a new one.
3. `/ws-default` restores default CWD without deleting workspace.
4. `/ws-list` shows name, path, change ID, and active marker for non-default workspaces.
5. `/ws-finish [name]`:
   - merges via `jj new default@ <name>@ -m 'finish workspace <name>'` when workspace has changes,
   - rolls back with `jj op restore <preMergeOpId>` on conflict,
   - forgets workspace and deletes directory on success,
   - restores default active state and persists `null`.
6. `read`/`write`/`edit`/`bash` and user `!` commands all execute relative to active workspace when set.
7. `before_agent_start` updates system prompt CWD to active workspace path.
8. Workspace state persists across session restarts and restores only if still valid.
9. Feature is no-op outside jj repositories.
10. `shared/skills/workspace/` and `plugins/jj/workspace-agent-plan.md` are removed.
11. `node --experimental-strip-types --test 'test/extensions/jj-workspace.test.ts'` passes with zero failures.
12. `npm test` passes with zero failures.


## Idempotence and Recovery

Idempotence:

- Re-running `/ws-create` with existing name/path fails cleanly with a notification.
- Re-running `/ws-default` when already default is a no-op notification.
- Re-running `/ws-finish` on missing workspace fails cleanly.

Recovery:

- If `/ws-finish` reports conflict, the command must restore operation state with `jj op restore <preMergeOpId>` and leave workspace untouched.
- If directory deletion fails after successful merge+forget, user can clean manually:

      rm -rf <workspace-path>

- If a stale session entry references missing workspace, extension warns and stays in default mode.


## Interfaces and Dependencies

`packages/jj/extensions/jj-workspace.ts` must export only default extension function and keep helpers private unless tests require extraction.

Required imports:

- `@mariozechner/pi-coding-agent`:
  - `ExtensionAPI`
  - `BashOperations`
  - `createReadTool`
  - `createWriteTool`
  - `createEditTool`
  - `createBashTool`
- `../lib/utils.ts`: `isJjRepo`
- `node:path`: `basename`, `join`, `resolve`

Required local state and helpers:

    let activeCwd: string;
    let activeWorkspace: { name: string; path: string } | null;

    function getActiveCwd(): string;
    async function runJj(pi: ExtensionAPI, args: string[], cwd?: string): Promise<{ stdout: string; stderr: string; code: number }>;
    async function listWorkspaceHeads(pi: ExtensionAPI): Promise<Array<{ name: string; changeId: string }>>;
    async function getUniqueWorkspaceChanges(pi: ExtensionAPI, name: string): Promise<Array<{ changeId: string; description: string; empty: boolean; conflict: boolean }>>;
    async function safeDeleteWorkspaceDir(pi: ExtensionAPI, wsPath: string, repoRoot: string): Promise<{ deleted: boolean; reason?: string }>;

Command completion contract:

    getArgumentCompletions(prefix: string): Array<{ value: string; label: string }> | null


## Artifacts and Notes

Reference implementation pattern (already embedded above) mirrors SSH tool overrides and `user_bash` interception.

Existing `packages/jj/extensions/jj-footer.ts` already renders workspace indicator (`⎇`) by inspecting jj state. This extension must not duplicate footer rendering.

Manual scenario transcript source:

- `/tmp/jj-workspace-manual-validation.mjs`

Key output excerpt from that run:

    Manual validation scenarios completed successfully.

    Scenario A
      - /ws-create feature-test -> workspace at /tmp/.../demo-repo-ws-feature-test
      - !pwd in workspace -> /tmp/.../demo-repo-ws-feature-test
      - /ws-finish feature-test -> returned to default cwd /tmp/.../demo-repo
      - !ls hello.txt in default -> hello.txt

    Scenario D
      - /ws-finish conflict-ws emitted rollback message
      - workspace directory preserved -> /tmp/.../demo-repo-ws-conflict-ws
      - /ws-list still includes conflict-ws -> yes

Removed obsolete assets:

- `shared/skills/workspace/SKILL.md`
- `plugins/jj/workspace-agent-plan.md`
