# Add a Brave-first `web_search` tool with `fetch` enrichment to this pi package

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, pi sessions using this repository package will have a `web_search` tool that can discover current web sources via Brave Search and optionally enrich top results with content fetched through the existing local fetch pipeline.

A user should be able to run one tool call and receive bounded, structured output (`Sources`, `Meta`, optional `Warnings`) with stable citations and optional fetched excerpts. This gives practical web capability now (Brave retrieval + current model reasoning in-session) without waiting for Anthropic/Codex provider-native adapters.

## Progress

- [x] (2026-02-25 20:58Z) Confirmed upstream pi has no built-in `web_search` tool.
- [x] (2026-02-25 21:01Z) Reviewed extension/tool APIs and truncation requirements in upstream pi docs/examples.
- [x] (2026-02-25 21:04Z) Audited local package layout and test runner (`npm test` + Node strip-types).
- [x] (2026-02-26 00:58Z) Revised plan after ExecPlan review: resolved dependency/tooling ambiguity, added explicit milestones, commit points, fixture contract, and fetch-core integration details.
- [x] (2026-02-26 02:11Z) Completed Milestone 1: implemented `types.ts`, `core.ts`, `providers/base.ts`, `providers/brave.ts`, fixtures, and passing core/provider tests (`17` passing).
- [x] (2026-02-26 02:14Z) Completed Milestone 2: implemented `enrich.ts` with bounded options + graceful degradation and passing enrichment tests (`8` passing).
- [x] (2026-02-26 02:16Z) Completed Milestone 3: implemented `index.ts` tool registration/envelope/rendering and passing extension tests (`7` passing).
- [x] (2026-02-26 02:19Z) Ran full validation (`npm test`: `200` passing).
- [x] (2026-02-26 02:20Z) Updated `README.md` with Brave-first `web_search` usage/env/parameter docs and v2 scope note.
- [ ] Milestone 4 remaining: optional manual Brave smoke check with real API key in target runtime.

## Surprises & Discoveries

- Observation: upstream pi is intentionally minimal; `web_search` is not a built-in tool.
  Evidence: upstream README built-in tool list includes only `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`.

- Observation: adding helper `.ts` files directly under `shared/extensions/` risks accidental auto-loading as extensions.
  Evidence: pi extension discovery includes `extensions/*.ts` and `extensions/*/index.ts`.

- Observation: this repository’s plain Node test environment does not resolve runtime imports for `@mariozechner/pi-coding-agent`, `@sinclair/typebox`, or `@mariozechner/pi-ai`.
  Evidence: local resolution probes fail and the prior fetch plan documented the same constraint.

- Observation: `shared/extensions/fetch.ts` referenced `../lib/fetch-core.ts`, but that module was absent in this workspace.
  Evidence: pre-implementation read checks showed no `shared/lib/fetch-core.ts` file; implementation added it so `fetch` and web-search enrichment can share one fetch core.

## Decision Log

- Decision: v1 implements Brave retrieval first, with only one shipped retrieval backend (`brave`).
  Rationale: Brave is the lowest-risk retrieval API and delivers immediate value.
  Date: 2026-02-25

- Decision: include `fetch` enrichment in v1 behind explicit parameters and strict limits.
  Rationale: quality improves with excerpts, while bounded defaults preserve reliability.
  Date: 2026-02-25

- Decision: implement as a subdirectory extension at `shared/extensions/web-search/index.ts`.
  Rationale: avoids accidental auto-loading of helper files as standalone extensions.
  Date: 2026-02-25

- Decision: use dedicated provider fixture tests in `shared/extensions/web-search/providers/brave.test.ts` (not mixed into `core.test.ts`).
  Rationale: removes ambiguity and keeps provider parsing contracts explicit.
  Date: 2026-02-26

- Decision: avoid runtime dependency on TypeBox/StringEnum in v1; use a strict JSON-schema-like object literal in `index.ts`.
  Rationale: keeps tests runnable in this repository’s Node strip-types environment with zero new dependency setup.
  Date: 2026-02-26

- Decision: enrichment default adapter must call the local fetch core (`shared/lib/fetch-core.ts` `fetchUrl`).
  Rationale: avoids duplicate timeout/truncation logic and stays DRY.
  Date: 2026-02-26

- Decision: add `shared/lib/fetch-core.ts` to this workspace before web-search enrichment wiring.
  Rationale: `shared/extensions/fetch.ts` already depended on this path; adding it unblocks shared fetch behavior for both tools.
  Date: 2026-02-26

