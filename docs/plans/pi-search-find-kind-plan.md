# Add directory-aware `kind` filtering to `pi/search` `find`

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

After this change, the repo-local `find` tool under `pi/search` will answer three
kinds of discovery questions without falling back to bash:

- file-only discovery (`kind: "file"`), which is the current default behavior
- directory-only discovery (`kind: "directory"`), which today still requires bash
- mixed path discovery (`kind: "any"`), where both files and directories are useful

A caller will be able to ask `find` for top-level directories under `pi/search`, or
for any directories named `extensions`, or for a shallow mixed listing, and receive
paginated structured results with the same error handling and path validation that the
current `find` tool already provides. The user will no longer need bash `ls`, bash
`find -type d`, or `ls -R` just to inspect directory structure.


## Problem Framing and Constraints

The current `find` implementation in `pi/search/extensions/find.ts` is file-only. It
builds `rg --files` arguments, it short-circuits direct file scopes, and it always
reports the mode string `find files`. The `rg --files` command fundamentally cannot
return directories.

That leaves an important class of common exploration tasks outside the structured tool
surface: "show me directories under here", "find directories named `components`", and
"show me a shallow folder layout". These are exactly the cases that still push the
agent toward bash `find`, bash `ls`, and recursive listing patterns.

This plan must preserve the current strengths of the `find` tool. The existing
file-only behavior, pagination envelope, path validation, direct-file shortcut, and
`maxDepth` semantics must continue to work unchanged when `kind` is omitted or set to
`"file"`.

This plan must also preserve current pattern semantics across kinds. Today,
slash-containing patterns in file mode are matched against the full normalized path,
while slash-free patterns are matched against the basename. Directory and mixed modes
must keep that behavior rather than silently switching to basename-only matching.

This plan must stay proportionate. It should not attempt a full tree viewer, rich file
metadata, or AST-aware navigation. It should solve directory-aware discovery with a
clear, testable API that replaces the most common shell fallbacks.


## Strategy Overview

The key insight is that `fd` (a fast filesystem finder) is already available in the
Nix environment alongside `rg`, and it supports exactly the traversal controls needed:
`--type d` for directories, `--type f` for files, `--max-depth`, `--hidden`,
`--no-ignore`, and `--exclude`. It also respects `.gitignore` by default, the same as
`rg`. This means directory-aware discovery can reuse the existing shell-executor
pattern without introducing a custom filesystem walker or new npm dependencies.

The plan extends the `find` schema with a new optional field:

    kind?: "file" | "directory" | "any"

The default stays `"file"` for backward compatibility.

The current `rg --files` path stays in place for `kind: "file"`. For
`kind: "directory"` and `kind: "any"`, a new `fd` executor (modeled after the
existing `rg.ts` executor) enumerates candidate paths of the requested type. Crucially,
`fd` is used only for traversal, type filtering, ignore handling, and depth limiting.
It is not used as the source of truth for pattern semantics, because `fd` matches
basenames by default and its `--full-path` glob behavior does not mirror the current
`rg --files --glob` semantics for slash-containing patterns.

Instead, `find.ts` will apply the pattern in TypeScript after `fd` returns candidates.
A shared helper will preserve the current contract:

- if the normalized pattern contains `/`, match against the full normalized path
- otherwise, match against the basename
- plain strings are still wrapped as `*substring*`

That helper will be used for both direct-file-scope checks and `fd` results, so
`kind: "directory"` and `kind: "any"` behave like current file mode rather than like
raw `fd` globbing.

Because `fd` requires an explicit positional pattern before a search path, the
`fd`-backed path will use the match-all regex `.` and rely on TypeScript for the final
pattern filter. This keeps the shell command simple and makes path-pattern behavior
fully testable in one place.

If `fd` is not installed, the tool returns a clear error message telling the caller that
directory discovery requires `fd`. File-only mode continues to work via `rg`
regardless.

This approach is proportionate because it reuses the existing executor pattern, the
existing pagination and result-envelope infrastructure, and an external tool that is
already present in the environment, while keeping path-pattern semantics under our own
control.


## Alternatives Considered

The first alternative is to let `fd` perform pattern matching directly via `--glob`
and, for slash-containing patterns, `--full-path`. That was rejected because it does
not preserve the current `find` semantics. `fd` matches basenames by default, and its
full-path glob rules diverge from `rg --files --glob` for slash-containing patterns.
Following that path would create a silent behavior split between `kind: "file"` and the
new kinds.

The second alternative is a custom filesystem walker in Node.js. That was rejected
because it would require writing traversal logic, reimplementing ignore handling, and
risking subtle semantic drift from the existing `rg`-backed path.

The third alternative is to not add this capability at all and let the model fall back
to bash when it needs directory listings. That is the current state of affairs and is
acceptable as a fallback, but it means the agent must use unstructured bash output for
a very common exploration task. Adding `fd`-backed directory discovery is a small,
additive change that meaningfully reduces bash fallbacks.

The fourth alternative is to derive directories from `rg --files` output by extracting
parent paths. That was rejected because it would miss empty directories and any
directory whose contents are entirely ignored, producing observably wrong results in
exactly the cases where a user is inspecting structure.


