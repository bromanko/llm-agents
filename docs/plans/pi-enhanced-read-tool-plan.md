# Add a repo-local enhanced `read` tool override to this pi package

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, sessions that load this repository's pi package will use a repo-local
`read` tool override instead of vanilla pi's built-in `read`. The new tool will still feel
like `read`, but it will cover the common cases that currently push the model into manual
paging and bash fallbacks: bounded line ranges via `endLine`, last-N-line reads via `tail`,
and centered reads via `aroundLine` plus `context`.

The user-visible outcome is fewer `head`/`tail`/`sed` tool misses, more direct line-targeted
reads, and no need to maintain a separate `.pi/extensions` override outside this repo.

## Problem Framing and Constraints

The problem is not permissions. The problem is that the current built-in `read` is too small
for the way pi actually gets used in these sessions. Session analysis across `342` session
files found `8,600` `read` calls. Manual paging was very common (`48.3%` of reads used
`offset`, `48.5%` used `limit`, `47.3%` used both). The model also fell back to bash for line
targeting with at least `102` `sed -n`, `99` `head`, and `29` `tail` file-slicing commands.
Repeated reads were also common (`111/342` sessions had at least one exact repeated read, with
`440` extra exact-repeat reads), but addressing repeated reads via session-local dedup is
deferred to a future v2 — see the Decision Log for rationale.

The user wants a local package-level solution in this repository, not a one-off override under
`.pi/extensions`. This repository is already being used as a pi package, and the new behavior
should live beside existing package tools such as `pi/web/extensions/fetch.ts`.

Material constraints shape the design. Plain `node --experimental-strip-types --test ...`
runs in this repository cannot import `@mariozechner/pi-coding-agent` as a normal installed
npm package. Any runtime dependency on pi internals must therefore be optional, dynamically
loaded inside pi, or injected in tests. The plan must also preserve the built-in `read`
renderer and built-in result shape, because pi's UI and session logic expect them.

## Strategy Overview

Implement a new package area at `pi/files` and register a tool named `read` from
`pi/files/extensions/read.ts`. Because the tool name matches the built-in name, pi will use
this tool instead of the built-in one when the package is loaded.

The override will be hybrid.

For text files, the override will execute locally using a small repo-owned text-read core.
That core will mirror pi's current text-read behavior closely enough to preserve output shape
and continuation messages, while adding request normalization for `endLine`, `tail`, and
`aroundLine` plus `context`. Keeping text execution local avoids a second whole-file read for
these new targeting modes.

For image files, the override will delegate to pi's built-in `createReadToolDefinition(...)`
through a dynamically loaded fallback. That preserves existing image attachment and resize
behavior without copying the image pipeline into this repository.

The override will not provide custom `renderCall` or `renderResult` in v1. The built-in
interactive renderer will therefore continue to render the tool call and result. This keeps
syntax highlighting, truncation warnings, and existing UI behavior. The schema, description,
`promptSnippet`, and `promptGuidelines` must be defined explicitly, because those prompt fields
are not inherited automatically when overriding a built-in tool.

To reduce blast radius, the work will be rolled out in two stages. First, the extension will be
implemented and validated by loading it explicitly with `pi -e ./pi/files/extensions/read.ts`.
Only after tests and manual smoke validation pass will the root `package.json` be updated to
load `./pi/files/extensions` automatically.

## Alternatives Considered

The simplest alternative is to do nothing and keep using built-in `read` plus bash fallbacks.
This was rejected because the session history already shows that the current tool shape causes
recurring inefficiency and tool misses in real use, not hypothetical future use.

Another plausible alternative is a local override under `.pi/extensions`. This was rejected
because the user explicitly wants the implementation versioned in this repository, alongside
other package tools, so the behavior travels with the repo and the global package symlink.

A third option is an upstream patch in `badlogic/pi-mono`. That remains viable later, but it is
not the right first move here. The user wants immediate local value, upstream `main` is only a
small number of commits ahead of the installed version and does not already solve the targeted
problems, and upstreaming would slow iteration while the semantics are still being proven.

A fourth option is to wrap the built-in `read` entirely and normalize every new request into
plain `offset` and `limit` before delegation. This was rejected for v1 because `tail` and
`aroundLine` would require an extra full read merely to compute the target window, then a second
full read inside built-in `read` to return the content. A local text executor is a better fit
for the problem size.

## Risks and Countermeasures

The first risk is result-shape drift. If the override returns a result that differs materially
from built-in `read`, the interactive UI may render badly or session logic may mis-handle the
result. The countermeasure is to mirror built-in read's text-result contract exactly: the tool
must return `content` with text parts and `details` with only the same optional `truncation`
shape used by built-in `read`. Integration tests must assert this explicitly.

The second risk is runtime import drift. The plan depends on pi continuing to expose
`createReadToolDefinition(...)` for image fallback, but plain repository tests cannot import pi
runtime packages directly. The countermeasure is to inject the fallback loader in tests and to
add an early milestone proving that dynamic import works inside a real pi session before the
package is auto-enabled.

The third risk is an unhandled error in the override crashing the tool call. Because `read` is
arguably the most critical tool in the system, a broken override is significantly worse than a
limited built-in `read`. The countermeasure is to wrap the top-level execute path in a
try/catch that surfaces errors as structured tool results (matching the style built-in `read`
uses for offset-beyond-EOF errors), and to add explicit tests for file-not-found, directory
paths, and permission errors at both the core and extension level.

