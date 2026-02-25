# Add a first-party `fetch` tool to this pi package (MVP before search)

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, the local pi package in this repository will provide a custom `fetch` tool that can retrieve URL content directly for the model. This closes the current gap in vanilla pi (which does not include a built-in fetch tool) and gives us the core primitive we need before building search.

A user should be able to ask pi to fetch a URL and get a clean, bounded response containing status, content type, final URL, and readable content. The output must be safely truncated so large pages do not blow out context.

## Progress

- [x] (2026-02-25 18:10Z) Verified upstream pi built-in tools do not include `fetch`.
- [x] (2026-02-25 18:12Z) Researched custom tool and truncation requirements in `docs/extensions.md` and extension examples.
- [x] (2026-02-25 18:14Z) Audited this repository’s extension layout and selected integration points.
- [x] (2026-02-25 19:27Z) Added failing core tests in `shared/extensions/fetch-core.test.ts` and confirmed red phase (`7` failing tests before implementation).
- [x] (2026-02-25 19:32Z) Implemented `shared/extensions/fetch-core.ts` (URL validation/normalization, timeout handling, content transforms, truncation metadata + temp-file spill) and confirmed green phase (`7` passing tests).
- [x] (2026-02-25 19:34Z) Added failing tool tests in `shared/extensions/fetch.test.ts` and confirmed red phase (missing export / tool implementation).
- [x] (2026-02-25 19:37Z) Implemented `shared/extensions/fetch.ts` tool registration, envelope formatting, and lightweight renderers; confirmed green phase (`4` passing tool tests).
- [x] (2026-02-25 19:41Z) Ran full suite (`npm test`, now `85` passing tests), ran manual `pi` smoke prompt with extension loaded, and documented behavior/limits in `README.md`.

## Surprises & Discoveries