## Risks and Countermeasures

The first risk is semantic drift between `kind: "file"` and the new kinds for
slash-containing patterns. The countermeasure is to keep pattern matching in
TypeScript for `fd`-backed modes, using the same normalized-path-versus-basename rule
that current file mode already follows. This is verified in extension tests with
slash-containing patterns.

The second risk is that `fd` might not be available in all environments where
`pi/search` is used. The countermeasure is graceful degradation: if `fd` is not found
(ENOENT from spawn), the tool returns a descriptive error message. The
`kind: "file"` default continues to work via `rg` regardless.

The third risk is semantic drift between `fd` and `rg` for shared concepts like
`maxDepth`, `hidden`, and `respectIgnore`. The countermeasure is that both tools use the
same depth offset (+1 from our `maxDepth` convention), both default to respecting ignore
files, and both default to hiding hidden entries. The mapping is verified in tests.

The fourth risk is that `fd` appends trailing slashes to directory paths
(`pi/search/lib/`), which would break path comparisons. The countermeasure is to strip
trailing slashes in the `fd` executor's line-splitting logic, verified by tests.

The fifth risk is exposing `kind` in the public schema before the runtime behavior
exists. The countermeasure is sequencing: schema, prompt guidance, tests, and runtime
wiring land in the same green commit. No commit point leaves the tool advertising a
capability it does not implement.

The sixth risk is result-order differences. `fd` returns sorted output by default,
while `rg --files` does not. This means `kind: "any"` and `kind: "directory"` results
will be sorted, while `kind: "file"` results remain in `rg`'s traversal order. This is
acceptable because pagination is stable within each mode, and sorted output is arguably
better for directory listings. The difference is documented and tested at the mode
level rather than hidden.


## Progress

- [x] (2026-04-05 00:00Z) Verified `fd` 10.4.2 is available via Nix alongside `rg` 15.1.0.
- [x] (2026-04-05 00:05Z) Verified `fd` supports `--type d`, `--type f`, `--max-depth`, `--hidden`, `--no-ignore`, and `--exclude`.
- [x] (2026-04-05 00:08Z) Verified `fd --max-depth 1` returns direct children (same +1 offset as rg), `--max-depth 0` returns nothing.
- [x] (2026-04-05 00:10Z) Verified `fd` appends trailing slashes to directory paths, returns relative paths for relative scopes, absolute for absolute scopes.
- [x] (2026-04-05 00:12Z) Verified `fd` exits 0 for both matches and no-matches, exits 1 for errors. Different from `rg` which exits 1 for no-matches.
- [x] (2026-04-05 00:15Z) Verified `fd` respects `.gitignore` by default and supports `--exclude` for skip names.
- [x] (2026-04-05 00:16Z) Verified `fd` treats the first positional argument as a required pattern; scoped traversal needs a match-all pattern such as `.` before the search path.
- [x] (2026-04-05 00:17Z) Verified direct `fd --glob` / `fd --full-path` matching does not preserve current `rg --files --glob` semantics for slash-containing patterns.
- [x] (2026-04-05 00:18Z) Verified `npm test` passes with 708 tests in the pre-change tree.
- [x] (2026-04-06 00:10Z) Added `kind` to `FindToolParams`, plus `FdResult` and `FdExecutor` types.
- [x] (2026-04-06 00:18Z) Expanded `pi/search/test/find-extension.test.ts` with schema, prompt-guidance, slash-pattern parity, mixed-mode union, file-scope, and fd-flag-forwarding coverage.
- [x] (2026-04-06 00:24Z) Created `pi/search/lib/fd.ts` and `pi/search/lib/fd.test.ts` with spawn, exit-code, trailing-slash, and ENOENT coverage.
- [x] (2026-04-06 00:31Z) Wired `pi/search/extensions/find.ts` to route `kind: "directory"` and `kind: "any"` through `fd` while preserving file-mode behavior through `rg` and shared TypeScript pattern matching.
- [ ] (2026-04-06 00:34Z) Land schema, prompt guidance, and runtime behavior together in one green commit (completed: code and tests are green in the working tree; remaining: create the commit if desired).
- [x] (2026-04-06 00:40Z) Ran focused search tests, smoke checks, and the full repository test suite; `npm test` now passes with 728 tests.


## Surprises & Discoveries

- Observation: `fd` returns sorted output by default, while `rg --files` does not.
  Evidence: `fd --glob '*.ts' --type f pi/search/lib` returns alphabetically sorted
  paths; `rg --files --glob '*.ts' pi/search/lib` returns traversal-ordered paths.

- Observation: `fd` exit code is 0 for both matches and no-matches, unlike `rg` which
  exits 1 for no-matches. The `fd` executor must handle this difference.
  Evidence: `fd --glob 'nonexistent_zzz' --type d pi/search; echo "exit: $?"` prints
  `exit: 0` with empty stdout.

