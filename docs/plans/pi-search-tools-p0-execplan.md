# Add repo-local `find` and `grep` overrides under `pi/search` with pagination, path recovery, and literal-first search

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, sessions that load this repository's pi package will use repo-local
`find` and `grep` tools instead of vanilla pi's built-in versions. The new tools will
keep the familiar names and baseline behavior, but they will directly solve the common
search failures seen in real pi usage: brittle OR regexes, missing-path loops, and
unhelpful first-page truncation.

A user-visible success case looks like this. The model can ask `grep` to search for any
of several literal terms without building a giant `foo|bar|baz` regex, can page through
results with `offset`, can scope the search with `glob` or `type`, and gets a clear
message when a requested path is wrong. The model can ask `find` for matching files and
continue from a later page instead of rerunning the same broad search. The result should
be fewer bash search fallbacks and fewer multi-turn search refinement loops.

## Problem Framing and Constraints

The problem is not that pi lacks search tools. The problem is that the current built-in
`find` and `grep` shapes are too easy for an agent to use inefficiently.

A local session analysis found `2,100` search-related bash commands across `110` session
files. The largest friction points were:

- large OR expressions expressed as fragile regex pipes
- repeated search-refinement chains (`225` in the analyzed sample)
- broad searches cut down with `| head`
- wrong path guesses followed by extra discovery steps
- `find | grep` composition to combine file filtering with content search

This plan is intentionally constrained.

It must fit this repository's package model. The root `package.json` already exports
extension directories such as `./pi/web/extensions` and `./pi/lsp/extensions`, but there
is currently no `./pi/search/extensions` entry.

It must fit this repository's test environment. Plain `node --experimental-strip-types
--test ...` runs in this workspace cannot rely on pi being installed as a normal npm
runtime dependency. Existing local tools such as `pi/web/extensions/fetch.ts` therefore
use object-literal schemas and type-only imports. The new search package must do the
same.

It must stay proportionate. This plan does not attempt AST-aware search, LSP-backed
block extraction, indexing, or semantic ranking. It solves the high-frequency friction
visible in current usage while preserving the familiar tool names.

It must be safe to roll out. A broken search override is worse than a limited built-in
search tool, so the new package should be implemented, tested, and manually exercised
before the root `package.json` enables it by default.

## Strategy Overview

Create a new package area at `pi/search` and register two tools from it:

- `pi/search/extensions/find.ts`
- `pi/search/extensions/grep.ts`

Because the tool names match pi's built-in names, pi will use these repo-local tools
when this package is loaded.

Both tools will share a small library layer under `pi/search/lib`. The shared layer will
handle path normalization, path validation, candidate-path suggestions, pagination,
default skip globs, and text-envelope formatting. The actual search engine for both
tools will be `ripgrep`.

`find` will be implemented with `rg --files` plus `--glob` filters rather than a second
engine such as `fd`. This keeps P0 smaller and makes ignore-file behavior consistent
between `find` and `grep`.

`grep` will be a backward-compatible superset of pi's built-in schema. It will continue
to accept `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, and `limit`.
It will add:

- `anyOf: string[]` as the first-class alternative to pipe-heavy OR regexes
- `offset: number` for pagination
- `outputMode: "content" | "files_with_matches" | "count"`
- `type: string`
- `hidden: boolean`
- `respectIgnore: boolean`
- `regex: boolean` as an explicit opt-in alias for regex behavior

The semantics are closed here to avoid ambiguity during implementation. Exactly one of
`pattern` or `anyOf` must be provided. `anyOf` is always treated as literal text. When
`pattern` is used, the default is literal search unless the caller sets `regex: true` or
`literal: false`. This preserves compatibility with existing built-in habits while making
the safer mode the default.

`find` will stay narrower. Its `pattern` field is a glob pattern applied to filenames. The
implementation will pass it to `rg --files` via `--glob '*<pattern>*'` so that the pattern
matches any file whose path contains the given text. When the caller wants an exact glob
such as `*.test.ts`, the implementation detects the leading `*` or other glob metacharacter
and passes it through verbatim instead of wrapping it. This means a plain word like
`config` matches any file with "config" in its path, while `*.json` matches JSON files
specifically. `find` will keep `pattern`, `path`, and `limit`, and add:

- `offset: number`
- `hidden: boolean`
- `respectIgnore: boolean`

Both tools will return explicit pagination information in their result text and details.
The text envelope must always tell the caller whether more results exist and which
`offset` to use next.

To reduce blast radius, the rollout will happen in two stages. First, create the
package, tests, and tool definitions without adding `./pi/search/extensions` to the root
`package.json`. Only after targeted tests pass and a manual smoke check succeeds should
the root `package.json` be updated.

## Alternatives Considered

The simplest alternative is to leave the built-in tools alone and rely on bash for more
complex searches. This was rejected because the observed usage already shows that the
friction is real, frequent, and expensive.

Another option is to build a brand-new unified `search` tool first. That was rejected for
P0 because the user asked about replacement versions of pi's existing search tools, and a
drop-in override has a much smaller adoption risk. A future unified tool can still be
built on top of the shared library after these semantics are proven.

A third option is to copy Claude CLI's search behavior more or less directly. That was
rejected because the goal is not shell compatibility with Claude. The goal is to solve
this repository's observed agent-search pain. Claude's implementation is useful as input,
but P0 should stay smaller and shaped by the local session data.