- Decision: fixed limits for v1 are `limit` clamp `1..10` (default `5`), `fetchTop` clamp `0..5` (default `0`), `maxExcerptChars=600`, `perSourceTimeoutMs=6000`.
  Rationale: explicit limits reduce ambiguity and prevent context blowups.
  Date: 2026-02-26

## Outcomes & Retrospective

Milestone 1 outcome (2026-02-26): provider-agnostic core and Brave provider are implemented with fixture-driven parsing and deterministic errors. `core.test.ts` + `providers/brave.test.ts` pass (`17` tests).

Milestone 2 outcome (2026-02-26): enrichment is implemented with strict bounds, partial-failure warnings, and non-fatal fallback behavior. `enrich.test.ts` passes (`8` tests).

Milestone 3 outcome (2026-02-26): `web_search` extension wiring is complete with strict schema, execution pipeline (core + enrichment), and compact renderer output. `index.test.ts` passes (`7` tests).

Milestone 4 status (2026-02-26): full suite passes (`npm test`, `200` passing) and README docs were updated. Remaining optional step is a live Brave smoke check in target runtime with real credentials.

## Context and Orientation

This repository is a single pi package rooted at `/home/bromanko.linux/Code/llm-agents`.

The root `package.json` exports extensions from:

- `./packages/jj/extensions`
- `./packages/tmux-titles/extensions`
- `./packages/code-review/extensions`
- `./shared/extensions`

Anything under `shared/extensions` can be auto-discovered. To keep helper modules from loading as separate extensions, this feature lives in one directory with a single extension entrypoint:

- `shared/extensions/web-search/index.ts` (extension entrypoint)
- `shared/extensions/web-search/core.ts` (provider-independent orchestration)
- `shared/extensions/web-search/enrich.ts` (fetch enrichment orchestration)
- `shared/extensions/web-search/types.ts` (shared types)
- `shared/extensions/web-search/providers/base.ts` (provider interface)
- `shared/extensions/web-search/providers/brave.ts` (Brave adapter)
- `shared/extensions/web-search/core.test.ts`
- `shared/extensions/web-search/enrich.test.ts`
- `shared/extensions/web-search/index.test.ts`
- `shared/extensions/web-search/providers/brave.test.ts`
- `shared/extensions/web-search/providers/__fixtures__/brave-web-search.success.json`
- `shared/extensions/web-search/providers/__fixtures__/brave-web-search.missing-fields.json`

Existing fetch functionality already exists in:

- `shared/lib/fetch-core.ts` (`fetchUrl`)
- `shared/extensions/fetch.ts` (tool wiring)

All enrichment implementation must reuse `fetchUrl` through an adapter.

## Plan of Work

### Milestone 1: Core search orchestration and Brave provider

Implement stable types, parameter validation, provider resolution, Brave request/response mapping, and bounded source formatting. By the end of this milestone, core and provider tests pass with no network calls in tests.

Acceptance for Milestone 1:

- `core.test.ts` and `providers/brave.test.ts` pass.
- `provider:auto` resolves to Brave when `BRAVE_API_KEY` is set.
- Missing key returns deterministic actionable error text.
- Brave parsing behavior is fixture-driven and deterministic.

### Milestone 2: Fetch enrichment

Add optional enrichment of top N sources by calling local fetch core with strict timeout and excerpt limits. Failures must degrade gracefully and produce warnings without breaking base search results.

Acceptance for Milestone 2:

- `enrich.test.ts` passes.
- `enrich=false` leaves sources unchanged.
- per-source failures set `fetchError` and aggregate warnings.

### Milestone 3: Extension registration and output envelope

Register `web_search` tool with strict schema object, execute core + optional enrichment, and render compact call/result components.

Acceptance for Milestone 3:

- `index.test.ts` passes.
- Tool name is exactly `web_search`.
- Output contains `## Sources` and `## Meta`, and `## Warnings` when needed.

### Milestone 4: Full validation and docs

Run full suite, perform manual smoke checks, and document behavior in root README with explicit v1 scope and v2 deferrals.

Acceptance for Milestone 4:

- `npm test` passes.
- Manual smoke succeeds with Brave key, or constrained-network fallback criteria are met.
- README documents env var and parameters clearly.

## Concrete Steps

From repository root (`/home/bromanko.linux/Code/llm-agents`), execute steps in order.