- Observation: `fd` cannot take only a scoped search path; it interprets the first
  positional argument as a pattern. A match-all pattern such as `.` is required before
  the scope path.
  Evidence: `fd --type d pi/search` errors, while `fd . pi/search --type d` works.

- Observation: direct `fd` pattern matching is not a safe drop-in replacement for
  current file-mode semantics when patterns contain `/`.
  Evidence: `rg --files --glob 'pi/search/lib/*.ts' pi/search` returns matches, while
  `fd --glob --full-path 'pi/search/lib/*.ts' pi/search` returns none.

- Observation: unlike the earlier plan, no npm dependency is needed. `fd` handles
  traversal and ignore-file semantics natively, while path-pattern semantics stay in
  TypeScript.

- Observation: `fd` mixed-mode traversal (`--type f --type d`) does not include the
  scoped directory itself, so `kind: "any"` only needed shared post-filtering and did
  not require extra root-suppression logic.
  Evidence: the smoke check for `path: "pi/search", kind: "directory", maxDepth: 0`
  returned only `pi/search/extensions`, `pi/search/lib`, and `pi/search/test`.


## Decision Log

- Decision: replace the custom filesystem walker approach with `fd`-based execution.
  Rationale: `fd` is already available in the Nix environment, supports all needed
  traversal controls, respects `.gitignore` natively, and eliminates the need for the
  `ignore` npm dependency and a custom walker module.
  Date: 2026-04-05

- Decision: add `kind: "file" | "directory" | "any"` with `"file"` as the default.
  Rationale: keeping `"file"` as the default preserves current callers. Adding `"any"`
  alongside `"directory"` is a small incremental extension.
  Date: 2026-04-05

- Decision: keep `rg` as the backend for `kind: "file"` and use `fd` only for
  non-file kinds.
  Rationale: the current `rg --files` path works, is well-tested, and callers depend on
  its behavior. Splitting the backends is smaller and safer than replacing the file path.
  Date: 2026-04-05

- Decision: use `fd` only for traversal/type/depth filtering and perform final pattern
  matching in TypeScript for `kind: "directory"` and `kind: "any"`.
  Rationale: this preserves current slash-containing pattern semantics across kinds and
  avoids relying on `fd --glob` / `--full-path` behavior that diverges from
  `rg --files --glob`.
  Date: 2026-04-05

- Decision: if `fd` is not installed, return an error for directory/any modes rather
  than silently degrading or hiding the `kind` parameter from the schema.
  Rationale: the schema should describe the tool's capabilities truthfully. Environments
  without `fd` get a clear error message; environments with `fd` benefit immediately.
  File-only mode is unaffected.
  Date: 2026-04-05

- Decision: land the public `kind` schema and the runtime implementation in the same
  green commit.
  Rationale: this avoids an intermediate state where the tool advertises a capability it
  does not yet implement.
  Date: 2026-04-05

- Decision: reuse one shared `entryMatchesPattern()` helper for direct-file shortcuts,
  `kind: "directory"`, and `kind: "any"` instead of keeping separate matching logic.
  Rationale: sharing one matcher is the smallest way to guarantee parity for
  slash-containing patterns and basename-only matches across all kinds.
  Date: 2026-04-06


## Outcomes & Retrospective

The implementation is complete in the working tree. `pi/search/extensions/find.ts`
now accepts `kind: "file" | "directory" | "any"`, keeps `"file"` as the default,
and routes directory-aware modes through the new `pi/search/lib/fd.ts` executor while
preserving file-mode behavior through `rg`.

The main semantic goal held: slash-containing patterns still match against full
normalized paths, while slash-free patterns still match against basenames. That
behavior now applies consistently to direct-file scopes, directory-only listings, and
mixed path listings because all three paths share the same TypeScript matcher.

Validation passed at both the focused and full-suite levels. The focused search run
`node --experimental-strip-types --test pi/search/lib/fd.test.ts pi/search/lib/rg.test.ts pi/search/lib/path-suggest.test.ts pi/search/lib/pagination.test.ts pi/search/test/find-extension.test.ts pi/search/test/grep-extension.test.ts`
passed with 145 tests. The full repository run `npm test` passed with 728 tests. The
smoke checks also matched the expected behavior: `kind: "directory"` with
`path: "pi/search", maxDepth: 0` returned only `pi/search/extensions`,
`pi/search/lib`, and `pi/search/test`, and the mixed-mode slash-containing smoke check
returned only matching `pi/search/lib/*.ts` entries.

The remaining non-code step is optional version-control hygiene: no commit was created
in this session, so the plan's commit checkpoint remains open even though the code and
validation work are finished.


## Context and Orientation

The repo-local search package lives under `pi/search`. The files relevant to this plan
are:

- `pi/search/extensions/find.ts` — The find tool extension. Registers the `find` tool,
  defines the JSON schema, builds `rg` arguments, handles direct-file scopes, applies
  `maxDepth` filtering, paginates results, and formats the result envelope. This is the
  main file to modify.

- `pi/search/lib/types.ts` — Shared type definitions. `FindToolParams` defines the
  parameter shape. `RgResult` and `RgExecutor` define the ripgrep executor interface.
  `SearchToolDetails` defines the structured details object returned alongside text.