The fourth risk is image-extension detection drift. The override detects image files by
extension to decide whether to delegate to the built-in image pipeline. If built-in `read`
later adds support for formats not in the override's list (e.g., `.avif`, `.svg`, `.bmp`), the
override will silently try to text-read those files. The countermeasure is to copy the exact
image-extension set from the current built-in `read` implementation, pin it with a test that
asserts the known set, and add a comment noting that the list should be re-checked when
upgrading pi.

The fifth risk is path-resolution regressions on macOS screenshot paths or `~`-based paths.
The countermeasure is to copy the small upstream read-path normalization logic into the local
core and pin it with unit tests.

The sixth risk is unintentional global rollout because this repository is package-loaded in the
user's normal pi setup. The countermeasure is to keep the new package out of the root
`package.json` until the final milestone, validate first with explicit `-e`, and make rollback
just a revert of the root `package.json` change or of the enabling commit.

## Progress

- [x] (2026-04-01 00:00Z) Verified current repository package layout: root `package.json` loads extension directories such as `./pi/web/extensions`, and there is no existing file-tools package yet.
- [x] (2026-04-01 00:05Z) Verified repository test constraints: plain Node tests cannot import `@mariozechner/pi-coding-agent` at runtime, so the implementation must use type-only imports, dynamic imports, or dependency injection.
- [x] (2026-04-01 00:10Z) Verified pi extension docs and examples: registering a tool with the same name overrides a built-in tool, and omitting custom renderers preserves the built-in renderer.
- [x] (2026-04-01 00:15Z) Re-read upstream built-in `read` implementation and current path/truncation helpers to pin the current result shape, continuation notices, and image behavior that must be preserved.
- [x] (2026-04-01 00:20Z) Chosen implementation direction: repo-local package code under `pi/files`, `read` only, with expanded range targeting. Session-local dedup deferred to v2.
- [x] (2026-04-01 01:05Z) Scaffolded `pi/files/package.json`, `pi/files/extensions/read.ts`, and `test/extensions/read.test.ts` with a same-name `read` override, explicit prompt guidance, and dependency-injected fallback hooks.
- [x] (2026-04-01 01:20Z) Implemented `pi/files/lib/enhanced-read.ts` and `pi/files/lib/enhanced-read.test.ts` covering normalization, path resolution, truncation, continuation notices, and structured text-read errors.
- [x] (2026-04-01 01:30Z) Wired image fallback through lazy `import("@mariozechner/pi-coding-agent")`, added extension behavior tests, and fixed one validation-precedence bug caught by the new aroundLine/tail tests.
- [x] (2026-04-01 01:35Z) Ran targeted tests with `node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts test/extensions/read.test.ts` and got `37` passing tests.
- [x] (2026-04-01 01:45Z) Ran `npm test`; the new read tests stayed green, but `7` unrelated pre-existing failures remained in `test/extensions/code-review.test.ts`.
- [x] (2026-04-01 01:50Z) Performed programmatic smoke validation via `createEnhancedReadToolDefinition(...)` for `endLine`, `tail`, and `aroundLine`, then added `./pi/files/extensions` to the root `package.json`.
- [x] (2026-04-01 01:55Z) Updated `README.md` to document the enhanced read override and corrected stale `shared/...` / `packages/...` paths in the touched tool sections.
- [x] (2026-04-01 18:30Z) Investigated live image behavior in real pi runs, implemented a small-image retry path that re-invokes built-in image read with `autoResizeImages: false` after the specific Photon resize omission message, and verified the retry in extension tests.

## Surprises & Discoveries

- Observation: root documentation still contained stale examples pointing at `shared/extensions/...` and `packages/...`, while the current repository layout uses `pi/...` package paths.
  Evidence: before editing, `README.md` fetch and web-search sections pointed at `shared/extensions/fetch.ts` and `shared/extensions/web-search/index.ts`, while the actual files live at `pi/web/extensions/fetch.ts` and `pi/web/extensions/web-search/index.ts`.

- Observation: built-in `read` only stores `details.truncation` for text results; there is no richer built-in details payload to preserve.
  Evidence: upstream `packages/coding-agent/src/core/tools/read.ts` defines `ReadToolDetails` as `{ truncation?: TruncationResult }`.

- Observation: built-in `read` already reads the entire text file into memory before slicing, so a repo-local text executor does not worsen asymptotic behavior.
  Evidence: upstream `read.ts` reads the full file buffer and performs `textContent.split("\n")` before applying `offset` and `limit`.

- Observation: the first pass of the normalization validator produced the wrong error for `aroundLine + tail` because the `tail` incompatibility check ran first.
  Evidence: the initial targeted test run failed with `Error: tail cannot be combined with offset, limit, endLine, or aroundLine` in the `normalizeReadRequest rejects aroundLine with offset, limit, endLine, or tail` case; reordering the checks fixed the mismatch and the next targeted run passed all `37` tests.

- Observation: the full repository suite still has unrelated failures in `test/extensions/code-review.test.ts`, so the suite is not globally green even though the new read work is.
  Evidence: `npm test` ended with `532` passing and `7` failing tests, all in `/review` scenarios under `test/extensions/code-review.test.ts`.