1. Create the web-search directory and files.

    mkdir -p shared/extensions/web-search/providers/__fixtures__
    touch shared/extensions/web-search/index.ts
    touch shared/extensions/web-search/core.ts
    touch shared/extensions/web-search/enrich.ts
    touch shared/extensions/web-search/types.ts
    touch shared/extensions/web-search/providers/base.ts
    touch shared/extensions/web-search/providers/brave.ts
    touch shared/extensions/web-search/core.test.ts
    touch shared/extensions/web-search/enrich.test.ts
    touch shared/extensions/web-search/index.test.ts
    touch shared/extensions/web-search/providers/brave.test.ts
    touch shared/extensions/web-search/providers/__fixtures__/brave-web-search.success.json
    touch shared/extensions/web-search/providers/__fixtures__/brave-web-search.missing-fields.json

Expected result: all files exist under one extension directory.

2. Add provider fixtures.

In `shared/extensions/web-search/providers/__fixtures__/brave-web-search.success.json`, include a representative Brave web response with at least 3 results, title/url/description/age/date fields, and a request id.

In `shared/extensions/web-search/providers/__fixtures__/brave-web-search.missing-fields.json`, include malformed/partial items (missing title/url/description/date) to verify defensive parsing.

Expected result: fixture files can be loaded in tests without network.

3. Write failing core tests (red) in `shared/extensions/web-search/core.test.ts`.

Write exactly 8 tests:

- empty query rejected with deterministic message
- `limit` below min clamps to 1
- `limit` above max clamps to 10
- default `limit` is 5
- provider `auto` resolves to Brave when available
- explicit `provider=brave` uses Brave
- no providers available returns deterministic `SearchProviderError`
- formatted output applies snippet truncation marker when snippet exceeds bound

Run:

    node --experimental-strip-types --test shared/extensions/web-search/core.test.ts

Expected result: `8` failing tests before implementation.

4. Implement types and base provider contracts.

In `shared/extensions/web-search/types.ts`, define:

- `SearchProviderId = "brave"`
- `SearchRecency = "day" | "week" | "month" | "year"`
- `SearchSource`, `SearchResponse`, `SearchProviderError`
- enrichment fields (`fetchedExcerpt?`, `fetchedAt?`, `fetchError?`)

In `shared/extensions/web-search/providers/base.ts`, define:

- `SearchParams` with `query`, `limit`, `recency`, `signal`
- `SearchProvider` interface with `id`, `label`, `isAvailable()`, `search()`

Expected result: compile-time contracts are complete.

5. Implement core orchestration in `shared/extensions/web-search/core.ts`.

Add:

- `normalizeSearchInput()` implementing clamps/defaults (`limit 1..10`, default `5`)
- provider resolution (`auto` then first available provider)
- deterministic no-provider error
- bounded text formatting helpers for source snippet length

Run:

    node --experimental-strip-types --test shared/extensions/web-search/core.test.ts

Expected result: `8` passing tests.

6. Commit Milestone 1A core scaffolding.

Commit when step 5 is green.

Suggested commit message:

    feat(web-search): add core types and provider-agnostic search orchestration

7. Write failing Brave provider tests (red) in `shared/extensions/web-search/providers/brave.test.ts`.

Write exactly 9 tests:

- `isAvailable()` false when `BRAVE_API_KEY` missing
- `isAvailable()` true when key present
- request includes query and clamped limit
- recency mapping: `day/week/month/year` -> Brave freshness `pd/pw/pm/py`
- success fixture parses into normalized `SearchSource[]`
- missing-fields fixture skips invalid items safely
- non-200 response throws `SearchProviderError` with status
- network error wraps in deterministic provider error
- request id from response metadata is propagated

Run:

    node --experimental-strip-types --test shared/extensions/web-search/providers/brave.test.ts

Expected result: `9` failing tests before implementation.

8. Implement Brave adapter in `shared/extensions/web-search/providers/brave.ts`.

Implement:

- key lookup from `BRAVE_API_KEY`
- GET call to `https://api.search.brave.com/res/v1/web/search`
- recency mapping to Brave freshness values
- fixture-compatible parser into normalized sources
- robust `SearchProviderError` wrapping with HTTP status

Run:

    node --experimental-strip-types --test shared/extensions/web-search/providers/brave.test.ts

Expected result: `9` passing tests.

9. Re-run core + provider tests together.

    node --experimental-strip-types --test shared/extensions/web-search/core.test.ts shared/extensions/web-search/providers/brave.test.ts

Expected result: `17` passing tests.

10. Commit Milestone 1B Brave provider.

Suggested commit message:

    feat(web-search): add Brave provider with fixture-driven parsing and errors

11. Write failing enrichment tests (red) in `shared/extensions/web-search/enrich.test.ts`.

Write exactly 8 tests:

- `enrich=false` returns unchanged sources
- `fetchTop=0` returns unchanged sources
- `fetchTop` above 5 clamps to 5
- only first `fetchTop` sources are enriched
- per-source fetch failure sets `fetchError` and keeps source
- global adapter throw returns unchanged sources + warning
- excerpt sanitized/truncated to `maxExcerptChars` (default 600)
- per-source timeout option is passed to fetch adapter