- `pi/search/lib/rg.ts` — The ripgrep executor. Spawns `rg` as a child process,
  collects stdout/stderr, and returns a structured `RgResult`. File-only `find`
  requests still use this backend.

- `pi/search/lib/fd.ts` — The directory-aware executor. Spawns `fd`, strips trailing
  slashes from directory output, handles ENOENT, and returns structured path lists for
  `kind: "directory"` and `kind: "any"`.

- `pi/search/lib/rg.test.ts` and `pi/search/lib/fd.test.ts` — Mock-spawn tests for the
  `rg` and `fd` executors.

- `pi/search/lib/constants.ts` — Shared constants including `DEFAULT_SKIP_NAMES` (an
  array of directory names like `.git`, `node_modules`, `dist` that should be excluded
  from traversal), `DEFAULT_FIND_LIMIT` (50), and `buildSkipGlobArgs` (formats skip
  names as `--glob !name` arguments for `rg`).

- `pi/search/lib/pagination.ts` — Pagination helpers (`paginate`, `normalizeOffset`,
  `normalizeLimit`) used by both find and grep.

- `pi/search/lib/result-envelope.ts` — Formats the standard text output shape:
  `Mode: <mode> | Scope: <scope>` followed by items and a summary line.

- `pi/search/lib/path-suggest.ts` — Path validation and suggestion logic.
  `validatePath` resolves a requested path to an absolute or relative path and
  determines whether it is a file or directory. Used by `find.ts` before any search.

- `pi/search/test/find-extension.test.ts` — Extension-level tests for the find tool.
  Tests schema, prompt guidance, path errors, direct-file scopes, `kind` behavior,
  slash-containing pattern parity, `maxDepth`, pagination, hidden/ignore flags, rg
  argument forwarding, and fd argument forwarding.

- `pi/search/lib/execution-context.ts` — Provides `getCwd(ctx)` to extract the working
  directory from the tool execution context.

The repository root `package.json` includes `./pi/search/extensions` in its
`pi.extensions` array, so changes to files under `pi/search` immediately affect normal
sessions.

The test runner is invoked from the repository root as:

    npm test

which expands to:

    node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'

Individual test files can be run with:

    node --experimental-strip-types --test <path-to-test-file>


## Preconditions and Verified Facts

The following facts were verified in the current tree on 2026-04-06:

- `fd` 10.4.2 is installed at `/nix/store/.../fd-10.4.2/bin/fd` and available on PATH.
- `rg` 15.1.0 is installed and available on PATH.
- `npm test` from the repository root now runs 728 tests, all passing.
- `pi/search/lib/types.ts` defines `FindToolParams` with fields: `pattern`, `path?`,
  `kind?`, `maxDepth?`, `limit?`, `offset?`, `hidden?`, `respectIgnore?`.
- `pi/search/lib/types.ts` defines both `RgResult` / `RgExecutor` and
  `FdResult` / `FdExecutor`.
- `pi/search/extensions/find.ts` exports `createFindToolDefinition(deps)` where `deps`
  includes optional `rgExecutor`, `fdExecutor`, and `pathValidator` for testing. It
  exports `normalizeMaxDepth` and `depthWithinScope` as named exports.
- `pi/search/extensions/find.ts` now uses a shared `entryMatchesPattern(pattern, itemPath)`
  helper so slash-containing patterns match against the full normalized path and
  slash-free patterns match against the basename across all kinds.
- `pi/search/extensions/find.ts` defines `buildFindArgs` for `rg` file-mode execution
  and `buildFdArgs` for `fd` directory/mixed-mode execution. Both use the same `+1`
  `maxDepth` offset because our `maxDepth` counts depth within scope where 0 = direct
  children.
- `pi/search/lib/constants.ts` exports `DEFAULT_SKIP_NAMES` (13 entries including
  `.git`, `.jj`, `node_modules`, `dist`, etc.), `buildSkipGlobArgs()` which formats
  them as `["--glob", "!.git", "--glob", "!node_modules", ...]`, and
  `hasGlobMetacharacters`.
- `pi/search/lib/rg.ts` exports `createRgExecutor(spawnProcess)` and `executeRg`.
  The executor spawns `rg`, collects stdout/stderr, and handles exit codes 0 (success),
  1 (no match, not an error), and >1 (error).
- `fd` exits 0 for both matches and no-matches, and exits 1 for errors. This differs
  from `rg` (which exits 1 for no-matches and >1 for errors).
- `fd` appends trailing slashes to directory paths in output.
- `fd --max-depth 1` returns direct children of the scope. Our `maxDepth: 0` means
  direct children, so the same +1 offset applies: `fd --max-depth (normalizedDepth + 1)`.
- `fd` requires a positional pattern before a scope path, so the match-all regex `.`
  is the simplest way to enumerate candidates within an explicit scope.
- Direct `fd --glob` / `fd --full-path` matching does not preserve current
  slash-containing pattern semantics from `rg --files --glob`; final pattern filtering
  must stay in TypeScript for the new kinds.

