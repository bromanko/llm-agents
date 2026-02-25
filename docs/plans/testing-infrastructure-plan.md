# Add Testing Infrastructure to llm-agents

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

As the extensions in this repository grow more complex — interactive code review with parsed findings, git command blocking with jj detection, CI guards that inspect session history, live-edit with file watching and TUI widgets — there is no systematic way to verify they work correctly or to catch regressions when making changes. Today, the only safeguard is `selfci check`, which validates that extensions *load* without errors but does not exercise any logic.

After this plan is complete, a developer can run `npm test` from the repository root and see a suite of tests that covers the pure library code (parsers, skill discovery, diff filtering, jj detection) and the behavioral logic of extensions (event handlers that block or transform tool calls). The CI pipeline will run these tests automatically before allowing pushes. New extensions and library modules will have a clear pattern to follow for adding their own tests, with documentation in the project README describing the conventions and the extension testing pattern.


## Progress

- [x] (2026-02-25 18:30Z) Milestone 1 complete: verified `node --experimental-strip-types` works; added `packages/code-review/lib/parser.test.ts` with 14 parser cases; confirmed existing `packages/code-review/lib/fix-flow.test.js` still passes.
- [x] (2026-02-25 18:30Z) Milestone 2 complete: added `packages/code-review/lib/skills.test.ts` with 10 tests covering skill discovery, filtering, and diff-extension filtering behavior.
- [x] (2026-02-25 18:30Z) Milestone 3 complete: added `packages/jj/lib/utils.test.ts` with `.jj` root detection and parent-walk coverage.
- [x] (2026-02-25 18:30Z) Milestone 4 complete: added shared `test/helpers.ts` mock Extension API and `packages/jj/extensions/block-git-mutating.test.ts` with 9 extension-behavior tests.
- [x] (2026-02-25 18:30Z) Milestone 5 complete: added `shared/extensions/ci-guard.test.ts` with 7 tests for CI-pass freshness and push-blocking behavior.
- [x] (2026-02-25 18:30Z) Milestone 6 complete: added root `npm test` script in `package.json`, added test step to `.config/selfci/ci.yaml`, and documented conventions in `README.md` under `## Testing`.
- [x] (2026-02-25 18:30Z) Validation complete: targeted test commands pass for all new files; full `npm test` and `selfci check` pass end-to-end.


## Surprises & Discoveries

- Observation: Node emits `[MODULE_TYPELESS_PACKAGE_JSON]` warnings for `.ts`/ESM-style test files in packages that do not define a package-local `"type": "module"`.
  Evidence: Every `node --experimental-strip-types --test ...` run printed warnings but still completed with all tests passing.

- Observation: Existing `ci-guard.ts` uses a broad push matcher (`/git\s+push/`) that also matches `jj git push`; explicit `jj git push` branch is still exercised and tested.
  Evidence: `shared/extensions/ci-guard.test.ts` confirms `jj git push` is blocked when CI freshness checks fail.

- Observation: Initial `selfci check` failed after adding extension tests because the extension-validation loop loaded every `*.ts` file in extension directories, including `*.test.ts` files that are not extensions.
  Evidence: SelfCI output included `Failed to load extension ...block-git-mutating.test.ts` and `...ci-guard.test.ts`; excluding `*.test.ts` in `.config/selfci/ci.yaml` resolved the failure and `selfci check` passed.


## Decision Log

- Decision: Use Node built-in test runner with `--experimental-strip-types` for all new `.ts` tests.
  Rationale: `node --experimental-strip-types -e "const x: number = 1; console.log(x)"` succeeded, so no external dependency (`tsx`, Jest, Vitest) was needed.
  Date: 2026-02-25

- Decision: Keep extension tests black-box at the event-handler boundary with a shared mock `ExtensionAPI` helper (`test/helpers.ts`) instead of mocking internals per test file.
  Rationale: This matches extension architecture (`pi.on("tool_call", ...)`) and makes future extension tests straightforward and consistent.
  Date: 2026-02-25

- Decision: Test filesystem-dependent behavior (`discoverReviewSkills`, `isJjRepo`, and jj repo checks in `block-git-mutating`) with temporary directories instead of module mocking.
  Rationale: Real filesystem setup is simple and validates actual behavior paths without introducing mocking libraries.
  Date: 2026-02-25