A fourth option is to use both `ripgrep` and `fd`, matching the common CLI pairing. That
was rejected for P0 because `rg --files` is enough for the first milestone and keeping
one engine reduces complexity in tests, argument construction, and ignore semantics.

## Risks and Countermeasures

The first risk is schema ambiguity. If `pattern`, `literal`, `regex`, and `anyOf` can be
combined loosely, the implementation will accumulate edge cases and the model will get
inconsistent behavior. The countermeasure is to close the semantics now: exactly one of
`pattern` or `anyOf`; `anyOf` is always literal; regex only happens when explicitly
requested.

The second risk is a broad-search timeout or noisy result set in large repositories. The
countermeasure is to respect ignore files by default, hide hidden files by default, and
apply a shared default skip list for noisy directories. The tool should still allow the
caller to opt into broader traversal.

The third risk is path suggestion churn. If the tool guesses wildly, the suggestions will
waste context instead of saving it. The countermeasure is to keep P0 suggestions simple:
only return a small bounded list of candidate repo-relative paths based on basename and
prefix similarity under the current working tree.

The fourth risk is overfitting to result text. If the format changes constantly while the
feature is being built, the later phases will not have a stable base. The countermeasure
is to settle a clear envelope in P0 and extend it additively later.

The fifth risk is rollout regression. If the new tools are added to the root package too
early, every normal session that loads this repository gets the new behavior before it is
proven. The countermeasure is to delay the root `package.json` change until the final
milestone.

## Progress

- [x] (2026-04-01 00:00Z) Verified the repository's root `package.json` currently loads multiple extension directories under `pi/...` and does not yet include `./pi/search/extensions`.
- [x] (2026-04-01 00:04Z) Verified there is currently no `pi/search` directory in this repository.
- [x] (2026-04-01 00:08Z) Verified local package tools in this repository use object-literal schemas and type-only pi imports so plain Node tests remain runnable.
- [x] (2026-04-01 00:12Z) Verified pi's built-in tool list includes `find` and `grep`, and verified the current built-in input shapes from installed type definitions.
- [x] (2026-04-01 00:16Z) Chosen P0 scope: repo-local `find` and `grep` overrides with literal-first search, `anyOf`, pagination, ignore controls, and path recovery. Ranking, streaming, structural context, and indexing are deferred.
- [ ] Scaffold `pi/search` package files, shared library files, and focused tests without enabling the package in root `package.json`.
- [ ] Implement shared helpers for path normalization, path suggestions, pagination, default skip globs, and result-envelope formatting.
- [ ] Implement `grep` override with backward-compatible built-in fields plus `anyOf`, `offset`, `outputMode`, `type`, `hidden`, `respectIgnore`, and `regex`.
- [ ] Implement `find` override with `offset`, `hidden`, and `respectIgnore`, plus the shared result envelope.
- [ ] Run targeted tests and a full `npm test` pass, then manually smoke-test the overrides.
- [ ] Add `./pi/search/extensions` to root `package.json` only after the smoke test passes.
- [ ] Update this plan with final validation evidence and retrospective notes.

## Surprises & Discoveries