If any of these facts have drifted before implementation starts, update this plan first.


## Scope Boundaries

In scope:

- adding `kind` to `FindToolParams` and the `find` tool schema
- adding `FdResult` and `FdExecutor` types
- adding a `fd.ts` executor module parallel to `rg.ts`
- updating `find.ts` to route `kind: "directory"` and `kind: "any"` through `fd`
- preserving current path-pattern semantics across all kinds by post-filtering `fd`
  candidates in TypeScript
- updating prompt guidance and result mode strings
- adding extension-level and executor-level tests for the new behavior

Out of scope:

- changing `grep`
- changing `read`
- changing the existing file-only `rg` backend
- adding a tree-rendering UI
- adding file metadata (size, mtime, permissions)
- adding LSP or AST awareness
- changing the `SearchToolDetails` shape beyond mode strings

Deferred explicitly:

- richer sorting controls
- directory metadata output
- a dedicated `list` or `tree` tool
- replacing the file-only backend with `fd`


## Milestones

The first milestone freezes behavior in tests without publishing a misleading partial
contract. At the end of it, failing tests describe the new `kind` schema, prompt
guidance, slash-containing pattern parity, and mixed-mode behavior, but there is no
commit yet that exposes `kind` without runtime support.

The second milestone builds the `fd` executor in isolation. At the end of it,
`pi/search/lib/fd.ts` and `pi/search/lib/fd.test.ts` exist, with tests proving that the
executor correctly spawns `fd`, strips trailing slashes, handles exit codes, and reports
errors. This milestone comes before extension wiring so the riskiest new code is
proven early.

The third milestone wires the `fd` executor into `find.ts` and lands the public
contract at the same time. At the end of it, `kind: "directory"` and `kind: "any"`
work through the public extension surface while `kind: "file"` still uses the existing
`rg` path. This is where result mode strings, pagination, slash-pattern parity, and
end-to-end behavior are verified.


## Plan of Work

In `pi/search/lib/types.ts`, add `kind?: "file" | "directory" | "any"` to
`FindToolParams`. Add `FdResult` and `FdExecutor` types parallel to `RgResult` and
`RgExecutor`. `FdResult` has the shape `{ lines: string[]; error: string | null }`.
It drops the `matched` field because `fd` exits 0 for both matches and no-matches, so
there is no separate no-match exit-code case.

Create `pi/search/lib/fd.ts` following the same structure as `pi/search/lib/rg.ts`.
The `createFdExecutor(spawnProcess)` function spawns `fd` as a child process, collects
stdout/stderr, splits stdout into lines, strips trailing slashes, and returns a
structured `FdResult`. Exit code 0 means success (lines may be empty for no matches).
Exit code 1 or higher means error — return the stderr content or a generic message.
ENOENT means `fd` is not installed — return a message saying directory discovery
requires `fd` with a link to `https://github.com/sharkdp/fd`.

Create `pi/search/lib/fd.test.ts` following the same mock-spawn pattern as
`pi/search/lib/rg.test.ts`.

In `pi/search/extensions/find.ts`, extract the current file-scope matcher into a helper
that can be reused for both direct-file shortcuts and `fd` results. The helper keeps
existing semantics: if the normalized pattern contains `/`, match against the full
normalized path; otherwise match against the basename. Plain strings still become
`*substring*` through `normalizePattern`.

In `pi/search/extensions/find.ts`, add a `buildFdArgs` function parallel to
`buildFindArgs`. It builds `fd` arguments from the parameters and validated scope:
match-all pattern `.`, `--type d` or `--type f --type d` depending on kind,
`--max-depth (normalizedDepth + 1)` if maxDepth is set, `--hidden` if requested,
`--no-ignore` if respectIgnore is false, `--exclude <name>` for each entry in
`DEFAULT_SKIP_NAMES`, and the scope path as the final argument.

In `pi/search/extensions/find.ts`, update `FindToolDeps` to include an optional
`fdExecutor`. Update `createFindToolDefinition` to accept and use it. In the `execute`
function, branch by `kind` after path validation:

- `kind` is `"file"` or omitted: use the existing `rg` path, no behavior changes.
- `kind` is `"directory"` or `"any"` with a file scope: return zero results for
  `"directory"`, or apply the shared file-target matcher for `"any"`.
- `kind` is `"directory"` or `"any"` with a directory scope: call `fd` via
  `buildFdArgs(...)`, handle errors, apply the shared matcher to `fd` results, apply
  `applyMaxDepth` as a safety net, paginate, and return the result envelope with mode
  `find directories` or `find paths`.

The public schema, prompt guidance, and runtime wiring all land together in the same
commit so callers never see a half-implemented contract.


## Concrete Steps

All commands run from the repository root unless stated otherwise.

1. Read `pi/search/lib/types.ts`, `pi/search/extensions/find.ts`,
   `pi/search/lib/rg.ts`, `pi/search/lib/rg.test.ts`, and
   `pi/search/test/find-extension.test.ts` to confirm they match this plan's
   Preconditions section.