Run:

    node --experimental-strip-types --test shared/extensions/web-search/enrich.test.ts

Expected result: `8` failing tests before implementation.

12. Implement enrichment in `shared/extensions/web-search/enrich.ts`.

Implement `enrichSourcesWithFetch(sources, options, fetchFn)` and default fetch adapter:

- default adapter imports `fetchUrl` from `../../lib/fetch-core.ts`
- adapter call mapping:
  - `url: source.url`
  - `timeoutSeconds: perSourceTimeoutMs / 1000`
  - `raw: false`
  - `maxBytes: 12 * 1024`
  - `maxLines: 200`
- bounds/defaults:
  - `enrich=false`
  - `fetchTop=0`
  - clamp `fetchTop` to `0..5`
  - `perSourceTimeoutMs=6000`
  - `maxExcerptChars=600`

Run:

    node --experimental-strip-types --test shared/extensions/web-search/enrich.test.ts

Expected result: `8` passing tests.

13. Commit Milestone 2 enrichment.

Suggested commit message:

    feat(web-search): add optional fetch enrichment with bounded excerpts

14. Write failing extension tests (red) in `shared/extensions/web-search/index.test.ts`.

Using `test/helpers.ts` (`createMockExtensionAPI`), write exactly 7 tests:

- registers one tool named `web_search`
- schema has `query`, `provider`, `recency`, `limit`, `enrich`, `fetchTop`
- schema sets `query` required and `additionalProperties=false`
- execution with happy path returns envelope containing `## Sources` and `## Meta`
- warnings path includes `## Warnings`
- missing Brave key returns actionable error text
- `renderCall` and `renderResult` return compact readable strings

Run:

    node --experimental-strip-types --test shared/extensions/web-search/index.test.ts

Expected result: `7` failing tests before implementation.

15. Implement extension entrypoint in `shared/extensions/web-search/index.ts`.

Register tool:

- name: `web_search`
- label: `Web Search`
- schema: strict object literal (no TypeBox dependency)
- fields:
  - `query` required string
  - `provider`: enum `auto|brave`
  - `recency`: enum `day|week|month|year`
  - `limit`: number
  - `enrich`: boolean default false
  - `fetchTop`: number default 0

Execution behavior:

- normalize input using core
- resolve provider and execute search
- optionally enrich sources
- return bounded markdown envelope with sections:
  - `## Sources`
  - `## Meta`
  - optional `## Warnings`

Add `renderCall` and `renderResult` compact output similar to existing `fetch.ts` style.

Run:

    node --experimental-strip-types --test shared/extensions/web-search/index.test.ts

Expected result: `7` passing tests.

16. Run all new web-search tests together.

    node --experimental-strip-types --test \
      shared/extensions/web-search/core.test.ts \
      shared/extensions/web-search/providers/brave.test.ts \
      shared/extensions/web-search/enrich.test.ts \
      shared/extensions/web-search/index.test.ts

Expected result: `32` passing tests.

17. Commit Milestone 3 extension wiring.

Suggested commit message:

    feat(web-search): register web_search tool and output envelope

18. Run full repository suite.

    npm test

Expected result: all repository tests pass.

19. Manual smoke check with Brave API key.

    export BRAVE_API_KEY="..."
    pi --extension ./shared/extensions/web-search/index.ts

Prompt A:

- “Use `web_search` for ‘latest TypeScript 5.7 release notes’, return top 5 sources, and summarize key changes with links.”

Prompt B:

- “Use `web_search` with `enrich=true` and `fetchTop=2` for the same query; include excerpts.”

Expected result: Prompt A returns bounded sources/meta; Prompt B includes excerpts for top sources.

20. Constrained-network fallback validation (if live smoke cannot reach Brave due proxy/cert/network restrictions).

If live Brave calls fail for environment reasons, treat Milestone 4 as valid when all conditions hold:

- step 18 (`npm test`) passes
- Brave provider unit tests (fixture + mocked fetch) pass
- manual invocation returns a clear actionable provider/network error envelope instead of crashing

Expected result: deterministic behavior validated without requiring external network success.

21. Commit Milestone 4 docs and validation updates.

Suggested commit message:

    docs(web-search): document Brave-first tool usage and v2 provider roadmap

22. Update this ExecPlan’s living sections.

After each stopping point, update:

- `Progress` with timestamped completion status
- `Surprises & Discoveries` with evidence snippets
- `Decision Log` for any changed design choices
- `Outcomes & Retrospective` at each milestone completion