- Observation: upstream pi intentionally keeps core tools minimal; `fetch` is not built in.
  Evidence: `/nix/store/.../pi-coding-agent/README.md` built-in tool list (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`).

- Observation: pi extension guidance explicitly requires output truncation discipline for custom tools.
  Evidence: `docs/extensions.md` and example `examples/extensions/truncated-tool.ts`.

- Observation: oh-my-pi does not expose fetch as a separately installable extension package; fetch is implemented inside its coding-agent codebase.
  Evidence: `/tmp/oh-my-pi/packages/coding-agent/src/tools/fetch.ts`.

- Observation: this repository’s `node --experimental-strip-types` test environment does not resolve runtime imports for `@mariozechner/pi-coding-agent` or `@sinclair/typebox`.
  Evidence: direct import probes returned `Cannot find package ...` errors; implementation had to avoid hard runtime imports while still preserving extension API shape.

- Observation: manual live fetch of `https://example.com` in this environment returned `502` due certificate verification/proxy behavior, but the tool still produced the expected metadata envelope structure.
  Evidence: smoke output included `URL`, `Final URL`, `Status: 502`, `Content-Type`, and `Method` header lines.

## Decision Log

- Decision: implement fetch directly under `shared/extensions` instead of creating a new standalone package.
  Rationale: this repository is already one pi package with shared extension roots, and the feature does not need independent packaging.
  Date: 2026-02-25

- Decision: tool name will be `fetch` (exact), not `web_fetch`.
  Rationale: users already think in terms of a `fetch` primitive; this matches the eventual parity goal with oh-my-pi.
  Date: 2026-02-25

- Decision: MVP scope is text-oriented HTTP fetching (HTML, markdown/plain text, JSON), with robust truncation and metadata; binary/PDF conversion is deferred.
  Rationale: this delivers immediate value for coding workflows while minimizing early complexity.
  Date: 2026-02-25

- Decision: use TDD for implementation and lock behavior through tests before wiring UI/documentation.
  Rationale: fetch behavior has many edge-cases (timeouts, redirects, truncation, content-type handling) that are safer to pin with tests first.
  Date: 2026-02-25

- Decision: avoid hard runtime imports of `@mariozechner/pi-coding-agent` truncation helpers and `@sinclair/typebox` in extension runtime code loaded by unit tests.
  Rationale: those packages are not resolvable in the repo’s plain Node test environment; preserving passing tests required a dependency-light implementation with equivalent behavior.
  Date: 2026-02-25

- Decision: expose `createFetchToolDefinition(fetchImpl)` and `formatFetchEnvelope()` from `shared/extensions/fetch.ts`.
  Rationale: dependency injection enables deterministic tool tests without network I/O while keeping the production extension wiring unchanged (`default` export still registers the real tool).
  Date: 2026-02-25

## Outcomes & Retrospective

Completed the full MVP described by this plan. The repository now has a new fetch core module (`shared/extensions/fetch-core.ts`), a registered `fetch` extension tool (`shared/extensions/fetch.ts`), and focused tests for both layers (`shared/extensions/fetch-core.test.ts`, `shared/extensions/fetch.test.ts`).

Behavior achieved: URL normalization, HTTP(S)-only validation, deterministic timeout messaging, JSON pretty-printing, conservative HTML-to-text conversion, passthrough plain text handling, line/byte truncation, and full-output spill files when truncation occurs. The tool-level envelope now consistently returns URL/status/content-type/method metadata above the body.

Validation outcome: targeted red/green cycles were completed for core and tool layers, and full suite validation now passes with `npm test` (`85` passing tests). Manual `pi` smoke invocation with the extension loaded confirmed live tool registration and envelope formatting; in this environment the upstream request returned `502`, so semantic content validation for `example.com` relied primarily on deterministic local server tests.

## Context and Orientation

This repository is a single pi package rooted at `/home/bromanko.linux/Code/llm-agents`.

The main package manifest is `package.json` at repo root. It currently exposes extensions from:

- `./packages/jj/extensions`
- `./packages/tmux-titles/extensions`
- `./packages/code-review/extensions`
- `./shared/extensions`

The fetch implementation should live in `shared/extensions` so it is auto-exported with the existing package configuration.

Existing extension examples in this repo (`shared/extensions/*.ts`, `packages/*/extensions/*.ts`) use `ExtensionAPI` from `@mariozechner/pi-coding-agent` and register commands/hooks/tools directly.

The fetch implementation must align with upstream pi extension APIs documented in:

- `/nix/store/.../docs/extensions.md`
- `/nix/store/.../examples/extensions/truncated-tool.ts`

Key constraints to preserve:

- Custom tool outputs must be bounded (line and byte limits).
- Tool response should be model-readable and deterministic.
- URL handling must reject non-HTTP(S) schemes.
- Implementation should be additive and not alter existing jj/review/tmux behavior.

## Plan of Work

We will implement fetch in three layers.

First, add a shared core module at `shared/extensions/fetch-core.ts` that performs URL normalization/validation, request execution with timeout, content transformation, and truncation bookkeeping.

Second, add tests first (red phase) for core behavior, then implement until those tests pass (green phase).

Third, register a `fetch` custom tool in `shared/extensions/fetch.ts` that maps tool params to the core module and returns a consistent textual envelope plus structured `details` object. Add tool-level tests first (red) and then implement (green).

After behavior is stable, add a short `README.md` section documenting invocation, limits, and non-goals.

## Concrete Steps

From repository root (`/home/bromanko.linux/Code/llm-agents`):

1. Create fetch files in shared extensions.

    touch shared/extensions/fetch-core.ts
    touch shared/extensions/fetch.ts
    touch shared/extensions/fetch-core.test.ts
    touch shared/extensions/fetch.test.ts

Expected result: new fetch implementation and test files exist in the shared extension path.

2. Write failing core tests first (TDD red phase) in `shared/extensions/fetch-core.test.ts`.

Cover exactly:

- URL normalization adds `https://` when no scheme is given.
- Non-HTTP schemes are rejected.
- Timeout produces a deterministic timeout error message.
- JSON content is pretty-printed.
- HTML content is transformed to readable text.
- Plain text passes through.
- Truncation metadata is populated when output exceeds limits.

Use an in-test Node HTTP server (`node:http`) so tests do not depend on Python or external network availability.

Run:

    node --experimental-strip-types --test shared/extensions/fetch-core.test.ts

Expected result: tests fail before implementation.

3. Implement core behavior in `shared/extensions/fetch-core.ts` (TDD green phase).

Implement:

- URL parsing/normalization.
- Scheme allowlist (`http`, `https`).
- Timeout handling with `AbortController`.
- Request metadata capture (status, final URL, content type).
- Transform pipeline:
  - `application/json` => pretty JSON
  - `text/*` and markdown => as-is
  - `text/html` => readable text extraction (conservative cleanup)
  - fallback => textual best effort
- Truncation via exported pi utilities (`truncateHead` + metadata).
- Optional full-output temp file path when truncated.

Re-run:

    node --experimental-strip-types --test shared/extensions/fetch-core.test.ts

Expected result: all core tests pass.

4. Write failing tool tests first (TDD red phase) in `shared/extensions/fetch.test.ts`.

Test that the extension:

- Registers a tool named `fetch`.
- Exposes parameters: `url`, `timeout`, `raw`, `maxBytes`, `maxLines`.
- Returns a response envelope containing URL/status/content-type metadata.
- Includes truncation notice when core returns truncated output.

Run:

    node --experimental-strip-types --test shared/extensions/fetch.test.ts

Expected result: tests fail before tool implementation.

5. Implement tool registration in `shared/extensions/fetch.ts` (TDD green phase).

Use `pi.registerTool` with `Type.Object` parameters and delegate execution to `fetchUrl` from `fetch-core.ts`.

Return content format:

- Header lines: URL, final URL (if redirected), status, content type, method used.
- Separator line.
- Body content (possibly truncated).
- Truncation notice with full output path when applicable.

Add lightweight `renderCall` and `renderResult` so interactive mode shows compact status.

Re-run:

    node --experimental-strip-types --test shared/extensions/fetch.test.ts

Expected result: tool tests pass.

6. Run full test suite and perform manual smoke check.

Run suite:

    npm test

Then run pi with this extension and perform one manual smoke check:

    pi --extension ./shared/extensions/fetch.ts

Prompt:

- “Use the `fetch` tool on https://example.com and report the page title.”

Expected result: tool call succeeds and output includes metadata plus readable body containing “Example Domain”.

7. Document behavior and limits.

Update root `README.md` with a short section describing:

- `fetch` tool purpose
- supported content types for MVP
- truncation behavior
- known non-goals (binary/PDF conversion deferred)

Expected result: users know how to invoke and what to expect.

## Validation and Acceptance

Acceptance is behavior-based.

1. Tool registration: when pi starts with this repository package loaded, `fetch` appears in available tool list.

2. Basic fetch: fetching a known HTML page returns a successful response with status, content-type, and readable body text.

3. JSON fetch: fetching JSON returns pretty-printed JSON content and correct metadata.

4. Truncation: oversized content reports truncation details and full-output path hint.

5. Safety: fetching `file:///etc/passwd` (or another non-http scheme) returns a clear validation error and does not attempt request execution.

6. Timeout: fetching a delayed endpoint with a small timeout returns an explicit timeout error.

Validation commands:

    node --experimental-strip-types --test shared/extensions/fetch-core.test.ts
    node --experimental-strip-types --test shared/extensions/fetch.test.ts
    npm test

Manual confirmation:

    pi --extension ./shared/extensions/fetch.ts

Use the prompt above and confirm expected output.

## Idempotence and Recovery

This plan is additive. Re-running file creation/edit steps is safe if implementers overwrite only planned files.

If a test fails:

- Re-run only the failing test file first.
- Keep the in-test local server approach; do not switch to external URLs for test assertions.
- Reduce limits (`maxBytes`/`maxLines`) in a focused test to debug truncation deterministically.

No migration, destructive file operations, or irreversible repository changes are required.

## Artifacts and Notes

Expected successful metadata header example:

    URL: https://example.com
    Status: 200
    Content-Type: text/html
    Method: html

Expected truncation marker example:

    [Output truncated: showing 2000 of 6423 lines (50KB of 188KB). Full output saved to: /tmp/pi-fetch-XXXX/output.txt]

Observed manual smoke transcript (first 8 lines requested from live tool output):

    URL: https://example.com
    Final URL: https://example.com/
    Status: 502
    Content-Type: text/html
    Method: html

    ---

Future parity with oh-my-pi’s advanced fetch pipeline (llms endpoints, site-specific handlers, binary conversion) is intentionally deferred to a follow-up plan.

## Interfaces and Dependencies

In `shared/extensions/fetch-core.ts`, define:

    export interface FetchRequest {
      url: string;
      timeoutSeconds?: number;
      raw?: boolean;
      maxBytes?: number;
      maxLines?: number;
    }

    export interface FetchResponse {
      requestUrl: string;
      finalUrl: string;
      status: number;
      contentType: string;
      method: "text" | "json" | "html" | "raw" | "fallback";
      content: string;
      truncated: boolean;
      fullOutputPath?: string;
      notes: string[];
    }

    export async function fetchUrl(request: FetchRequest): Promise<FetchResponse>;

In `shared/extensions/fetch.ts`, register:

- Tool name: `fetch`
- Label: `Fetch`
- Parameters: `url`, `timeout`, `raw`, `maxBytes`, `maxLines`
- `execute` delegates to `fetchUrl` and formats a model-readable envelope
- Optional `renderCall`/`renderResult` for compact TUI display

Dependencies:

- `@mariozechner/pi-coding-agent` (type import for `ExtensionAPI`; runtime-provided by pi).
- Node built-ins only for core logic and tests (`node:fs`, `node:os`, `node:path`, `node:http`, `node:test`, `node:assert/strict`).
- No additional npm runtime dependency added for MVP; schema is represented as plain JSON-schema-compatible objects to keep local unit tests dependency-free.