2. In `pi/search/test/find-extension.test.ts`, add failing tests for the public
   contract and behavior. Add schema and prompt-guidance assertions that check:

   - the schema exposes `kind`
   - `kind.enum` is `["file", "directory", "any"]`
   - `promptSnippet` mentions files and directories
   - `promptGuidelines` mention using `kind: "directory"` instead of bash directory
     discovery

   Add behavior tests that check:

   - `kind: "directory"` returns only directories with mode `find directories`
   - `kind: "any"` returns mixed files/directories with mode `find paths`
   - `kind: "file"` and omitted `kind` still use the `rg` executor, not `fd`
   - `kind: "directory"` with a file scope returns zero results, not an error
   - `kind: "any"` with a file scope returns the file if the shared matcher matches
   - slash-containing patterns still work in `kind: "directory"` and `kind: "any"`
     by filtering `fd` results in TypeScript rather than relying on raw `fd` matching
   - `kind: "any"` preserves file results that would be considered matches under the
     shared matcher, so it behaves as a true mixed-mode union rather than as a
     directory-biased variant
   - `kind: "directory"` forwards `--max-depth`, `--hidden`, `--no-ignore`, and
     `--exclude` arguments to `fd`
   - `fd` execution errors surface structured error details
   - pagination still works correctly for directory mode

3. Run:

       node --experimental-strip-types --test pi/search/test/find-extension.test.ts

   Expect the new tests to fail because `kind` does not exist yet and `find.ts` does
   not have the `fd` path.

4. Create `pi/search/lib/fd.test.ts` with tests that follow the mock-spawn pattern
   from `pi/search/lib/rg.test.ts`. Import `createFdExecutor` and `SpawnProcess` from
   `./fd.ts`. Use the same `MockStream`, `MockChildProcess`, and `createSpawnMock`
   helper pattern, but the spawn mock should assert `command === "fd"` instead of
   `"rg"`.

   Include these tests:

   - `exit code 0 splits multiline stdout into trimmed lines and strips trailing slashes`
   - `exit code 0 with empty stdout returns empty lines`
   - `exit code 1 surfaces stderr`
   - `exit code greater than 1 falls back to generic message when stderr is empty`
   - `ENOENT error returns installation guidance`
   - `lines without trailing slashes are preserved as-is`
   - `error followed by close resolves to the first finalized result`

5. Run:

       node --experimental-strip-types --test pi/search/lib/fd.test.ts

   Expect the run to fail because `pi/search/lib/fd.ts` does not exist yet.