- Observation: the original live image omission was caused by pi's Photon resize path failing on a valid grayscale+alpha PNG, not by the repo-local override.
  Evidence: calling built-in `createReadToolDefinition(...)` directly on `/tmp/pi-read-tool-image-kwUY4H.png` returned the same omission text; direct probing showed `resizeImage(...)` returned `null` and `PhotonImage.new_from_byteslice(...)` failed with `unreachable` for that file.

- Observation: retrying the problematic PNG without resize restores the inline image attachment at the tool layer, but the current model/provider path still rejects that specific image payload with `Could not process image`.
  Evidence: the session file `~/.pi/agent/sessions/--Users-bromanko-Code-llm-agents-ws-read-tool--/manual-read-image-retry.jsonl` shows the tool returned `content: [text, image]`, followed by an assistant turn with `stopReason: "error"` and `errorMessage: "The model returned the following errors: Could not process image"`.

## Decision Log

- Decision: place the feature in a new package area `pi/files` instead of piggybacking on `pi/web` or using `.pi/extensions`.
  Rationale: the tool is not web-specific, the repository already organizes first-party features as package areas under `pi/`, and the user explicitly wants the implementation to live in this repo.
  Date: 2026-04-01

- Decision: implement text reads locally but keep image reads delegated to built-in pi behavior.
  Rationale: this preserves image support and minimizes copied code, while avoiding a double-read penalty for new line-targeting modes on text files.
  Date: 2026-04-01

- Decision: define the new tool schema as a backward-compatible superset of built-in `read`: keep `path`, `offset`, and `limit`, and add only optional `endLine`, `tail`, `aroundLine`, and `context`.
  Rationale: existing model habits remain valid, while common bash fallback patterns gain direct tool support.
  Date: 2026-04-01

- Decision: keep `write` unchanged in this plan.
  Rationale: session data shows the larger and more certain payoff is on the `read` side; introducing `write` changes now would expand scope without clear necessity.
  Date: 2026-04-01

- Decision: do not add custom renderers in v1.
  Rationale: built-in rendering is already good, the docs say it is reused automatically for same-name overrides, and skipping custom renderers minimizes UI risk.
  Date: 2026-04-01

- Decision: defer session-local unchanged-file dedup to v2.
  Rationale: session data shows only ~1.3 exact-repeat reads per session — real but modest. Meanwhile, line targeting addresses 48% of reads and 230+ bash fallbacks. Dedup introduces a novel caching protocol that models must understand to avoid tool-miss loops (re-requesting content after receiving a stub). Neither a `force` parameter escape hatch nor a metadata-only approach resolves this cleanly: `force` requires fragile two-step recovery behavior from the model, while metadata that always returns full content provides no actual savings. Shipping dedup alongside line targeting risks undermining trust in the whole override if the caching confuses models. Better to ship line targeting, prove it stable, then design dedup with real usage data from the enhanced tool.
  Date: 2026-04-01

- Decision: keep the text executor's error surface as structured text results while leaving validation logic factored into a separately testable `normalizeReadRequest(...)` helper.
  Rationale: this gives the extension a non-crashing runtime path for real sessions, while preserving exact red/green unit tests for bad parameter combinations and normalization math.
  Date: 2026-04-01

- Decision: satisfy the smoke-validation milestone programmatically through `createEnhancedReadToolDefinition(...)` instead of driving an interactive pi TUI session from the agent harness.
  Rationale: the coding-agent environment can deterministically assert the same `endLine`, `tail`, and `aroundLine` behaviors without depending on TUI automation, while still exercising the shipped extension entry point.
  Date: 2026-04-01

- Decision: add a narrow image fallback retry that disables auto-resize only when the built-in image path returns the specific omission message and the original file is small enough to send inline safely.
  Rationale: this recovers small images that Photon fails to decode during resize, without changing behavior for larger images that still need resize-based size control.
  Date: 2026-04-01

## Outcomes & Retrospective

The repository now has a repo-local enhanced `read` override under `pi/files` that preserves the built-in text result shape, adds `endLine`, `tail`, `aroundLine`, and `context`, and delegates image files back to pi's built-in image pipeline through a lazy runtime import. The root `package.json` now auto-loads `./pi/files/extensions`, so the override becomes active whenever this repo is used as a pi package.

The most important risk retired during implementation was whether the override could stay plain-Node-testable while still using live pi internals for image fallback. Dependency injection plus lazy `import("@mariozechner/pi-coding-agent")` solved that cleanly. The most useful implementation-time catch was a validator-precedence bug around `aroundLine + tail`; the new targeted tests found it immediately.

Validation is strong but not perfect. The targeted read suite is green (`39` passing tests after the image-retry additions), and the programmatic smoke run proved the three user-facing line-targeting modes on real repo files. The full repository suite still has `7` unrelated failures in `test/extensions/code-review.test.ts`, so the repo is not globally green yet. That does not appear to be caused by this read work, but it should be normalized separately if a fully green baseline is required.

The image follow-up improved one real failure mode but also revealed a deeper one. The extension now retries small omitted images without resize, which restores inline attachments for the Photon failure case. However, the current model/provider stack still rejects at least one grayscale+alpha PNG payload even when the tool returns it successfully. That remaining incompatibility is downstream of the extension and would require either image re-encoding or provider-specific filtering to eliminate completely.