Expected result: the plan remains restartable as a standalone source of truth.

## Validation and Acceptance

Behavioral acceptance criteria:

1. `web_search` is discoverable when loaded via `pi --extension ./shared/extensions/web-search/index.ts`.
2. With `BRAVE_API_KEY` set, calls return normalized bounded sources with provider metadata.
3. Missing key produces: `Error: BRAVE_API_KEY not found. Set it in environment before using web_search.`
4. `provider:auto` resolves to Brave when available.
5. `recency` and `limit` affect request mapping and output count.
6. With `enrich=true` and `fetchTop>0`, top sources receive bounded excerpts when fetch succeeds.
7. Enrichment failures do not fail whole response; warnings are emitted.
8. Output truncation is explicit when snippet/excerpt caps are applied.

Validation commands:

    node --experimental-strip-types --test shared/extensions/web-search/core.test.ts
    node --experimental-strip-types --test shared/extensions/web-search/providers/brave.test.ts
    node --experimental-strip-types --test shared/extensions/web-search/enrich.test.ts
    node --experimental-strip-types --test shared/extensions/web-search/index.test.ts
    npm test

## Idempotence and Recovery

This plan is additive and safe to rerun.

- Unit tests are deterministic and network-free.
- Brave live smoke is optional for final confidence but not required for deterministic CI-style validation.
- If a step fails, rerun only the affected test file before broader suite runs.
- Enrichment tests must use injected mock adapters; do not depend on external URLs.
- No destructive repository operations are required.

## Artifacts and Notes

Expected successful model-facing output shape:

    ## Sources
    [1] Title
        https://example.com
        Snippet...
        Excerpt: ... (when enrich=true)

    ## Meta
    Provider: brave
    Sources: 5
    Request: <id>

Expected missing-key error:

    Error: BRAVE_API_KEY not found. Set it in environment before using web_search.

Expected partial enrichment warning:

    ## Warnings
    - Failed to fetch source 2 (timeout); showing search snippet only.

## Interfaces and Dependencies

No new runtime dependencies are required for v1.

In `shared/extensions/web-search/types.ts`, define:

    export type SearchProviderId = "brave";
    export type SearchRecency = "day" | "week" | "month" | "year";

    export interface SearchSource {
      title: string;
      url: string;
      snippet?: string;
      publishedDate?: string;
      ageSeconds?: number;
      fetchedExcerpt?: string;
      fetchedAt?: string;
      fetchError?: string;
    }

    export interface SearchResponse {
      provider: SearchProviderId | "none";
      answer?: string;
      sources: SearchSource[];
      requestId?: string;
      warnings?: string[];
    }

    export class SearchProviderError extends Error {
      constructor(provider: SearchProviderId, message: string, status?: number);
    }

In `shared/extensions/web-search/providers/base.ts`, define:

    export interface SearchParams {
      query: string;
      limit: number;
      recency?: SearchRecency;
      signal?: AbortSignal;
    }

    export interface SearchProvider {
      id: SearchProviderId;
      label: string;
      isAvailable(): Promise<boolean> | boolean;
      search(params: SearchParams): Promise<SearchResponse>;
    }

In `shared/extensions/web-search/enrich.ts`, define:

    export interface EnrichOptions {
      enrich: boolean;
      fetchTop: number;
      perSourceTimeoutMs?: number;
      maxExcerptChars?: number;
    }

    export async function enrichSourcesWithFetch(
      sources: SearchSource[],
      options: EnrichOptions,
      fetchFn?: (url: string, opts: { timeoutMs: number }) => Promise<{ excerpt: string }>,
    ): Promise<{ sources: SearchSource[]; warnings: string[] }>;

In `shared/extensions/web-search/index.ts`, register:

- tool name `web_search`
- strict schema object literal with `additionalProperties: false`
- execute -> core resolver/provider, optional enrichment, bounded envelope rendering

Use existing local modules only:

- `shared/lib/fetch-core.ts` (`fetchUrl`) for default enrichment adapter
- Node built-ins and local code for runtime behavior

Anthropic/Codex provider-native search integrations are explicitly out of scope for v1 and belong to a follow-up ExecPlan.

---

Revision note (2026-02-26): Updated this plan in response to ExecPlan review feedback. Changes include explicit milestone structure, single-path file/test decisions, fixed bounds/defaults, commit points with suggested messages, fixture-driven Brave parsing contract, explicit reuse of `fetch-core`, constrained-network fallback validation, and removal of unresolved runtime dependency assumptions (TypeBox/StringEnum) for v1 implementability in this repository.