6. Create `pi/search/lib/fd.ts`. Model it after `pi/search/lib/rg.ts`. The
   `splitLines` function should additionally strip trailing `/` or `\` before
   filtering empty lines. The `createFdExecutor` function spawns `fd`, collects
   stdout/stderr, and handles exit codes: 0 = success (return lines, null error),
   anything else = error (return stderr or a generic message). ENOENT = `fd` not
   installed. Export `createFdExecutor`, `executeFd`, and the `SpawnProcess` type.

7. Run:

       node --experimental-strip-types --test pi/search/lib/fd.test.ts

   Expect all `fd` executor tests to pass. Commit.

   Suggested message: `feat(search): add fd executor for directory-aware find`

8. In `pi/search/lib/types.ts`, add `kind?: "file" | "directory" | "any"` to the
   `FindToolParams` interface, after the `path` field. Add these new types after the
   existing `RgExecutor` type:

       export interface FdResult {
         lines: string[];
         error: string | null;
       }

       export type FdExecutor = (args: string[], cwd?: string) => Promise<FdResult>;

9. In `pi/search/extensions/find.ts`, add the imports for the new types and executor.
   Import `executeFd` from `../lib/fd.ts`, and import `FdExecutor` from
   `../lib/types.ts`.

   Replace `fileTargetMatchesPattern` with a shared helper such as
   `entryMatchesPattern(pattern: string, itemPath: string)` that keeps the current
   semantics:

   - normalize the pattern with `normalizePattern`
   - normalize the item path with `normalizeSeparators`
   - if the normalized pattern contains `/`, compare against the full normalized path
   - otherwise compare against `path.posix.basename(normalizedItemPath)`
   - use `path.posix.matchesGlob` for the final comparison

10. In `pi/search/extensions/find.ts`, add `buildFdArgs(params, scope)`.
    The function returns arguments in this order:

    - `"."` as the match-all pattern for `fd`
    - `"--type", "d"` if kind is `"directory"`
    - `"--type", "f", "--type", "d"` if kind is `"any"`
    - if `maxDepth` is set: `"--max-depth", String(normalizedDepth + 1)`
    - if `params.hidden`: `"--hidden"`
    - if `params.respectIgnore === false`: `"--no-ignore"`
    - for each name in `DEFAULT_SKIP_NAMES`: `"--exclude", name`
    - the scope path as the final positional argument

11. In `pi/search/extensions/find.ts`, update `FindToolDeps` to include
    `fdExecutor?: FdExecutor`. Update `createFindToolDefinition` to destructure
    `fdExecutor` from deps, defaulting to the imported `executeFd`.

12. In `pi/search/extensions/find.ts`, update the schema, prompt snippet, and prompt
    guidance together:

    - add `kind` to the schema properties with enum `file | directory | any`
    - update `promptSnippet` to `Find files and directories by path or name pattern with pagination.`
    - update `promptGuidelines` to mention `kind: "directory"` as the structured
      replacement for `bash find -type d`, `ls`, and `ls -R`

13. In `pi/search/extensions/find.ts`, branch by `kind` inside `execute` after path
    validation:

    - `const kind = params.kind ?? "file"`
    - if `kind === "file"`, keep the existing `rg` path unchanged except for using the
      renamed shared matcher in the direct-file shortcut
    - if `kind === "directory"` or `kind === "any"` and `validation.kind === "file"`:
      - `directory` returns an empty successful page with mode `find directories`
      - `any` applies the shared matcher to decide whether to return the file, with
        mode `find paths`
    - if `kind === "directory"` or `kind === "any"` and `validation.kind === "directory"`:
      - call `fdExecutor(buildFdArgs(...), cwd)`
      - if `fd` returns an error, surface it exactly like current `rg` error handling
      - filter `fd` result lines through the shared matcher before pagination
      - apply `applyMaxDepth` as a safety net after filtering
      - paginate and format the result envelope with mode `find directories` or
        `find paths`

14. Run:

        node --experimental-strip-types --test pi/search/test/find-extension.test.ts

    Expect some tests to fail on the first pass until the `find.ts` wiring is complete.
    Continue iterating until all tests in that file pass.

15. Run the focused search suite:

        node --experimental-strip-types --test \
          pi/search/lib/fd.test.ts \
          pi/search/lib/rg.test.ts \
          pi/search/lib/path-suggest.test.ts \
          pi/search/lib/pagination.test.ts \
          pi/search/test/find-extension.test.ts \
          pi/search/test/grep-extension.test.ts

    Expect all tests to pass.

16. Commit the public contract and runtime wiring together.

    Suggested message: `feat(search): add directory and any kinds to find`

17. Run the full repository test suite:

        npm test

    Expect all tests to pass. Record the pass count and duration here. If the suite
    fails for unrelated reasons, stop and document the exact failing files and why the
    failure is unrelated before proceeding.

18. Update this plan's Progress, Surprises & Discoveries, Decision Log, and Outcomes &
    Retrospective sections.


## Testing and Falsifiability

The feature is tested at two levels: the `fd` executor in isolation, and the `find`
extension end to end.

The `fd` executor tests in `pi/search/lib/fd.test.ts` use mock spawn processes (same
pattern as `pi/search/lib/rg.test.ts`) and verify: stdout line splitting, trailing
slash stripping, exit code handling (0 = success, non-zero = error), ENOENT handling,
and double-event resilience.

The extension tests in `pi/search/test/find-extension.test.ts` use injected mock
executors and path validators and verify: schema shape, prompt guidance, mode strings,
pagination, direct-file-scope behavior for each kind, flag forwarding to fd, error
surfacing, slash-containing pattern parity, and backward compatibility of the
file-only default.

Add explicit tests for these parity cases:

- a slash-containing pattern in `kind: "directory"` matches only the expected
  directory entry from a larger `fd` result set
- a slash-containing pattern in `kind: "any"` matches the same file or directory path
  the shared matcher would match in file mode
- `kind: "any"` with a file scope uses the same shared matcher as the direct-file
  file-mode shortcut

The plan is false if any of these conditions hold after implementation:

- `kind: "file"` or omitted `kind` behaves differently from the current implementation
- `kind: "directory"` returns files or returns the scoped directory itself
- `kind: "any"` fails to return matching files that the shared matcher would accept
- a slash-containing pattern that should match under current file-mode semantics stops
  matching in `kind: "directory"` or `kind: "any"`
- `kind: "directory"` with a file scope returns an error instead of zero results
- `maxDepth` forwarding to `fd` uses a different offset than the +1 convention
- `fd` trailing slashes appear in result items
- hidden or ignored directories leak into default results
- the `fd` executor does not surface ENOENT clearly

The focused runner command is:

    node --experimental-strip-types --test pi/search/lib/fd.test.ts pi/search/test/find-extension.test.ts

The full suite command is:

    npm test


## Validation and Acceptance

Acceptance is behavioral. From the repository root:

1. Run `node --experimental-strip-types --test pi/search/lib/fd.test.ts` and expect all
   executor tests to pass.

2. Run `node --experimental-strip-types --test pi/search/test/find-extension.test.ts`
   and expect all extension tests to pass, including the new kind-related and
   slash-pattern-parity tests.

3. Run this smoke check and expect only the three direct child directories under
   `pi/search`:

       node --experimental-strip-types --input-type=module -e "import { createFindToolDefinition } from './pi/search/extensions/find.ts'; const tool = createFindToolDefinition(); const result = await tool.execute('call', { pattern: '*', kind: 'directory', path: 'pi/search', maxDepth: 0 }, undefined, undefined, { cwd: process.cwd() }); console.log(result.content[0].text);"

   Expected output:

       Mode: find directories | Scope: pi/search
       pi/search/extensions
       pi/search/lib
       pi/search/test
       3 results.

4. Run this smoke check and expect the mixed-mode path query to preserve full-path
   semantics for a slash-containing pattern:

       node --experimental-strip-types --input-type=module -e "import { createFindToolDefinition } from './pi/search/extensions/find.ts'; const tool = createFindToolDefinition(); const result = await tool.execute('call', { pattern: 'pi/search/lib/*.ts', kind: 'any', path: 'pi/search' }, undefined, undefined, { cwd: process.cwd() }); console.log(result.content[0].text);"

   Expected output begins with:

       Mode: find paths | Scope: pi/search
       pi/search/lib/

   and then lists only `pi/search/lib` entries that match the pattern semantics after
   trailing-slash normalization.

5. Run `npm test` and expect a fully passing run. At the time this plan was written,
   that command passed with 708 tests. The final count will be higher by the number of
   new tests added.

The implementation is not accepted until all five checks are green and this plan's
Progress section reflects the final state.


## Rollout, Recovery, and Idempotence

The change is additive because `kind` defaults to `"file"`. Existing callers that omit
`kind` see exactly the same `rg --files` behavior as before.

The public schema and runtime behavior land together in one commit, so there is no
rollout window where the tool advertises `kind` but cannot execute it.

If `fd` is not installed in a particular environment, `kind: "directory"` and
`kind: "any"` return a clear error message. `kind: "file"` continues to work via `rg`.

If the new `fd` path proves unstable, recovery is simple: remove `kind` from the schema
and types, delete `pi/search/lib/fd.ts` and `pi/search/lib/fd.test.ts`, revert the
branching logic in `find.ts`, and the existing file-only `rg` path remains intact.

The concrete steps are idempotent. Creating mock-based tests is safe to repeat. No
dependencies are installed, no lockfiles are generated, and no package metadata is
modified.


## Artifacts and Notes

Current `find.ts` implementation evidence showing file-only behavior:

    // pi/search/extensions/find.ts — buildFindArgs
    const args = ["--files"];

The `fd` equivalent for directory discovery when enumerating all entries within a
scope uses a match-all pattern:

    fd . pi/search --type d --max-depth 1

    pi/search/extensions/
    pi/search/lib/
    pi/search/test/

Note: `fd` appends trailing slashes to directory paths. The executor strips them.

`fd` exit code behavior (different from `rg`):

    fd --glob 'nonexistent_zzz' --type d pi/search; echo "exit: $?"
    exit: 0

`fd` pattern-semantics drift that must not leak into the public tool contract:

    rg --files --glob 'pi/search/lib/*.ts' pi/search
    pi/search/lib/path-suggest.test.ts
    pi/search/lib/rg.ts
    ...

    fd --glob --full-path 'pi/search/lib/*.ts' pi/search
    # no output

Current test run:

    npm test → 728 tests, 0 failures


## Interfaces and Dependencies

In `pi/search/lib/types.ts`, the final `FindToolParams` must include:

    export interface FindToolParams {
      pattern: string;
      path?: string;
      kind?: "file" | "directory" | "any";
      maxDepth?: number;
      limit?: number;
      offset?: number;
      hidden?: boolean;
      respectIgnore?: boolean;
    }

In `pi/search/lib/types.ts`, add:

    export interface FdResult {
      lines: string[];
      error: string | null;
    }

    export type FdExecutor = (args: string[], cwd?: string) => Promise<FdResult>;

In `pi/search/lib/fd.ts`, export:

    export type SpawnProcess = typeof spawn;
    export function createFdExecutor(spawnProcess?: SpawnProcess): FdExecutor;
    export const executeFd: FdExecutor;

In `pi/search/extensions/find.ts`, the `FindToolDeps` interface becomes:

    export interface FindToolDeps {
      rgExecutor?: RgExecutor;
      fdExecutor?: FdExecutor;
      pathValidator?: (requestedPath: string | undefined, root: string) => Promise<PathValidationResult>;
    }

In `pi/search/extensions/find.ts`, add a shared matcher with this contract:

    function entryMatchesPattern(pattern: string, itemPath: string): boolean;

The implementation must preserve existing semantics: slash-containing patterns match
against the full normalized path, slash-free patterns match against the basename.

In `pi/search/extensions/find.ts`, `buildFdArgs` must use a match-all `fd` pattern and
leave final pattern filtering to TypeScript:

    [".", "--type", "d", ..., scope]

for directory mode, or

    [".", "--type", "f", "--type", "d", ..., scope]

for mixed mode.

No npm dependencies are added. The only external tool dependency is `fd`, which is
already available via Nix. If `fd` is absent, the tool degrades gracefully with a
clear error message for non-file kinds.


## Revision Note

Updated on 2026-04-05 after adversarial review. The plan now preserves slash-containing
pattern semantics by using `fd` only for traversal and applying the final pattern in
TypeScript, lands the public `kind` contract only when the runtime behavior exists,
fixes the incorrect `fd.test.ts` import path, and adds explicit parity and smoke-test
validation for the new modes.