## Context and Orientation

This repository is a pi package workspace with a root `package.json` that currently auto-loads
multiple extension directories under `pi/`, including `./pi/web/extensions`, `./pi/lsp/extensions`,
and several others. Individual feature areas also have their own package manifests, for example
`pi/web/package.json`, which exposes `./extensions` as a standalone pi package entry point.

Tests in this repository follow two patterns. Pure logic tests live next to implementation code,
for example `pi/web/lib/web-search/enrich.test.ts`. Extension registration and behavior tests live
under `test/extensions/`, for example `test/extensions/fetch.test.ts`, and they use the local mock
extension API from `test/helpers.ts` instead of importing live pi runtime code.

The current built-in `read` implementation supports text files and images. For text files it takes
`path`, optional `offset`, and optional `limit`; reads the full file into memory; slices lines;
applies truncation at `2000` lines or `50KB`; and appends continuation notices such as:

    [Showing lines 1-2000 of 4200. Use offset=2001 to continue.]

or, when a user-limited slice ends early:

    [37 more lines in file. Use offset=88 to continue.]

The override in this plan must preserve that style because the model already understands it.

A "normalized read request" in this plan means the effective text window after translating any new
parameters into the canonical `offset` plus `limit` form. Examples:

- `path="README.md", offset=10, endLine=20` normalizes to `offset=10, limit=11`
- `path="README.md", tail=5` normalizes to "last 5 lines of the file" and then to the equivalent
  `offset` plus `limit` after total line count is known
- `path="README.md", aroundLine=100, context=3` normalizes to `offset=97, limit=7`

## Preconditions and Verified Facts

The plan depends on the following repository facts, all re-checked before writing this document.

The root `package.json` currently defines:

- `"test": "node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'"`
- a `pi.extensions` array that includes `./pi/web/extensions` but not yet `./pi/files/extensions`

The repository already contains a pattern for tool implementations and extension tests:

- `pi/web/extensions/fetch.ts`
- `pi/web/lib/fetch-core.ts`
- `test/extensions/fetch.test.ts`
- `test/helpers.ts`

Plain repository tests cannot import `@mariozechner/pi-coding-agent` directly. A direct runtime
import fails with `Cannot find package '@mariozechner/pi-coding-agent' ...`. Type-only imports are
safe because `--experimental-strip-types` removes them, and dynamic imports can still be used in
live pi sessions or hidden behind dependency injection in tests.

Pi extension docs explicitly state:

- registering a tool with the same name as a built-in tool overrides the built-in tool
- omitting custom `renderCall` and `renderResult` on an override reuses the built-in renderer
- `promptSnippet` and `promptGuidelines` must be provided explicitly for custom tools to affect the
  default system prompt

Upstream built-in `read` still exports `createReadToolDefinition(cwd, options?)` and defines
`ReadToolDetails` as an object with optional `truncation` only. Upstream `main` has no newer read
semantics that already solve `tail`, `endLine`, or `aroundLine`.

## Scope Boundaries

In scope are: a repo-local `read` override, a new package area under `pi/files`, backward-compatible
parameter expansion for `read`, tests for the new core and extension behavior, and the root package
wiring needed to auto-load the extension once validated.

Out of scope are: any `write` changes, any permission or access-control policy, any multi-range or
regex-bounded read syntax, any rewrite of built-in image handling, any attempt to upstream the change
as part of this plan, and session-local unchanged-file dedup (deferred to v2 — see Decision Log).

Also out of scope for v1 is custom interactive rendering for the new parameters. The call display
may remain slightly less descriptive than the execution behavior when the user uses `tail` or
`aroundLine`, because the built-in read renderer only knows about `offset` and `limit`. This is an
accepted limitation for the first version.

## Milestones

### Milestone 1: Scaffold a testable package and prove the override wiring

At the end of this milestone, the repository will contain a new `pi/files` package area and a tool
named `read` that can be loaded explicitly with `pi -e ./pi/files/extensions/read.ts`. The tool will
still behave like vanilla `read`, but the code structure will already support injected dependencies so
plain Node tests do not require live pi runtime imports.

This milestone comes first because the biggest repository-specific unknown is not line slicing logic.
It is whether we can structure the override so it is both live-pi-compatible and plain-test-compatible.
That must be retired before deeper behavior work.

### Milestone 2: Add and pin the local text-read core

At the end of this milestone, a pure repo-owned helper module will normalize extended parameters,
resolve paths in a pi-compatible way, generate canonical range labels, and produce the same
truncation and continuation semantics as built-in `read` for text files.

This milestone comes second because everything else depends on stable range planning and text-result
formatting. It also keeps the most reusable behavior under fast unit tests rather than extension-level
tests.

### Milestone 3: Wire image fallback and complete extension behavior

At the end of this milestone, the override will handle text files locally, delegate image files to the
built-in read factory via a dynamically loaded fallback, and expose the full schema (`path`, `offset`,
`limit`, `endLine`, `tail`, `aroundLine`, `context`) from the actual extension entry point.

This milestone comes after the pure core because image fallback and extension registration are only
safe once the local text path is proven.

### Milestone 4: Enable package auto-load and validate in a live pi session