- Decision: Update `.config/selfci/ci.yaml` extension discovery to exclude `*.test.ts` from extension-loading checks.
  Rationale: Test files in extension directories are not extension factories and caused false CI failures in the extension-validation step.
  Date: 2026-02-25


## Outcomes & Retrospective

Completed all six milestones from this plan. The repository now has a reusable, dependency-free Node test infrastructure for both pure library code and extension behavior. New tests were added for parser logic, skill discovery/diff filtering, jj repo detection, git-command blocking, and CI push guarding. CI now executes `npm test` via `selfci`, and README documentation describes the conventions and extension-testing pattern.

Resulting coverage is behavior-focused and expandable: contributors can add `<module>.test.ts` files co-located with code and rely on auto-discovery through the root `npm test` script. The only notable gap discovered during implementation is non-blocking Node module-type warnings, which do not affect test correctness but could be cleaned up later by declaring module type metadata if desired.


## Context and Orientation

This repository (`llm-agents`) is a collection of pi extensions, skills, and plugins. Pi is a CLI coding agent (like Claude Code) that supports an extension API for customizing behavior. The relevant code is organized as follows:

**Repository root:** `/home/bromanko.linux/Code/llm-agents/`

**Key directories:**

- `shared/extensions/` — Extensions shared across all packages. Contains `ci-guard.ts` (blocks `git push`/`jj git push` when CI hasn't passed) and `live-edit.ts` (file viewer widget with live reload).
- `packages/jj/extensions/` — jj-specific extensions. Contains `block-git-mutating.ts` (intercepts bash commands to block mutating git commands in jj repos) and `jj-footer.ts` (custom TUI footer showing jj status).
- `packages/jj/lib/utils.ts` — Utility: `isJjRepo(dir)` walks parent directories looking for a `.jj` folder.
- `packages/code-review/extensions/index.ts` — The interactive `/review` command extension. Orchestrates skill discovery, LLM calls, finding parsing, and an interactive TUI for triaging findings.
- `packages/code-review/lib/parser.ts` — Parses structured findings (severity, title, file, issue, suggestion, effort) from free-form LLM markdown output. Pure function: `parseFindings(text, skill) → Finding[]`.
- `packages/code-review/lib/skills.ts` — Discovers review skills from filesystem directories, filters by language/type, and filters unified diffs by file extension. Pure functions: `discoverReviewSkills`, `filterSkills`, `filterDiffByExtensions`, `getLanguages`, `getTypesForLanguage`, `getLanguageExtensions`, `getSkillsDirs`.
- `packages/code-review/lib/fix-flow.js` — Helpers for queuing fix follow-up messages. Already has tests in `fix-flow.test.js`.
- `packages/code-review/lib/fix-flow.test.js` — Existing test file using `node:test` and `node:assert/strict`. This is the only test file in the project besides the selfci validation.

**Extension API shape (relevant for testing):** Extensions export a default function that receives `pi: ExtensionAPI`. They subscribe to events via `pi.on("event_name", handler)`. Event handlers receive `(event, ctx)` and can return objects to block, modify, or transform behavior. For example, a `tool_call` handler can return `{ block: true, reason: "..." }` to prevent a tool from executing. The key events used by our extensions are:

- `tool_call` — Fired before a tool runs. Handler receives `event.toolName` and `event.input`. Can return `{ block: true, reason }`.
- `tool_result` — Fired after a tool runs. Handler receives the tool result and can modify it.
- `before_agent_start` — Fired before the agent loop. Can modify `systemPrompt`.
- `session_start` — Fired when a session loads.
- `input` — Fired when user input is received.

**Existing CI (`selfci`):** Defined in `.config/selfci/ci.yaml`. Validates that Claude plugins validate and that all extensions load without errors (using `pi --list-models` with explicit extension flags). Does not run any tests.

**Dev environment:** Nix flake provides `selfci`. Node.js is available. The existing test file uses Node.js built-in test runner (`node:test`) and assertion library (`node:assert/strict`) — no external test framework.

**TypeScript execution:** Pi extensions are loaded via `jiti`, a JIT TypeScript loader. The existing test file is plain `.js`. For new tests of TypeScript modules, we will use `--experimental-strip-types` (available in Node 22+) or `tsx` via npx, depending on what's available. The simplest approach is to write tests as `.ts` files and run them with `node --experimental-strip-types --test`.


## Plan of Work

The work proceeds in six milestones. The first three cover pure library functions that can be tested with no mocking. The next two cover extension behavior, which requires lightweight stubs of the `ExtensionAPI` and `ExtensionContext` interfaces. The final milestone wires everything into CI.

### Strategy for testing pure functions

`parser.ts`, `skills.ts`, and `utils.ts` export pure functions. Tests import them directly, call them with known inputs, and assert on outputs. No pi infrastructure needed.

### Strategy for testing extensions

Extensions like `block-git-mutating.ts` and `ci-guard.ts` export a default function that receives an `ExtensionAPI` object and calls `pi.on(event, handler)` to register event handlers. To test them:

1. Create a minimal stub of `ExtensionAPI` that captures registered event handlers in a map.
2. Call the extension's default export with the stub.
3. Extract the registered handler for the event of interest (e.g., `"tool_call"`).
4. Call that handler directly with crafted event and context objects.
5. Assert on the return value (e.g., `{ block: true, reason: "..." }` or `undefined`).

This tests the actual extension logic without needing a running pi session. The stub only needs the methods the extension actually calls — `pi.on()`, `pi.exec()`, etc.

We will place the shared test helper (the `ExtensionAPI` stub factory) in a new file `test/helpers.ts` so all extension tests can reuse it.


## Concrete Steps

### Milestone 1: Test runner setup and `parser.ts` tests

This milestone establishes the test runner convention and writes thorough tests for the finding parser — the most logic-dense pure function in the repo.

**Step 1.1: Verify Node.js supports `--experimental-strip-types`.**

From the repo root, run:

    node --experimental-strip-types -e "const x: number = 1; console.log(x)"

Expected output: `1`. If this fails, fall back to running tests as `.js` files or using `npx tsx`. Record the result in the Decision Log.

**Step 1.2: Create the test file `packages/code-review/lib/parser.test.ts`.**

Create the file at `packages/code-review/lib/parser.test.ts`. Import `test` from `node:test`, `assert` from `node:assert/strict`, and `parseFindings` from `./parser.ts`.

Write tests for the following cases. Each `test()` call should be a single, focused assertion group:

1. **Strict heading format** — Input with `### [HIGH] Missing input validation` followed by `**Issue:** ...` and `**Suggestion:** ...` fields. Assert that `parseFindings(text, "test-skill")` returns one finding with `severity: "HIGH"`, the correct title, issue, and suggestion, and `skill: "test-skill"`.

2. **Multiple findings** — Input with three findings at different severities (HIGH, MEDIUM, LOW). Assert the array has length 3 and each finding has the correct severity.

3. **Flexible heading styles** — Input using `## HIGH: Title` (no brackets). Assert it parses correctly.

4. **Bullet-style heading** — Input using `- [medium] Title`. Assert `severity: "MEDIUM"`.

5. **Severity synonyms** — Inputs using `CRITICAL` (maps to HIGH), `WARNING` (maps to MEDIUM), `INFO` (maps to LOW). Assert correct mapping.

6. **File field extraction** — Input with `**File:** src/main.ts:42`. Assert `file: "src/main.ts:42"`.

7. **Category field** — Input with `**Category:** security`. Assert `category: "security"`.

8. **Effort field** — Input with `**Effort:** trivial`. Assert `effort: "trivial"`. Also test `small`, `medium`, `large`. Test an unrecognized effort value like `huge` and assert `effort: undefined`.

9. **Multi-line issue and suggestion** — Input where the issue spans multiple lines. Assert the full multi-line content is captured (lines joined).

10. **No headings but structured fields** — Input without any heading but containing `Issue:` and `Suggestion:` fields. Assert a single finding is parsed with `severity: "MEDIUM"` (default) and a title derived from the first meaningful line.

11. **Empty/garbage input** — Input that is just `"No issues found."` with no structured content. Assert `parseFindings(text, "skill")` returns an empty array.

12. **Missing issue and suggestion** — Input with a heading but no Issue/Suggestion/File fields. Assert it returns an empty array (the parser skips findings without substantive content).

13. **Field name synonyms** — Input using `**Problem:**` instead of `**Issue:**`, and `**Recommendation:**` instead of `**Suggestion:**`. Assert they parse correctly.

14. **Skill name propagation** — Assert that the `skill` field on every returned finding matches the second argument to `parseFindings`.

**Step 1.3: Run the parser tests.**

From the repo root:

    node --experimental-strip-types --test packages/code-review/lib/parser.test.ts

Expect all tests to pass. If any fail, fix the test (if the assertion was wrong based on reading the parser code) or document a parser bug in Surprises & Discoveries.

**Step 1.4: Verify the existing `fix-flow.test.js` still works.**

From the repo root:

    node --test packages/code-review/lib/fix-flow.test.js

Expect all 5 existing tests to pass.

**Step 1.5: Commit.**

Commit message: `test: add parser tests for code-review finding parser`

---

### Milestone 2: Tests for `skills.ts` utility functions

This milestone tests the skill discovery and diff filtering logic. Some functions (`discoverReviewSkills`, `getSkillsDirs`) read the filesystem, but the filtering and query functions are pure.

**Step 2.1: Create `packages/code-review/lib/skills.test.ts`.**

Import `test` from `node:test`, `assert` from `node:assert/strict`, and the functions from `./skills.ts`. Also import `fs` and `path` from Node for the filesystem-based tests.

Write tests for:

1. **`getLanguages`** — Pass an array of `ReviewSkill` objects with languages `"gleam"`, `"fsharp"`, `"gleam"` (duplicate). Assert the result is `["fsharp", "gleam"]` (sorted, deduplicated).

2. **`getTypesForLanguage`** — Pass skills with `{language: "gleam", type: "code"}`, `{language: "gleam", type: "security"}`, `{language: "fsharp", type: "code"}`. Call with `"gleam"`. Assert result is `["code", "security"]` (sorted). Call with `"typescript"`. Assert result is `[]`.

3. **`filterSkills` without type filter** — Pass skills for gleam and fsharp. Filter by `"gleam"` with no type filter. Assert only gleam skills returned.

4. **`filterSkills` with type filter** — Filter by `"gleam"` with types `["code", "test"]`. Assert only matching skills returned.

5. **`getLanguageExtensions`** — Assert `getLanguageExtensions("typescript")` returns `[".ts", ".tsx", ".mts", ".cts"]`. Assert `getLanguageExtensions("gleam")` returns `[".gleam"]`. Assert `getLanguageExtensions("unknown")` returns `undefined`.

6. **`filterDiffByExtensions` — basic filtering** — Construct a unified diff string with two sections: one for `src/main.gleam` and one for `README.md`. Call `filterDiffByExtensions(diff, [".gleam"])`. Assert the result contains the gleam section but not the README section.

7. **`filterDiffByExtensions` — no matches** — Pass a diff containing only `.md` files and filter for `[".ts"]`. Assert the result is `null`.

8. **`filterDiffByExtensions` — all match** — Pass a diff where all files are `.ts`. Assert the full diff is returned (minus trailing whitespace normalization).

9. **`discoverReviewSkills` with temp directory** — Create a temporary directory structure with a few skill directories (e.g., `gleam-code-review/SKILL.md`, `fsharp-security-review/SKILL.md`, `not-a-review/SKILL.md`). Call `discoverReviewSkills([tempDir])`. Assert it finds exactly the matching skills, with correct `name`, `language`, `type`, and `path` fields. Clean up the temp dir afterward.

10. **`discoverReviewSkills` with missing SKILL.md** — Create a directory named `elm-test-review/` but do not create `SKILL.md` inside it. Assert the skill is not discovered.

**Step 2.2: Run the skills tests.**

From the repo root:

    node --experimental-strip-types --test packages/code-review/lib/skills.test.ts

Expect all tests to pass.

**Step 2.3: Commit.**

Commit message: `test: add tests for code-review skill discovery and diff filtering`

---

### Milestone 3: Tests for `packages/jj/lib/utils.ts`

This milestone tests `isJjRepo`, which walks up parent directories looking for a `.jj` folder. The function is pure in the sense that it only checks `existsSync`, so we test it by creating temporary directory structures.

**Step 3.1: Create `packages/jj/lib/utils.test.ts`.**

Import `test` from `node:test`, `assert` from `node:assert/strict`, `fs` and `path` and `os` from Node builtins, and `isJjRepo` from `./utils.ts`.

Write tests:

1. **Directory with `.jj` present** — Create a temp dir, create `.jj` inside it. Assert `isJjRepo(tempDir)` returns `true`. Clean up.

2. **Nested directory with `.jj` in parent** — Create `tempDir/.jj/` and `tempDir/sub/deep/`. Assert `isJjRepo(tempDir/sub/deep)` returns `true` (it walks up and finds `.jj`). Clean up.

3. **Directory without `.jj`** — Create a temp dir with no `.jj`. Assert `isJjRepo(tempDir)` returns `false`. Clean up.

4. **Root directory** — Assert `isJjRepo("/tmp/nonexistent-" + randomSuffix)` returns `false` (it walks up to `/` and stops).

**Step 3.2: Run the jj utils tests.**

From the repo root:

    node --experimental-strip-types --test packages/jj/lib/utils.test.ts

Expect all tests to pass.

**Step 3.3: Commit.**

Commit message: `test: add tests for jj repo detection utility`

---

### Milestone 4: Tests for `block-git-mutating.ts` extension

This milestone introduces the extension testing pattern. We create a lightweight stub for `ExtensionAPI` and test the `block-git-mutating` extension's `tool_call` handler.

**Step 4.1: Create `test/helpers.ts`.**

Create the file at `test/helpers.ts` (in the repo root's `test/` directory). This module exports a factory function `createMockExtensionAPI()` that returns a fake `ExtensionAPI` object. The fake:

- Has an `on(event, handler)` method that stores handlers in a `Map<string, Function[]>`.
- Has an `exec(command, args, options?)` method that can be configured to return specific results. Default: returns `{ code: 0, stdout: "", stderr: "", killed: false }`.
- Has stub implementations for `registerCommand`, `registerTool`, `registerShortcut`, `registerFlag`, `sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`, `getSessionName`, `getActiveTools`, `getAllTools`, `setActiveTools`, `getCommands`, `getFlag`, `getThinkingLevel`, `setThinkingLevel`, `registerMessageRenderer`, `registerProvider`, `setModel`, `events` (with `on` and `emit` stubs). These are all no-ops or return sensible defaults so extensions don't crash when calling them during registration.
- Exposes a `getHandlers(eventName)` method that returns the array of registered handlers for an event name, so tests can extract and call them directly.
- Exposes `execMock` — an object where tests can set `execMock.fn = async (cmd, args) => result` to control what `pi.exec()` returns.

This stub does not need to be type-perfect against the full `ExtensionAPI` interface (which we cannot import directly in tests without a pi session). It just needs to satisfy the methods that the extensions under test actually call. TypeScript's structural typing handles this — we cast with `as any` where needed.

**Step 4.2: Create `packages/jj/extensions/block-git-mutating.test.ts`.**

Import `test` from `node:test`, `assert` from `node:assert/strict`, `createMockExtensionAPI` from `../../../test/helpers.ts`, and the default export from `./block-git-mutating.ts`.

The extension's `tool_call` handler does three things: (a) checks if `event.toolName === "bash"`, (b) checks if `isJjRepo(ctx.cwd)` returns true, (c) checks if the command matches a mutating git pattern (but not `jj git` subcommands). If all conditions are met, it returns `{ block: true, reason: "..." }`.

Since the extension imports `isJjRepo` from `../lib/utils.ts`, and that function checks the filesystem, we need to either mock it or create a temp dir with `.jj`. Creating a temp dir is simpler and tests the real code path.

Write tests:

1. **Blocks `git commit` in jj repo** — Create a temp dir with `.jj/`. Set up the mock API, call the extension's default export, extract the `tool_call` handler. Call it with `event = { toolName: "bash", toolCallId: "1", input: { command: "git commit -m 'test'" } }` and `ctx = { cwd: tempDir }` (plus other required fields as `undefined` or stubs). Assert the result is `{ block: true, reason: expect.stringContaining("jujutsu") }` (or just assert `result.block === true`). Clean up temp dir.

2. **Blocks `git push` in jj repo** — Same setup. Command: `"git push origin main"`. Assert blocked.

3. **Blocks `git checkout` in jj repo** — Command: `"git checkout -b feature"`. Assert blocked.

4. **Allows `jj git push`** — Command: `"jj git push"`. Assert result is `undefined` (not blocked).

5. **Allows `jj git fetch`** — Command: `"jj git fetch"`. Assert result is `undefined`.

6. **Allows non-git commands** — Command: `"ls -la"`. Assert result is `undefined`.

7. **Does not block in non-jj repo** — Create a temp dir without `.jj/`. Command: `"git commit -m 'test'"`. Assert result is `undefined` (not blocked because not a jj repo).

8. **Does not block non-bash tools** — Event with `toolName: "read"`. Assert result is `undefined`.

9. **Blocks compound commands** — Command: `"echo hello && git push"`. Assert blocked.

**Step 4.3: Run the block-git-mutating tests.**

From the repo root:

    node --experimental-strip-types --test packages/jj/extensions/block-git-mutating.test.ts

Expect all tests to pass.

**Step 4.4: Commit.**

Commit message: `test: add extension tests for jj git command blocking`

---

### Milestone 5: Tests for `ci-guard.ts` extension

This milestone tests the CI guard extension, which inspects the session history to decide whether to block push commands.

**Step 5.1: Create `shared/extensions/ci-guard.test.ts`.**

Import `test` from `node:test`, `assert` from `node:assert/strict`, `createMockExtensionAPI` from `../../test/helpers.ts`, and the default export from `./ci-guard.ts`.

The CI guard extension's `tool_call` handler:
1. Checks if the command is `git push` or `jj git push`.
2. Checks if `.config/selfci/ci.yaml` exists (via `pi.exec("test", ["-f", "..."])`).
3. Calls `hasCiPassedAfterMutations(ctx)`, which scans `ctx.sessionManager.getBranch()` for toolResult entries. It looks for the last bash result containing "✅" and "passed" (CI pass), and the last successful edit/write result (mutation). CI is valid if the last CI pass comes after the last mutation.

Write tests:

1. **Blocks push when no CI has run** — Set up mock API. Configure `execMock` so that `test -f .config/selfci/ci.yaml` returns `{ code: 0 }`. Create a mock `ctx` with `ctx.sessionManager.getBranch()` returning entries that include a write tool result but no CI pass. Command: `"git push"`. Assert result is `{ block: true, reason: expect.stringContaining("CI") }`.

2. **Allows push when CI passed after mutations** — Same setup, but `getBranch()` returns entries where a write result appears at index 3 and a bash result with "✅" and "passed" in the content appears at index 5. Assert result is `undefined` (allowed).

3. **Blocks push when mutations happened after CI** — `getBranch()` returns entries where CI passed at index 3 but an edit result appears at index 5. Assert blocked.

4. **Allows push when no selfci config exists** — Configure `execMock` so `test -f .config/selfci/ci.yaml` returns `{ code: 1 }`. Assert result is `undefined` regardless of session history.

5. **Ignores non-push commands** — Command: `"echo hello"`. Assert result is `undefined`.

6. **Blocks `jj git push` too** — Command: `"jj git push"`. With no CI pass in history. Assert blocked.

7. **Ignores failed mutations** — `getBranch()` returns an edit result with `isError: true`. This should not count as a mutation. If CI passed before it, push should be allowed.

For the mock `ctx.sessionManager.getBranch()`, construct arrays of entry objects that mimic the real session entry format:

    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "✅ All checks passed" }]
      }
    }

