# Meta-plan for repo-local `find` and `grep` replacements in this pi package

## Summary

This document is the umbrella plan for replacing pi’s built-in `find` and `grep` tools inside this repository with repo-local overrides that are better suited to agentic code exploration. The immediate goal is not to invent a fully semantic code search system. The immediate goal is to remove the repetitive friction that shows up in real pi sessions: unreadable OR regexes, path-guessing loops, crude `| head` truncation, and repeated `find | grep` composition.

The intended implementation home is a new package area at `pi/search`. The initial shipped surface will keep the familiar built-in tool names `find` and `grep` so existing model habits still work. The long-term direction is a more structured search system, but this roadmap deliberately starts with drop-in overrides and bounded extensions to the existing mental model.

The concrete implementation work for the first slice lives in `docs/plans/pi-search-tools-p0-execplan.md`. Future phases in this document are intentionally deferred to later ExecPlans.

## Why this work is worth doing

A session analysis of local pi usage showed that search is one of the dominant costs in both time and context budget. Across `110` session files, there were `4,146` bash commands, of which `2,100` were search-related. The same analysis found `893` `rg` commands, `911` `grep` commands, `399` `find` commands, and `225` consecutive search-refinement chains. The most common failure patterns were large OR expressions, timeouts in large repositories, regex and flag mistakes, path misses, and heavy use of `| head` as a blunt output control mechanism.

This is a good target for a local pi package because the repository already ships repo-local tool overrides such as `pi/web/extensions/fetch.ts` and `pi/lsp/extensions/lsp.ts`. The same mechanism can be used to replace built-in search tools with better-behaved versions without waiting for upstream pi changes.

## Product direction

The replacement search tools should feel familiar enough that current model habits still succeed, but structured enough that common failure modes become harder to trigger.

The north-star behavior is:

- `grep` defaults to literal search instead of regex search.
- multi-term search is first-class instead of encoded as fragile `foo|bar|baz` expressions.
- file filtering and content filtering can be combined in one tool call without shell composition.
- outputs are paginated and explicit about truncation, counts, and next steps.
- missing paths return helpful suggestions instead of forcing extra discovery loops.
- large-repo behavior is safer by default because noisy directories are skipped and ignore files are respected unless explicitly bypassed.

The roadmap does **not** assume a code index, AST search engine, or language-aware context extraction in the first milestone. Those remain future work.

## Repository fit and target location

This repository’s root `package.json` already exposes extension directories under `pi/...`, including `./pi/web/extensions`, `./pi/lsp/extensions`, and other package areas. There is currently no `pi/search` directory. The new work should live under:

- `pi/search/package.json`
- `pi/search/extensions/find.ts`
- `pi/search/extensions/grep.ts`
- `pi/search/lib/...`
- `pi/search/test/...`

The root `package.json` should only add `./pi/search/extensions` to `pi.extensions` after the targeted tests pass and the tool behavior has been manually exercised.

## Design principles for the whole roadmap

The replacement tools should follow six principles.

First, they must remain recognizable as `find` and `grep`. A model that already knows pi’s built-in tools should not need to relearn the basics.

Second, they should be literal-first and bounded-first. Regex and unbounded output are still allowed when useful, but they must be explicit choices.

Third, they should prefer one good tool call over shell composition. If the model wants to search only `*.test.ts` files under a subtree, the tool should support that directly.

Fourth, they should fail helpfully. A missing path should return candidate paths; a truncated result should say how to continue; a broad search should say that more results exist.

Fifth, they should stay repo-local and testable in this workspace’s plain `node --experimental-strip-types --test ...` environment. That means using the same style as existing package tools: type-only pi imports where needed, object-literal schemas instead of runtime dependencies on pi internals, and injectable execution seams for tests.

Sixth, they should be staged. The first ExecPlan should solve the top pain points with a conservative implementation. Ranking, streaming, structural context, and indexing should land only after the compatibility-first slice proves valuable.

## Roadmap

### Phase P0: compatibility-first overrides with structured improvements

This is the phase covered by `docs/plans/pi-search-tools-p0-execplan.md`.

The purpose of P0 is to deliver immediate value without changing the tool names or attempting deep language awareness.

P0 will add a new `pi/search` package that overrides built-in `find` and `grep` with repo-local tools. The implementation will use `ripgrep` as the only external search engine dependency for both tools: normal content search for `grep`, and `rg --files` for `find`. This keeps behavior consistent and avoids introducing a separate dependency such as `fd`.

The P0 `grep` tool will be a backward-compatible superset of pi’s built-in schema. It will keep support for the built-in fields `pattern`, `path`, `glob`, `ignoreCase`, `literal`, `context`, and `limit`, and it will add the smallest extra surface needed to address the observed usage problems:

- literal search becomes the default when the caller does not explicitly request regex behavior
- `anyOf: string[]` becomes the first-class alternative to pipe-heavy OR regexes
- `offset` enables pagination beyond the first page
- `outputMode` supports `content`, `files_with_matches`, and `count`
- `type` passes through to `rg --type`, giving access to ripgrep's built-in file-type aliases such as `ts`, `py`, `json`, and `html`
- `hidden` and `respectIgnore` give structured scope control
- path validation returns suggestions when the requested `path` does not exist