At the end of this milestone, the root package manifest will load `./pi/files/extensions`, the new
behavior will be exercised in a live pi session, and repository docs will mention the new package and
read semantics.

This milestone comes last because it is the only step that changes the user's default global behavior
when this repo is symlinked into pi.

## Plan of Work

Create a new package directory `pi/files` with a small package manifest `pi/files/package.json` that
matches the style of existing package areas such as `pi/web/package.json`. Put the extension entry
point at `pi/files/extensions/read.ts` so its purpose is obvious and so it can be loaded directly via
`pi -e ./pi/files/extensions/read.ts` during development.

In `pi/files/lib/enhanced-read.ts`, implement the pure logic that does not require live pi runtime
imports. This file should own the parameter type, validation, path normalization, range planning,
and continuation-message construction. Keep the functions small and prescriptive: the implementer
should not invent a second abstraction layer unless tests force one.

The local text executor must follow built-in `read` behavior closely. It should read the text file,
split on `\n`, derive the requested line window, and then build output exactly the way built-in `read`
does: the same truncation limit, the same offset-beyond-EOF error wording, the same "use offset=... to
continue" notices, and the same `details.truncation` shape. Only the new request-normalization layer
should differ.

In `pi/files/extensions/read.ts`, register the tool definition. Use a plain JSON-schema-like
`parameters` object as in `pi/web/extensions/fetch.ts`; do not rely on runtime `TypeBox` imports.
Use type-only imports for `ExtensionAPI`. Add explicit `promptSnippet` and `promptGuidelines` that
preserve the built-in advice to prefer `read` over `cat` or `sed`, while also telling the model to
prefer `tail`, `endLine`, and `aroundLine` over bash slicing.

The extension entry point should accept injected dependencies for tests. The default path should load
built-in image fallback lazily inside pi, but tests should be able to pass a fake fallback factory and
fake filesystem operations. That keeps `test/extensions/read.test.ts` deterministic and free of live pi
runtime imports.

Only after all targeted tests and live explicit-extension smoke validation succeed should the root
`package.json` add `./pi/files/extensions` to `pi.extensions`.

## Concrete Steps

All commands in this section are run from the repository root.

1. Create the new package directories and manifest.

    mkdir -p pi/files/extensions pi/files/lib

Create `pi/files/package.json` with the same basic shape as `pi/web/package.json`, exposing:

    {
      "name": "@bromanko/pi-files",
      "version": "1.0.0",
      "type": "module",
      "description": "Enhanced file-reading tools for pi",
      "keywords": ["pi-package"],
      "author": { "name": "bromanko", "email": "hello@bromanko.com" },
      "pi": { "extensions": ["./extensions"] }
    }

Expected result: `pi/files/package.json` exists and mirrors existing package conventions.

2. Add a failing extension registration test first in `test/extensions/read.test.ts`.

Write tests that assert:

- the extension registers exactly one tool named `read`
- the tool schema includes `path`, `offset`, `limit`, `endLine`, `tail`, `aroundLine`, and `context`
- the tool definition sets `promptSnippet`
- the tool definition sets `promptGuidelines`

Follow the same local mock pattern used in `test/extensions/fetch.test.ts`: define a local
`createMockPi()` function that returns an object with a `registerTool` method and a `getTools()`
accessor. Use a type-only import for `ExtensionAPI` from `@mariozechner/pi-coding-agent` and import
the extension from `../../pi/files/extensions/read.ts`.

Run:

    node --experimental-strip-types --test test/extensions/read.test.ts

Expected result: the new test file runs and fails because the extension does not exist yet.

3. Add the minimal extension skeleton in `pi/files/extensions/read.ts`.

Implement a default export that registers a `read` tool with the correct name, schema, prompt text,
and a placeholder `execute` that throws `new Error("Not implemented")`.
Also export a factory such as `createEnhancedReadToolDefinition(deps)` so tests can inspect the tool
without spinning up pi.

Re-run:

    node --experimental-strip-types --test test/extensions/read.test.ts

Expected result: registration and schema assertions pass, and execute-related assertions still fail or
remain unimplemented.

Commit point:

- `feat(read): scaffold enhanced read override package`

Before committing, ensure the targeted test file has no `not ok` lines for the assertions already
implemented.

4. Add a failing pure-core test file at `pi/files/lib/enhanced-read.test.ts`.

Write explicit unit tests for request normalization. Cover exactly these cases:

- `offset=10, endLine=20` normalizes to `offset=10, limit=11`
- `endLine=5` with no `offset` normalizes to `offset=1, limit=5`
- `tail=3` against a 10-line file normalizes to `offset=8, limit=3`
- `tail=20` against a 10-line file normalizes to `offset=1, limit=10`
- `aroundLine=50, context=3` normalizes to `offset=47, limit=7`
- `aroundLine=2, context=5` clamps start to `offset=1, limit=7`
- `aroundLine=99, context=3` against a 100-line file clamps end to `offset=96, limit=5` (the window cannot extend past the last line)
- `context` with no `aroundLine` throws a clear validation error
- `tail` combined with any of `offset`, `limit`, `endLine`, or `aroundLine` throws a clear validation error
- `aroundLine` combined with any of `offset`, `limit`, `endLine`, or `tail` throws a clear validation error
- `limit` and `endLine` together throw a clear validation error
- any non-integer or non-positive numeric argument throws a clear validation error