and similarly for edit/write tool results.

**Step 5.2: Run the ci-guard tests.**

From the repo root:

    node --experimental-strip-types --test shared/extensions/ci-guard.test.ts

Expect all tests to pass.

**Step 5.3: Commit.**

Commit message: `test: add extension tests for CI push guard`

---

### Milestone 6: `npm test` script, CI integration, and documentation

This milestone adds a convenient `npm test` script, wires test execution into the selfci pipeline, and documents the testing conventions so future contributors know how to add tests.

**Step 6.1: Add a `test` script to `package.json`.**

In the root `package.json`, add a `"scripts"` section (or extend it if one exists) with a `"test"` script that uses glob-based auto-discovery to find all test files:

```json
{
  "scripts": {
    "test": "node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'"
  }
}
```

This means any file matching `*.test.ts` or `*.test.js` anywhere in the repository will be picked up automatically. New test files are discovered without editing a manifest.

Verify it works from the repo root:

    npm test

Expect all tests to pass.

**Step 6.2: Edit `.config/selfci/ci.yaml`.**

In the `command:` block, after the existing extension validation step, add a new step that runs the tests via `npm test`. Insert the following after the line `echo "All extensions loaded successfully"`:

    selfci step start "Run tests"
    npm test
    echo "All tests passed"