- Observation: pi's built-in `grep` already accepts `literal`, but literal search is not the default shape.
  Evidence: installed type definitions show built-in `grep` supports `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, and `limit`.

- Observation: pi's built-in `find` surface is intentionally tiny.
  Evidence: installed type definitions show built-in `find` only accepts `pattern`, `path`, and `limit`.

- Observation: this repository currently has no first-party search package area to extend.
  Evidence: repository file listing shows package areas such as `pi/web`, `pi/lsp`, and `pi/jj`, but no `pi/search`.

## Decision Log

- Decision: create a new package area at `pi/search`.
  Rationale: the repository already organizes first-party features under `pi/...`, and search is large enough to deserve its own area instead of being buried under an unrelated package.
  Date: 2026-04-01

- Decision: use repo-local overrides with the built-in tool names `find` and `grep`.
  Rationale: this gives immediate value with the lowest migration cost and lets later phases reuse the same package foundations.
  Date: 2026-04-01

- Decision: use `ripgrep` as the only engine in P0 for both file search and content search.
  Rationale: one engine keeps the implementation smaller and keeps ignore-file behavior consistent.
  Date: 2026-04-01

- Decision: make literal search the default for `grep` when the caller does not explicitly request regex mode.
  Rationale: this directly addresses observed regex and flag mistakes while preserving an explicit escape hatch.
  Date: 2026-04-01

- Decision: add only `anyOf` as the first structured multi-term field in P0.
  Rationale: local usage shows OR-pattern pain is the highest-value structured-search improvement. `allOf`, exclusion filters, ranking, and streaming are better deferred to later phases.
  Date: 2026-04-01

- Decision: do not enable `./pi/search/extensions` in root `package.json` until the end of the plan.
  Rationale: the package is loaded in normal use, so staged rollout is safer than immediate opt-in by default.
  Date: 2026-04-01

## Outcomes & Retrospective

(To be filled at major milestones and at completion.)

## Context and Orientation

This repository is a pi package workspace. The root `package.json` defines a `pi.extensions`
array that currently loads these extension directories:

- `./pi/chrome-devtools-mcp/extensions`
- `./pi/ci-guard/extensions`
- `./pi/code-review/extensions`
- `./pi/design-studio/extensions`
- `./pi/git/extensions`
- `./pi/jj/extensions`
- `./pi/live-edit/extensions`
- `./pi/lsp/extensions`
- `./pi/tmux-titles/extensions`
- `./pi/web/extensions`
- `./pi/http-bridge/extensions`

The repository's current tool-extension style is visible in `pi/web/extensions/fetch.ts`.
That file registers a tool with an object-literal `parameters` schema, uses type-only pi
imports, and keeps logic in `pi/web/lib/fetch-core.ts` so the core remains testable.

The repository's test helpers live in `test/helpers.ts`. That file exposes
`createMockExtensionAPI()`, which includes a mock `registerTool()` and a mock `exec()`.
The new search package should follow this existing pattern rather than invent a new test
harness.

The current installed pi version exposes built-in `find` and `grep` tools. The verified
built-in input shapes are:

For `grep`:

- `pattern: string`
- `path?: string`
- `glob?: string`
- `ignoreCase?: boolean`
- `literal?: boolean`
- `context?: number`
- `limit?: number`

For `find`:

- `pattern: string`
- `path?: string`
- `limit?: number`

This plan intentionally keeps those built-in fields valid while extending the tools with
P0-specific improvements.

A "result envelope" in this plan means the text returned to the model plus the matching
`details` object. The envelope must always communicate four facts clearly: what was
searched, how many items were returned, whether the result was truncated, and how to
continue.

## Preconditions and Verified Facts

The plan depends on the following repository facts, all verified while writing it.

The root `package.json` currently defines the test script:

    node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'

The root `package.json` does not yet include `./pi/search/extensions` in `pi.extensions`.

There is currently no `pi/search` directory, so this work will be additive rather than a
refactor of an existing package.

The repository already includes examples of extension-specific tests and package-local
libraries in:

- `pi/web/extensions/fetch.ts`
- `pi/web/lib/fetch-core.ts`
- `test/extensions/fetch.test.ts`
- `pi/lsp/test/extension.test.ts`
- `test/helpers.ts`

The installed pi README explicitly states that built-in tools can be replaced entirely by
extensions. The installed built-in tool list includes `read`, `bash`, `edit`, `write`,
`grep`, `find`, and `ls`.

## Scope Boundaries

This plan is in scope for two repo-local tool overrides only: `find` and `grep`.

The plan includes package scaffolding, shared search helpers, targeted tests, manual smoke
validation, and the root `package.json` enablement step.

The plan includes only the following behavior expansions:

- literal-first `grep`
- `anyOf` literal multi-term search
- pagination via `offset`
- `outputMode` for `grep`
- ignore and hidden-file controls
- path validation and candidate-path suggestions
- explicit result envelopes with continuation hints

The plan does **not** include:

- a new unified `search` tool
- AST-aware search
- LSP-aware symbol or block extraction
- semantic or recency ranking
- streaming partial results
- shell alias shadowing for terminal `find` and `grep`

If implementation work starts to require any of those, that is a signal that the change
belongs in a future ExecPlan rather than being folded into P0.

## Milestones

### Milestone 1: package scaffold and shared foundations

Create the new `pi/search` package area, shared helper modules, and red-green unit tests
for pagination, skip-glob construction, and path suggestion behavior. At the end of this
milestone, the repository contains a complete package skeleton and passing tests for the
shared non-search logic, but the package is still not enabled in root `package.json`.

This milestone comes first because it retires the highest implementation risk: the helper
contracts that both tools will depend on.

### Milestone 2: `grep` override

Implement the `grep` tool definition, argument construction, result envelope, and focused
extension tests. At the end of this milestone, the tool registers under the name `grep`,
accepts the built-in fields plus the P0 additions, and passes its targeted test suite.

This milestone comes before `find` because the local usage analysis shows `grep`-style
content search is the larger source of friction.

### Milestone 3: `find` override

Implement the `find` tool definition on top of `rg --files`, using the shared pagination,
skip-glob, and path-validation helpers. At the end of this milestone, `find` supports
pagination and ignore controls and has passing extension tests.

This milestone reuses the P0 foundations rather than inventing a separate file-search
path.

### Milestone 4: rollout, validation, and documentation evidence

Run the targeted tests, run the full repository test suite, manually smoke-test the new
tools, and only then add `./pi/search/extensions` to the root `package.json`. At the end
of this milestone, the overrides are enabled by default for this package and the plan
contains the evidence needed to prove the rollout was safe.

## Plan of Work

Create a new package directory `pi/search` with one package manifest and two extension
entrypoints. The package manifest at `pi/search/package.json` must contain:

    {
      "name": "@bromanko/pi-search",
      "version": "1.0.0",
      "type": "module",
      "description": "Repo-local find and grep overrides with pagination and literal-first search",
      "keywords": ["pi-package"],
      "author": {
        "name": "bromanko",
        "email": "hello@bromanko.com"
      },
      "pi": {
        "extensions": ["./extensions"]
      }
    }

This follows the same pattern used by every other first-party package in this repository
(for example `pi/web/package.json`, `pi/lsp/package.json`, and `pi/jj/package.json`). The
root `package.json` should only add `./pi/search/extensions` to `pi.extensions` after the
targeted tests pass and the tool behavior has been manually exercised.

Under `pi/search/lib`, add small focused modules instead of one large file.

In `pi/search/lib/types.ts`, define the shared result-detail types and the two tool input
shapes used by the extension files. Use object-literal JSON schema definitions in the
extension files for runtime registration, and derive narrow local TypeScript interfaces for
implementation.

In `pi/search/lib/constants.ts`, define the default skip globs and the default page sizes.
The skip list should include version-control directories and bulky generated directories:
`.git`, `.jj`, `.svn`, `.hg`, `.bzr`, `node_modules`, `dist`, `build`, `coverage`,
`.next`, `.turbo`, `vendor`, and `__pycache__`. The defaults should be shared by both
`find` and `grep`.

In `pi/search/lib/pagination.ts`, implement pure helpers that take a full ordered result
list plus `limit` and `offset` and return the selected window, whether truncation
occurred, the next offset if one exists, and the total count.

In `pi/search/lib/path-suggest.ts`, implement path normalization and missing-path
recovery. The helper should take a requested `path` and current working directory and
return one of three outcomes: valid path, invalid path with no candidates, or invalid path
with a bounded candidate list. Candidate generation should stay simple in P0: prefer exact
basename matches under the working tree, then prefix-similar matches, and cap the returned
list at three suggestions. The helper must reject any `path` that resolves outside the
working tree root (for example `../../sensitive-repo`) by returning `{ valid: false,
suggestions: [] }` without searching. This prevents the suggestion engine from leaking
directory names above the repository boundary.

In `pi/search/lib/result-envelope.ts`, implement shared text formatting so both tools
return a stable result shape. The module must export a `ResultEnvelope` interface and a
pure `formatResultEnvelope` function:

    export interface ResultEnvelope {
      /** The tool mode label, e.g. "grep content" or "find files". */
      mode: string;
      /** Repository-relative path that was searched. */
      scope: string;
      /** The items visible on this page. */
      items: string[];
      /** Total number of items across all pages. */
      totalCount: number;
      /** Whether the result set was truncated by the page limit. */
      truncated: boolean;
      /** The offset to pass for the next page, or undefined if this is the last page. */
      nextOffset: number | undefined;
    }

    export function formatResultEnvelope(envelope: ResultEnvelope): string;

The returned text must always include a first line naming the tool mode and scope, then the
returned items, then a final summary line. When truncated, the summary must state the page
window and continuation hint, for example: "Showing 1–50 of 213 results. Use offset=50 to
continue." When not truncated, the summary must state the total, for example: "3 results."

In `pi/search/lib/rg.ts`, implement the single execution seam that shells out to
`ripgrep`. This should be injectable in tests and should return parsed stdout lines rather
than raw process output where possible. The implementation must handle `rg` exit codes
correctly: exit 0 means matches were found and stdout contains results; exit 1 means no
matches were found and is not an error (return an empty result set); exit 2 or higher means
a real error occurred (return an actionable error message including the stderr text). If
`ripgrep` is not installed at all (the `rg` command is not found), return a clear error
message stating that ripgrep is required and how to install it.

In `pi/search/extensions/grep.ts`, register the tool named `grep`. Build the schema as a
backward-compatible superset of the built-in fields. The `execute` function should:

- validate the mutual exclusivity of `pattern` and `anyOf`
- validate the requested `path` using the shared path helper
- build `rg` arguments according to literal/regex semantics
- apply `glob`, `type`, `hidden`, and `respectIgnore` (`type` passes through to `rg --type`, accepting ripgrep's built-in file-type aliases such as `ts`, `py`, `json`, `html`; an invalid type string causes `rg` to exit with code 2, which should be surfaced as a clear error)
- run `rg`
- shape results according to `outputMode`
- apply pagination with `limit` and `offset`
- return the shared text envelope plus details

In `pi/search/extensions/find.ts`, register the tool named `find`. The `execute` function
should:

- validate `path`
- interpret `pattern` as a filename glob: if it contains glob metacharacters (`*`, `?`,
  `[`, `{`), pass it to `rg --files --glob` as-is; otherwise wrap it as `*<pattern>*` so
  plain words match any file containing that text in its path
- build `rg --files` arguments using `hidden`, `respectIgnore`, and shared skip globs
- paginate the resulting file list with `limit` and `offset`
- handle `rg` exit codes: exit 1 returns empty results, exit 2+ returns error
- return the shared text envelope plus details

If custom renderers make the output contract safer and easier to test, define them inside
the extension files using the same small component pattern already used in
`pi/web/extensions/fetch.ts`.

## Concrete Steps

From the repository root, perform the following steps in order.

1. Create the package directory and empty files.

    mkdir -p pi/search/extensions
    mkdir -p pi/search/lib
    mkdir -p pi/search/test
    touch pi/search/package.json
    touch pi/search/extensions/grep.ts
    touch pi/search/extensions/find.ts
    touch pi/search/lib/types.ts
    touch pi/search/lib/constants.ts
    touch pi/search/lib/pagination.ts
    touch pi/search/lib/path-suggest.ts
    touch pi/search/lib/result-envelope.ts
    touch pi/search/lib/rg.ts
    touch pi/search/lib/pagination.test.ts
    touch pi/search/lib/path-suggest.test.ts
    touch pi/search/test/grep-extension.test.ts
    touch pi/search/test/find-extension.test.ts

Expected result: all files exist and the package area is present, but the root
`package.json` is unchanged.

2. Write the failing shared-helper tests first.

In `pi/search/lib/pagination.test.ts`, write tests using `node:test` and `node:assert/strict`:

- Test "returns all items when result fits in one page": call `paginate(["a", "b", "c"], { limit: 10, offset: 0 })` and assert the return is `{ items: ["a", "b", "c"], totalCount: 3, truncated: false, nextOffset: undefined }`.

- Test "truncates and provides nextOffset when results exceed limit": call `paginate(["a", "b", "c", "d", "e"], { limit: 3, offset: 0 })` and assert the return is `{ items: ["a", "b", "c"], totalCount: 5, truncated: true, nextOffset: 3 }`.

- Test "offset shifts the visible window": call `paginate(["a", "b", "c", "d", "e"], { limit: 2, offset: 2 })` and assert the return is `{ items: ["c", "d"], totalCount: 5, truncated: true, nextOffset: 4 }`.

- Test "offset past the end returns empty page": call `paginate(["a", "b"], { limit: 10, offset: 5 })` and assert the return is `{ items: [], totalCount: 2, truncated: false, nextOffset: undefined }`.

- Test "last page is not truncated": call `paginate(["a", "b", "c", "d", "e"], { limit: 3, offset: 3 })` and assert the return is `{ items: ["d", "e"], totalCount: 5, truncated: false, nextOffset: undefined }`.

In `pi/search/lib/path-suggest.test.ts`, write tests using `node:test` and `node:assert/strict`. These tests must use a temporary directory created with `node:fs` in a `before` hook (not the real repo tree) so they are hermetic.

- Test "accepts a valid existing path unchanged": create a temp dir with a subdirectory `src/`, call `validatePath("src", tempDir)`, and assert the result is `{ valid: true, resolved: "src" }`.

- Test "returns suggestion when basename matches a single directory": create a temp dir with `src/components/`, call `validatePath("components", tempDir)`, and assert the result is `{ valid: false, suggestions: ["src/components"] }`.

- Test "returns no suggestions when nothing matches": create an empty temp dir, call `validatePath("nonexistent", tempDir)`, and assert the result is `{ valid: false, suggestions: [] }`.

- Test "caps suggestions at three entries": create a temp dir with `a/utils/`, `b/utils/`, `c/utils/`, `d/utils/`, call `validatePath("utils", tempDir)`, and assert `result.suggestions.length` is `3`.

- Test "does not suggest paths outside the working tree root": create a temp dir, call `validatePath("../../etc", tempDir)`, and assert the result is `{ valid: false, suggestions: [] }`. This ensures the suggestion engine cannot leak directory names above the repository root.

Run:

    node --experimental-strip-types --test pi/search/lib/pagination.test.ts pi/search/lib/path-suggest.test.ts

Expected result before implementation: all 10 tests fail with errors like "paginate is not a function" or "validatePath is not a function".

3. Implement `pi/search/lib/constants.ts`, `pi/search/lib/pagination.ts`, and
`pi/search/lib/path-suggest.ts` until the shared-helper tests pass.

Run the same command again.

Expected result after implementation: all tests in those two files pass.

Commit point: create a commit containing the package scaffold and passing shared-helper
utilities.

Suggested commit message:

    add pi/search scaffold and shared pagination helpers

4. Write the failing `grep` extension tests in `pi/search/test/grep-extension.test.ts`.

Use `node:test` and `node:assert/strict`. Create a `setupExtension` helper that calls the
extension's default export with a mock API object containing a `registerTool` spy (follow
the pattern in `test/extensions/fetch.test.ts`). Inject a mock `rg` executor so no real
process calls happen. Write the following tests:

- Test "registers a tool named grep": call `setupExtension()`, assert the registered tool's `name` is `"grep"`.

- Test "schema exposes all built-in-compatible fields": get the registered tool's `parameters.properties` and assert it contains keys `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, and `limit`.

- Test "schema exposes P0 extension fields": assert `parameters.properties` also contains keys `anyOf`, `offset`, `outputMode`, `type`, `hidden`, `respectIgnore`, and `regex`.

- Test "rejects call with both pattern and anyOf": call `execute({ pattern: "foo", anyOf: ["bar"] })` and assert the result text contains `"Exactly one of"` or a similar clear mutual-exclusion error.

- Test "rejects call with neither pattern nor anyOf": call `execute({})` and assert the result text contains an error about requiring one of `pattern` or `anyOf`.

- Test "default search mode is literal when pattern is used": call `execute({ pattern: "foo.bar" })` with a mock executor that captures the args array. Assert the captured args include `"-F"` (ripgrep's fixed-string flag).

- Test "regex: true suppresses literal mode": call `execute({ pattern: "foo.*bar", regex: true })` with a capturing mock. Assert the captured args do not include `"-F"`.

- Test "literal: false suppresses literal mode for backward compat": call `execute({ pattern: "foo.*bar", literal: false })` with a capturing mock. Assert the captured args do not include `"-F"`.

- Test "anyOf builds repeated literal -e terms": call `execute({ anyOf: ["alpha", "beta", "gamma"] })` with a capturing mock. Assert the captured args include `["-F", "-e", "alpha", "-e", "beta", "-e", "gamma"]` in that order.

- Test "outputMode files_with_matches passes -l flag": call `execute({ pattern: "test", outputMode: "files_with_matches" })` with a capturing mock. Assert the captured args include `"-l"`.

- Test "outputMode count passes -c flag": call `execute({ pattern: "test", outputMode: "count" })` with a capturing mock. Assert the captured args include `"-c"`.

- Test "invalid path returns suggestion when available": set up a mock where `validatePath` returns `{ valid: false, suggestions: ["src/lib"] }`. Call `execute({ pattern: "foo", path: "lib" })` and assert the result text contains `"src/lib"`.

- Test "pagination text includes next offset": set up a mock executor that returns 60 lines. Call `execute({ pattern: "foo", limit: 50, offset: 0 })` and assert the result text contains `"offset=50"`.

- Test "type field passes through to rg --type": call `execute({ pattern: "foo", type: "ts" })` with a capturing mock. Assert the captured args include `["--type", "ts"]`.

- Test "rg exit code 1 returns empty results not an error": set up a mock executor that returns exit code 1 with empty stdout. Call `execute({ pattern: "nonexistent" })` and assert the result text contains `"0 results"` or equivalent and no error message.

- Test "rg exit code 2 returns an error message": set up a mock executor that returns exit code 2 with stderr `"regex parse error"`. Call `execute({ pattern: "foo", regex: true })` and assert the result text contains `"regex parse error"`.

- Test "rg not found returns installation guidance": set up a mock executor that throws an ENOENT error. Call `execute({ pattern: "foo" })` and assert the result text contains `"ripgrep"` and `"install"`.

Run:

    node --experimental-strip-types --test pi/search/test/grep-extension.test.ts

Expected result before implementation: all 17 tests fail.

5. Implement `pi/search/lib/rg.ts`, `pi/search/lib/result-envelope.ts`, and
`pi/search/extensions/grep.ts` until the `grep` tests pass.

Be precise about the argument-building behavior. For literal `pattern` search, pass `-F`.
For `regex: true` or `literal: false`, do not pass `-F`. For `anyOf`, use repeated
`-e <term>` entries with literal mode so the engine handles OR semantics safely. For
`type`, pass `--type <value>`. For `outputMode`, pass `-l` for `files_with_matches` and
`-c` for `count`.

In `rg.ts`, handle exit codes: exit 0 returns parsed stdout lines; exit 1 returns an empty
array (no matches is not an error); exit 2+ returns an error containing the stderr text.
If `rg` is not found (ENOENT), return an error stating that ripgrep is required.

Run:

    node --experimental-strip-types --test pi/search/test/grep-extension.test.ts

Expected result after implementation: all 17 `grep` tests pass.

Commit point: create a commit containing the `grep` override and its passing tests.

Suggested commit message:

    add literal-first grep override with anyOf and pagination

6. Write the failing `find` extension tests in `pi/search/test/find-extension.test.ts`.

Use `node:test` and `node:assert/strict`. Follow the same `setupExtension` and mock
executor pattern used in the `grep` tests. Write the following tests:

- Test "registers a tool named find": call `setupExtension()`, assert the registered tool's `name` is `"find"`.

- Test "schema exposes built-in-compatible fields": assert `parameters.properties` contains keys `pattern`, `path`, and `limit`.

- Test "schema exposes P0 extension fields": assert `parameters.properties` also contains keys `offset`, `hidden`, and `respectIgnore`.

- Test "invalid path returns suggestion when available": set up a mock where `validatePath` returns `{ valid: false, suggestions: ["pi/search"] }`. Call `execute({ pattern: "*.ts", path: "search" })` and assert the result text contains `"pi/search"`.

- Test "default args include shared skip globs": call `execute({ pattern: "*.ts" })` with a capturing mock. Assert the captured args include `"--glob"` entries for `"!.git"`, `"!node_modules"`, and `"!dist"` (at minimum these three from the shared skip list).

- Test "pattern without glob metacharacters wraps in wildcards": call `execute({ pattern: "config" })` with a capturing mock. Assert the captured args include a glob argument matching `"*config*"`.

- Test "pattern with glob metacharacters passes through verbatim": call `execute({ pattern: "*.test.ts" })` with a capturing mock. Assert the captured args include a glob argument matching `"*.test.ts"` exactly (not `"**.test.ts*"`).

- Test "pagination text includes next offset": set up a mock executor that returns 30 file paths. Call `execute({ pattern: "*.ts", limit: 20, offset: 0 })` and assert the result text contains `"offset=20"`.

- Test "respectIgnore false removes ignore behavior": call `execute({ pattern: "*.ts", respectIgnore: false })` with a capturing mock. Assert the captured args include `"--no-ignore"`.

- Test "hidden true includes hidden files": call `execute({ pattern: "*.ts", hidden: true })` with a capturing mock. Assert the captured args include `"--hidden"`.

- Test "rg exit code 1 returns empty results": set up a mock executor that returns exit code 1 with empty stdout. Call `execute({ pattern: "nonexistent" })` and assert the result text contains `"0 results"` or equivalent and no error message.

Run:

    node --experimental-strip-types --test pi/search/test/find-extension.test.ts

Expected result before implementation: all 11 tests fail.

7. Implement `pi/search/extensions/find.ts` until the `find` tests pass.

The `pattern` field must be interpreted as a glob for filename matching. If the pattern
contains glob metacharacters (`*`, `?`, `[`, `{`), pass it to `rg --files --glob` as-is.
If it does not contain metacharacters, wrap it as `*<pattern>*` so plain words like
`config` match any file with "config" in its path. Apply shared skip globs by default.
Handle `rg` exit codes the same way as `grep`: exit 1 is empty results, exit 2+ is error.

Run:

    node --experimental-strip-types --test pi/search/test/find-extension.test.ts

Expected result after implementation: all 11 `find` tests pass.

Commit point: create a commit containing the `find` override and its passing tests.

Suggested commit message:

    add paginated find override backed by ripgrep files mode

8. Run the full focused search-package test set.

    node --experimental-strip-types --test \
      pi/search/lib/pagination.test.ts \
      pi/search/lib/path-suggest.test.ts \
      pi/search/test/grep-extension.test.ts \
      pi/search/test/find-extension.test.ts

Expected result: all four test files pass. The total should be approximately 43 tests (5
pagination + 5 path-suggest + 17 grep + 11 find + any additional edge-case tests added
during implementation). If the count is significantly lower, a test file may not be loading
correctly.

9. Run the full repository test suite.

    npm test

Expected result: the existing repository tests still pass with the new package present but
not yet enabled in root `package.json`.

10. Manually smoke-test the package before enablement.

Temporarily add `"./pi/search/extensions"` to the root `package.json` `pi.extensions`
array, then start a pi session from the repository root. In that session, exercise the
following calls and verify the described behavior:

- Call `grep` with `{ "anyOf": ["createMockExtensionAPI", "registerTool", "ExecResult"] }`.
  Verify the result text includes matches from at least two different files and the summary
  line states a total count.

- Call `grep` with `{ "pattern": "nonexistent_xyz_term_42" }`. Verify the result text
  shows `0 results` and no error.

- Call `grep` with `{ "pattern": "test", "path": "pi/serch" }` (deliberate typo). Verify
  the result text includes a suggestion mentioning `pi/search`.

- Call `find` with `{ "pattern": "*.test.ts", "limit": 5 }`. Verify the result text shows
  exactly 5 file paths and a continuation hint with `offset=5`.

- Call `find` with `{ "pattern": "*.test.ts", "limit": 5, "offset": 5 }`. Verify the
  result text shows the next page of results starting after the first 5.

After the smoke test, revert the root `package.json` change (the permanent enablement
happens in step 11). Capture a short transcript excerpt in the Artifacts section.

11. Only after the smoke check succeeds, add `./pi/search/extensions` to the root
`package.json` `pi.extensions` array.

Run:

    npm test

Expected result: the full suite still passes after enablement.

Commit point: create a final commit containing root-package enablement and any final docs or
plan updates.

Suggested commit message:

    enable repo-local search tool overrides

12. Update this plan before stopping.

Mark completed steps in Progress, record any surprises, write any new design decisions in
Decision Log, and add an Outcomes & Retrospective entry summarizing validation results and
remaining gaps.

## Testing and Falsifiability

The new shared-helper tests must prove the pure logic behaves as specified.

`pi/search/lib/pagination.test.ts` must contain 5 tests proving:

- `paginate(["a","b","c"], {limit:10, offset:0})` returns all items, `truncated: false`, `nextOffset: undefined`
- `paginate(["a","b","c","d","e"], {limit:3, offset:0})` returns first 3, `truncated: true`, `nextOffset: 3`
- `paginate(["a","b","c","d","e"], {limit:2, offset:2})` returns `["c","d"]`, `nextOffset: 4`
- `paginate(["a","b"], {limit:10, offset:5})` returns empty, `truncated: false`
- `paginate(["a","b","c","d","e"], {limit:3, offset:3})` returns `["d","e"]`, `truncated: false`

`pi/search/lib/path-suggest.test.ts` must contain 5 tests proving:

- an existing subdirectory path resolves as `{ valid: true }`
- a missing basename that matches one candidate returns `{ valid: false, suggestions: ["<match>"] }`
- a missing basename with no matches returns `{ valid: false, suggestions: [] }`
- four matches caps suggestions at 3
- a path traversal attempt (`../../etc`) returns no suggestions and `valid: false`

`pi/search/test/grep-extension.test.ts` must contain 17 tests proving:

- tool registration, schema completeness (built-in and P0 fields)
- mutual exclusion of `pattern` and `anyOf` (both present rejects; neither present rejects)
- literal-first default (`-F` present), `regex: true` override (`-F` absent), `literal: false` backward compat (`-F` absent)
- `anyOf` expansion to `["-F", "-e", "alpha", "-e", "beta", "-e", "gamma"]`
- `outputMode` flag mapping (`-l` for files_with_matches, `-c` for count)
- `type` passthrough to `["--type", "ts"]`
- invalid path returns suggestion text
- pagination continuation hint
- `rg` exit code 1 returns empty results, exit code 2 returns error with stderr, ENOENT returns install guidance

`pi/search/test/find-extension.test.ts` must contain 11 tests proving:

- tool registration, schema completeness (built-in and P0 fields)
- invalid path returns suggestion
- default skip globs appear in args
- plain pattern wraps as `*config*`, glob pattern passes through verbatim
- pagination continuation hint
- `respectIgnore: false` adds `--no-ignore`, `hidden: true` adds `--hidden`
- `rg` exit code 1 returns empty results

The plan will be falsified if any of the following occur.

If the focused tests cannot be written without large amounts of implementation-specific
mocking, the design is too coupled and the helpers need to be made cleaner before rollout.

If the full repository test suite regresses before enablement, the package boundaries are
not isolated enough.

If the manual smoke test still pushes the model into OR-regex construction, path-guessing
loops, or repeated first-page reruns, then the P0 schema or envelope is not solving the
stated problem and must be revised before default enablement.

## Validation and Acceptance

Acceptance for this ExecPlan is behavioral.

From a pi session that loads this repository package, the tool list should include
repo-local `find` and `grep` overrides once the root `package.json` change lands.

`grep` should accept a call shaped like "search any of these three literal terms under a
subtree, return only matching files, and page if there are more." The result text must say
how many results were returned and how to continue.

`grep` should accept a plain `pattern` without regex escaping and treat it literally by
default.

`find` should accept a broad glob, return only the first page, and instruct the caller to
continue with the next `offset`.

Both tools should reject a bad `path` with a helpful message, and when an obvious candidate
exists the message should include it.

Validation commands are:

    node --experimental-strip-types --test \
      pi/search/lib/pagination.test.ts \
      pi/search/lib/path-suggest.test.ts \
      pi/search/test/grep-extension.test.ts \
      pi/search/test/find-extension.test.ts

and then:

    npm test

The expected result is that all targeted tests pass, the full suite passes, and the manual
smoke test shows the new search behavior working in an actual pi session.

## Rollout, Recovery, and Idempotence

All code and tests before the final `package.json` change are additive and safe to leave in
the tree without affecting normal sessions.

The enabling step is a single reversible change in root `package.json`: adding
`./pi/search/extensions` to `pi.extensions`. If the smoke test or post-enable validation
fails, remove that entry and rerun `npm test`.

The test commands are idempotent and safe to rerun.

The manual smoke-test step is also safe to repeat because it uses explicit extension loading
before default enablement.

## Artifacts and Notes

Add short excerpts here during implementation. At minimum, capture:

- one targeted test run showing all `pi/search` tests passing
- one `npm test` excerpt after enablement
- one short manual smoke transcript showing `grep anyOf` and paginated `find`

Example shape to replace with real output later:

    ✔ pagination returns all items when result fits in one page (0.5ms)
    ✔ grep registers a tool named grep (0.3ms)
    ✔ find default args include shared skip globs (0.4ms)
    ... (≈43 tests total)
    43 tests passed

    > npm test
    ...
    # all repository tests passed

## Interfaces and Dependencies

In `pi/search/extensions/grep.ts`, define a tool named exactly `grep`.

Its runtime schema must include at least these properties:

    pattern?: string
    anyOf?: string[]
    path?: string
    glob?: string
    type?: string            // passed through to rg --type; accepts ripgrep built-in aliases
                             // such as "ts", "py", "json", "html"
    ignoreCase?: boolean
    literal?: boolean
    regex?: boolean
    context?: number
    limit?: number
    offset?: number
    outputMode?: "content" | "files_with_matches" | "count"
    hidden?: boolean
    respectIgnore?: boolean

The implementation must enforce that exactly one of `pattern` or `anyOf` is present.

In `pi/search/extensions/find.ts`, define a tool named exactly `find`.

Its runtime schema must include at least these properties:

    pattern: string          // glob pattern for filename matching; plain words are wrapped
                             // as *<pattern>*; glob metacharacters pass through verbatim
    path?: string
    limit?: number
    offset?: number
    hidden?: boolean
    respectIgnore?: boolean

In `pi/search/lib/rg.ts`, define an injectable execution helper with this contract:

    export interface RgResult {
      /** Parsed stdout lines (empty array when rg exits with code 1 / no matches). */
      lines: string[];
      /** True when rg found matches (exit 0). False when no matches (exit 1). */
      matched: boolean;
      /** Non-null only when rg exits with code 2+ or is not found. Contains stderr or guidance. */
      error: string | null;
    }

    export type RgExecutor = (args: string[], cwd?: string) => Promise<RgResult>;

The default executor spawns `rg` as a child process. Exit 0 populates `lines` and sets
`matched: true`. Exit 1 returns `{ lines: [], matched: false, error: null }`. Exit 2+
returns `{ lines: [], matched: false, error: <stderr text> }`. If the `rg` command is not
found (ENOENT), return `{ lines: [], matched: false, error: "ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep" }`.
Tests should inject a mock `RgExecutor` instead of mocking child-process internals.

In `pi/search/lib/result-envelope.ts`, define pure formatting helpers so `find` and `grep`
share the same pagination and summary language. The module must export the `ResultEnvelope`
interface and `formatResultEnvelope` function described in the Strategy Overview section.

Do not add new package dependencies in P0 unless implementation proves they are absolutely
necessary. Prefer built-in Node modules and the existing repository testing setup.