Run:

    node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts

Expected result: the test file fails before implementation.

5. Implement request normalization in `pi/files/lib/enhanced-read.ts`.

Define at minimum:

    export interface EnhancedReadParams {
      path: string;
      offset?: number;
      limit?: number;
      endLine?: number;
      tail?: number;
      aroundLine?: number;
      context?: number;
    }

    export interface NormalizedReadRequest {
      path: string;
      offset: number;
      limit?: number;
      rangeLabel: string;
    }

Implement functions that:

- validate all numeric parameters as positive integers
- reject incompatible parameter combinations exactly as described in step 4
- compute normalized `offset` and `limit`
- compute a stable `rangeLabel` such as `lines 10-20`, `last 5 lines`, or `lines 47-53`

Re-run:

    node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts

Expected result: normalization tests pass.

6. Extend `pi/files/lib/enhanced-read.test.ts` with path-resolution, text-output, and error-path tests.

Add tests for a local `resolveReadPathLikePi(path, cwd)` helper that covers:

- `~/file.txt` expands to the user home directory
- `@relative/file.txt` strips the leading `@`
- a plain relative path resolves against `cwd`
- when a direct resolved path does not exist but an NFD variant does, the helper returns the
  existing variant. To create this fixture: write a file whose name contains a precomposed Unicode
  character (e.g., `café.txt` using the single codepoint `U+00E9`), then request it using the
  decomposed form (`cafe\u0301.txt` — `e` followed by combining acute accent `U+0301`). On macOS
  HFS+/APFS, the filesystem normalizes to NFD, so the lookup should succeed. Mark this test with
  a `skip` guard on non-Darwin platforms using `process.platform !== "darwin"`.

Add text-read behavior tests using temporary files that cover exactly:

- offset beyond EOF returns an error result containing `Offset <n> is beyond end of file (<m> lines total)`
- user-limited slice appends `[<remaining> more lines in file. Use offset=<n> to continue.]`
- truncation by line limit (more than 2000 lines) appends `[Showing lines <a>-<b> of <m>. Use offset=<n> to continue.]`
- truncation by byte limit: create a temporary file with 100 lines where each line is 600 bytes
  (total ~60KB, exceeding the 50KB limit). Assert that the result is truncated before all 100 lines
  are returned and that the continuation notice appears.
- file not found returns an error result (not an unhandled throw) with a message containing the path
- path is a directory returns an error result (not an unhandled throw)
- file with no read permission returns an error result (not an unhandled throw). Create a temp file,
  `chmod 000` it, attempt the read, then restore permissions in a `finally` block. Skip on Windows.

Run:

    node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts

Expected result: the new assertions fail before the local text executor is implemented.

7. Implement the local text executor in `pi/files/lib/enhanced-read.ts`.

Copy only the small upstream text-path behavior that is required, with comments naming the source file
being mirrored. The specific upstream functions to reference are:

- From `packages/coding-agent/src/core/tools/read.ts`: the text-read path that calls
  `readFile`, splits on `\n`, applies `offset`/`limit`, enforces the `2000`-line and `50KB`
  truncation caps, and builds the continuation-notice strings. Do not copy the image path, the
  binary detection, or the renderer.
- From `packages/coding-agent/src/core/tools/path-utils.ts`: the `resolveReadPath` function
  that handles `~` expansion, leading-`@` stripping, and macOS NFD normalization fallback.

Implement:

- `resolveReadPathLikePi(...)` — mirrors the upstream path-resolution behavior described above
- `executeEnhancedTextRead(...)` — reads text, normalizes extended params, slices, truncates,
  and formats the result
- the built-in `2000`-line and `50KB` truncation behavior for text output
- built-in-style continuation notices
- built-in-style offset-beyond-EOF error text
- structured error results (not unhandled throws) for file-not-found, directory, and permission errors

Re-run:

    node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts

Expected result: all pure-core tests pass.

Commit point:

- `feat(read): add enhanced text read core`

Before committing, the pure-core test file must be green.

8. Extend `test/extensions/read.test.ts` with full extension-behavior tests.

Write tests that create temporary files and call `tool.execute(...)` directly. Cover exactly:

- plain `offset` plus `limit` still behaves like built-in `read`
- `endLine` returns the expected inclusive range
- `tail` returns the expected last-N lines
- `aroundLine` plus `context` returns the expected centered window
- an image-path request delegates to the injected fallback executor when no extended range arguments are used
- an image-path request with `tail`, `endLine`, or `aroundLine` is rejected with a clear message explaining that extended line targeting is text-only
- a request for a known image extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) routes to the fallback; a request for a non-image extension (`.ts`, `.txt`, `.md`) does not
- file-not-found at the extension level returns a structured error result, not an unhandled exception
- an unexpected error inside the text executor is caught and returned as a structured error result

Inject a fake fallback definition instead of importing live pi runtime code.

Run:

    node --experimental-strip-types --test test/extensions/read.test.ts

Expected result: the new behavior tests fail before the extension wiring is complete.

9. Finish `pi/files/extensions/read.ts`.

Implement the actual `execute` logic:

- resolve the file path using the local helper
- detect image files by extension. Copy the exact set from the current built-in `read`
  implementation: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`. Define this set as a named constant
  (e.g., `IMAGE_EXTENSIONS`) with a comment noting the source and that it should be re-checked
  when upgrading pi. If built-in `read` adds formats like `.avif`, `.svg`, or `.bmp` later, the
  constant must be updated to match.
- if the request is an image read with no extended line-targeting arguments, lazily load built-in
  `createReadToolDefinition(...)` and delegate to it
- if the request is an image read with extended line-targeting arguments (`tail`, `endLine`, or
  `aroundLine`), return a structured error explaining that those parameters are text-only
- otherwise, execute the local text path
- wrap the top-level execute in a try/catch so that any unexpected error is returned as a
  structured error result (a `content` array with a text part describing the error), not an
  unhandled exception. `read` is the most critical tool — a crash here is worse than a degraded
  result.

Define explicit prompt text:

- `promptSnippet`: `Read file contents with line targeting (offset/limit, endLine, tail, aroundLine)`
- `promptGuidelines` must include:
  - `Use read to examine files instead of cat or sed.`
  - `Prefer endLine, tail, and aroundLine over bash head/tail/sed when you need line-targeted reads.`

Do not define `renderCall` or `renderResult` in this milestone.

Re-run:

    node --experimental-strip-types --test test/extensions/read.test.ts
    node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts

Expected result: both targeted test files pass.

10. Run the full test suite.

Run:

    npm test

Expected result: all repository tests pass. If unrelated pre-existing failures remain, capture them in the
Surprises & Discoveries section with evidence and do not auto-enable the package until the read-specific
targeted tests are green.

Commit point:

- `feat(read): wire enhanced read override and image fallback`

11. Perform live smoke validation before package auto-load.

If this repository is not already loaded as a pi package in the current environment, run:

    pi -e ./pi/files/extensions/read.ts

If this repository is already package-loaded in the current environment, start `pi` normally from the
repo root. In either case, verify that the startup output contains the built-in override warning. The
expected text is approximately:

    Warning: tool "read" from package overrides built-in tool

(The exact wording may vary by pi version. Grep stderr for `read` and `override` or `built-in`.)

Use these manual prompts exactly:

- `Use read on package.json with endLine=5.`
- `Use read on package.json with tail=5.`
- `Use read on README.md around line 280 with context=2.`

Expected observations:

- the first prompt returns the first five lines of `package.json`
- the second prompt returns the last five lines of `package.json`
- the third prompt returns a five-line window centered on README line `280`

If the implementer is a coding agent rather than a human operator, perform the equivalent validation
programmatically: write a short script (e.g., `pi/files/lib/smoke.ts`) that imports
`createEnhancedReadToolDefinition`, constructs the tool with real filesystem deps and a stubbed image
fallback, calls `execute` with the three parameter combinations above against real repo files, and
asserts the expected line content. Run it with `node --experimental-strip-types pi/files/lib/smoke.ts`.

Capture a short transcript excerpt in this plan's Artifacts and Notes section.

12. Only after live validation succeeds, enable package auto-load.

Edit the root `package.json` and add `"./pi/files/extensions"` to `pi.extensions`.

Re-run:

    npm test

Expected result: tests remain green after the package manifest change.

13. Update documentation.

Update the root `README.md` with a short section describing the new enhanced `read` override and the
new parameters. While editing nearby tool-package references, correct stale `shared/extensions/...`
paths only in the touched sections. Do not broaden this into a repository-wide docs cleanup.

14. Record final evidence.

Update this plan's `Progress`, `Surprises & Discoveries`, `Decision Log`, `Outcomes & Retrospective`,
and `Artifacts and Notes` sections with the final commands run, the pass counts observed, the live
smoke evidence, and any deviations from the planned behavior.

Commit point:

- `docs(read): document and enable enhanced read package`

## Testing and Falsifiability

This plan makes three falsifiable claims.

First, it claims the new tool preserves built-in `read` usability for existing `offset` and `limit`
usage. To falsify that claim, `test/extensions/read.test.ts` must call the new tool with only `path`,
`offset`, and `limit` and compare the result text style against current built-in behavior. If that test
fails, the claim is false.

Second, it claims the tool now supports direct line targeting without bash fallback for common cases.
To falsify that claim, targeted tests must prove that `endLine`, `tail`, and `aroundLine` return the
expected line windows from known temporary files. If any one of those tests fails, the claim is false.

Third, it claims the override handles errors gracefully without crashing the tool. To falsify that
claim, `pi/files/lib/enhanced-read.test.ts` must prove that file-not-found, directory paths, and
permission errors all return structured error results rather than unhandled exceptions, and
`test/extensions/read.test.ts` must prove the same at the extension level. If any of those tests
shows an unhandled throw instead of a structured result, the claim is false.

Run these commands during implementation:

    node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts
    node --experimental-strip-types --test test/extensions/read.test.ts
    npm test

The red phase is required. The new targeted tests must fail before the corresponding implementation
lands and pass afterward.

## Validation and Acceptance

Acceptance is behavioral, not structural.

The feature is accepted when all of the following are true:

- running `node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts test/extensions/read.test.ts`
  shows only passing tests
- running `npm test` from repo root shows the repository test suite green, or documents any unrelated
  pre-existing failures without read-specific regressions
- a live pi session can use `read` with `endLine`, `tail`, and `aroundLine` on real files in this repo
- image reads without new range parameters still behave like built-in image reads
- error cases (file not found, directory, permissions) return structured results, not crashes
- loading the package after the root `package.json` update produces a built-in override warning for
  `read` and the tool remains callable by the LLM

Concrete live acceptance transcript example:

    > Use read on package.json with endLine=5.
    Tool: read package.json
    ...
    {
      "name": "@bromanko/llm-agents",
      "version": "1.0.0",
      "type": "module",
      ...

    > Use read on package.json with tail=5.
    Tool: read package.json
    ...
    (last 5 lines of package.json)

## Rollout, Recovery, and Idempotence

Rollout is intentionally staged. The new extension code is written first but not auto-loaded by the
root package until after tests and live smoke validation pass. That keeps the user's regular pi setup
unchanged during development even though this repository is symlinked into global config.

Recovery is straightforward. If the feature misbehaves after enablement, revert the commit that adds
`"./pi/files/extensions"` to the root `package.json`, or revert the full feature branch. Because the
feature is additive and isolated under `pi/files`, rollback does not require data migration or cleanup.

The implementation is idempotent. Re-running the targeted tests, full suite, and live smoke prompts is
safe.

## Artifacts and Notes

Targeted test transcript after the final fix:

    $ node --experimental-strip-types --test pi/files/lib/enhanced-read.test.ts test/extensions/read.test.ts
    ...
    ℹ tests 39
    ℹ pass 39
    ℹ fail 0

Live retry evidence from `manual-read-image-retry.jsonl`:

    {"role":"toolResult","toolName":"read","content":[
      {"type":"text","text":"Read image file [image/png]"},
      {"type":"image","mimeType":"image/png", ...}
    ]}
    {"role":"assistant","stopReason":"error","errorMessage":"The model returned the following errors: Could not process image"}

Full-suite transcript showing unrelated pre-existing failures:

    $ npm test
    ...
    ℹ tests 539
    ℹ pass 532
    ℹ fail 7
    ✖ failing tests:
    test at test/extensions/code-review.test.ts:114:1
    test at test/extensions/code-review.test.ts:161:1
    ...

Programmatic smoke transcript using `createEnhancedReadToolDefinition(...)`:

    SMOKE:endLine
    {
      "name": "@bromanko/llm-agents",
      "version": "1.0.0",
      "type": "module",
      "description": "Pi extensions, skills, and tools",
      ...

    SMOKE:tail
        "themes": [
          "./pi/themes"
        ]
      }
    }

    SMOKE:around
    No external testing dependencies are required. Tests use Node.js built-ins (`node:test`, `node:assert/strict`) and TypeScript support from `--experimental-strip-types`.

    ## Pi enhanced read tool

Final root `package.json` excerpt:

    "pi": {
      "extensions": [
        "./pi/chrome-devtools-mcp/extensions",
        "./pi/ci-guard/extensions",
        "./pi/code-review/extensions",
        "./pi/design-studio/extensions",
        "./pi/files/extensions",
        ...
      ]
    }

## Interfaces and Dependencies

In `pi/files/lib/enhanced-read.ts`, define and export at least these stable interfaces:

    export interface EnhancedReadParams {
      path: string;
      offset?: number;
      limit?: number;
      endLine?: number;
      tail?: number;
      aroundLine?: number;
      context?: number;
    }

    export interface NormalizedReadRequest {
      path: string;
      offset: number;
      limit?: number;
      rangeLabel: string;
    }

    export interface EnhancedReadDeps {
      readFile(path: string): Promise<Buffer>;
      stat(path: string): Promise<{ size: number; mtimeMs: number }>;
      access(path: string): Promise<void>;
    }

    export function normalizeReadRequest(
      params: EnhancedReadParams,
      totalLines: number,
    ): NormalizedReadRequest;

    export function resolveReadPathLikePi(path: string, cwd: string): string;

    export async function executeEnhancedTextRead(
      cwd: string,
      params: EnhancedReadParams,
      deps?: Partial<EnhancedReadDeps>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details?: { truncation?: unknown } }>;

    /** Known image extensions that delegate to the built-in read pipeline.
     *  Copied from packages/coding-agent/src/core/tools/read.ts — re-check on pi upgrade. */
    export const IMAGE_EXTENSIONS: ReadonlySet<string>;
In `pi/files/extensions/read.ts`, export:

    export interface ReadToolDeps {
      createImageReadFallback?: (cwd: string) => Promise<{
        execute: (
          toolCallId: string,
          params: { path: string; offset?: number; limit?: number },
          signal?: AbortSignal,
          onUpdate?: unknown,
          ctx?: unknown,
        ) => Promise<{ content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown }>;
      }>;
    }

    export function createEnhancedReadToolDefinition(deps?: ReadToolDeps): {
      name: "read";
      parameters: Record<string, unknown>;
      promptSnippet: string;
      promptGuidelines: string[];
      execute: (...args: unknown[]) => Promise<unknown>;
    };

The default dependency path for `createImageReadFallback` should lazily import pi runtime code and
construct a built-in `createReadToolDefinition(cwd)` instance. Tests must inject a fake fallback so
plain Node never tries to import `@mariozechner/pi-coding-agent`.