**Step 6.3: Add testing documentation to the README.**

Add a new `## Testing` section to `README.md` (after the `## Development` section). The section should cover:

- How to run the full test suite: `npm test`.
- How to run a single test file: `node --experimental-strip-types --test path/to/file.test.ts`.
- The naming convention: test files are co-located with their module as `<module>.test.ts`.
- The extension testing pattern: import `createMockExtensionAPI` from `test/helpers.ts`, call the extension's default export with the mock, extract handlers via `getHandlers("event_name")`, and invoke them with crafted event/context objects. Include a short code example showing this pattern.
- Note that no external dependencies are needed — tests use Node.js built-in `node:test` and `node:assert/strict`, and TypeScript is handled by `--experimental-strip-types`.

**Step 6.4: Run selfci locally to verify.**

From the repo root:

    selfci check

Expect all steps to pass, including the new "Run tests" step.

**Step 6.5: Commit.**

Commit message: `ci: add npm test script, selfci test step, and testing docs`


## Validation and Acceptance

After all milestones are complete, run the full test suite from the repo root:

    npm test

Expected output: All tests pass. The exact count will depend on how many individual test cases are written, but expect roughly 30-40 passing tests across 6 files with 0 failures.

Then run `selfci check` from the repo root and expect all steps — including the new test step — to pass.