The P0 `find` tool will remain intentionally smaller. Its `pattern` field is a glob pattern applied to filenames via `rg --files --glob`. It will keep the built-in `pattern`, `path`, and `limit` fields and add:

- `offset` for pagination
- `hidden` and `respectIgnore` to control scope
- path validation and suggestions
- a consistent result envelope that reports counts, truncation, and how to continue

P0 will also introduce a shared skip-list for noisy directories such as `.git`, `.jj`, `node_modules`, `dist`, `build`, `coverage`, and `__pycache__`. The defaults will prefer practical agent exploration over exhaustive filesystem traversal.

### Phase P1: ranking, refinement support, and better follow-up guidance

P1 will build on the P0 overrides instead of replacing them.

The goal of P1 is to reduce the number of refinement chains after an initial search. The tools should start returning more information that helps the next search be precise instead of repetitive.

Expected P1 themes are:

- file and directory distribution summaries
- stable relevance ordering, for example exact path match before broad subtree match
- support for `allOf` and possibly exclusion filters once P0 semantics are proven
- early partial-result streaming or fast-first-page behavior for large repos
- better “there are more results” guidance than a generic truncation note

P1 should be implemented in a future ExecPlan after P0 is working and the initial result format has proven stable.

### Phase P2: structural code context

P2 is where the roadmap starts to move beyond grep-shaped search.

The purpose of P2 is to answer a question the current tools do not answer well: “show me the code unit I actually need” instead of “show me N context lines.” That means returning the enclosing function, class, test block, or similar structural unit when the language tooling is available.

Expected P2 themes are:

- language-aware block extraction using LSP or parser-backed helpers
- identifier-oriented lookup for code symbols
- smarter context for content-mode results instead of fixed-line windows

This work is intentionally deferred. It adds language and parser complexity that is not necessary to relieve the biggest search pain immediately.

### Phase P3: optional unified `search` tool

The long-term roadmap may add a new tool named `search` after the replacement `find` and `grep` semantics have been proven in real use.

The reason to defer this is simple: the user asked about replacement versions of pi’s existing search tools, and a compatibility-first rollout has lower risk. A future unified tool can then reuse the proven P0 and P1 library code while offering a cleaner structured API for new usage.

## Planned document set

This roadmap expects a family of documents rather than one giant implementation plan.

- `docs/plans/pi-search-tools-meta-plan.md` — this umbrella document
- `docs/plans/pi-search-tools-p0-execplan.md` — detailed implementation plan for P0
- future: `docs/plans/pi-search-tools-p1-execplan.md`
- future: `docs/plans/pi-search-tools-p2-execplan.md`
- future: `docs/plans/pi-search-tools-p3-execplan.md` if the unified `search` tool is still desirable after the earlier phases

## Major design decisions already made

The roadmap closes several choices now so the P0 ExecPlan can stay concrete.

The implementation will be repo-local inside this package, not a one-off `.pi/extensions` override.

The first shipped tools will keep the built-in names `find` and `grep` instead of introducing only a new `search` tool.

`ripgrep` will be the single engine used in P0 for both file listing and content search.

The P0 design will optimize for safer defaults, not raw compatibility with every built-in edge case. In particular, respecting ignore files by default and hiding bulky directories by default are deliberate changes.

The result envelopes may be custom and do not need to mimic pi’s internal built-in `find` and `grep` result details exactly. If custom renderers are simpler and safer, the implementation should use them.

## Risks that span all phases

The biggest roadmap risk is overreach. The search analysis points toward a rich structured-search future, but trying to deliver pagination, ranking, path correction, structural context, and indexing in one step would create an unnecessarily risky first release. The roadmap avoids that by making P0 compatibility-first.

Another risk is compatibility drift with upstream pi. This is why the roadmap keeps the first milestone focused on repo-local overrides and reusable library code rather than assumptions about pi internals.

A third risk is output format churn. If every phase rewrites the text envelope completely, later follow-up behavior will become inconsistent. The mitigation is to settle the envelope structure in P0 and evolve it additively in later phases.

## What P0 will not do

P0 will not introduce an index.

P0 will not attempt AST-aware or LSP-aware block extraction.

P0 will not try to rank results by semantic relevance.

P0 will not shadow shell `find` and `grep` commands. It only replaces pi’s built-in tool implementations inside this package.

P0 will not attempt to solve every possible grep use case. It solves the repeated failure patterns shown in local session data.

## Exit criteria for moving past P0

The roadmap should move to a P1 ExecPlan only after P0 demonstrates three things.

First, the repo-local overrides register correctly and behave well in the plain local test environment.

Second, the new schema additions prove useful in real sessions, especially `anyOf`, `offset`, output modes, and path suggestions.

Third, the result envelopes are stable enough that future ranking and structural-context work can extend them without rewriting the whole contract.

If those conditions are met, the future ExecPlans can stay focused on richer search behavior instead of re-litigating the foundation.