To verify the pattern works for future development, a developer should be able to:

1. Read the Testing section in `README.md` and understand the conventions.
2. Open any `.test.ts` file and see the pattern in action.
3. Create a new test file following the same pattern (import `node:test`, import module under test, write `test()` calls). For extension tests, import `createMockExtensionAPI` from `test/helpers.ts`.
4. Run the new test with `node --experimental-strip-types --test path/to/new.test.ts`, or run the full suite with `npm test`. The new file is discovered automatically by the glob pattern — no manifest to update.


## Idempotence and Recovery

All test steps are idempotent. Tests create temporary directories and clean them up. Tests do not modify any repository files. Running the test suite multiple times produces the same results.

If a step fails partway, simply re-run it. There is no destructive state to roll back.


## Artifacts and Notes

**Test file naming convention:** `<module>.test.ts` co-located with the module being tested. For example, `parser.ts` → `parser.test.ts` in the same directory. Exception: the shared test helpers live in `test/helpers.ts` at the repo root.

**No external dependencies required.** The test runner (`node:test`) and assertion library (`node:assert/strict`) are Node.js built-ins. TypeScript stripping (`--experimental-strip-types`) is also built-in to Node 22+. No `npm install` is needed for testing.

**Pattern for testing extensions:** The `test/helpers.ts` stub factory is the key reusable piece. When adding tests for new extensions in the future, import `createMockExtensionAPI`, call the extension's default export with the mock, extract handlers via `getHandlers("event_name")`, and invoke them with crafted event/context objects. This pattern is documented in the Testing section of `README.md` (added in Milestone 6) so future contributors can follow it without reading this plan.


## Interfaces and Dependencies

In `test/helpers.ts`, define:

```typescript
export interface MockExtensionAPI {
  on(event: string, handler: Function): void;
  exec(command: string, args?: string[], options?: any): Promise<ExecResult>;
  registerCommand(name: string, options: any): void;
  registerTool(definition: any): void;
  registerShortcut(shortcut: string, options: any): void;
  sendMessage(message: any, options?: any): void;
  sendUserMessage(content: any, options?: any): void;
  appendEntry(customType: string, data?: any): void;
  getHandlers(eventName: string): Function[];
  execMock: { fn: ((cmd: string, args?: string[]) => Promise<ExecResult>) | null };
  // ... other stubs as needed
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

export function createMockExtensionAPI(): MockExtensionAPI;
```

No new runtime dependencies are introduced. All testing uses Node.js built-ins.
