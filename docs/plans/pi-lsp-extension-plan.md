# Implement a universal LSP extension package for pi with low context overhead

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

After this change, pi sessions using this repository package will get automatic LSP diagnostics (and optional formatting) after `write`/`edit`, plus one on-demand `lsp` tool for code intelligence (`definition`, `references`, `hover`, `symbols`, `rename`, `code_actions`, `incoming_calls`, `outgoing_calls`, `languages`, `diagnostics`).

The user-visible benefit is better autonomous coding with less prompt waste: no per-language tool explosion, no static per-language prompt text, and immediate feedback in the same tool result the model already sees.


## Progress

- [x] (2026-02-27 22:46Z) Rewrote this file from draft proposal into ExecPlan format with concrete steps, test commands, commit points, and acceptance criteria.
- [x] (2026-02-27 22:52Z) Incorporated stakeholder choices: auto-load enabled, TypeScript-first vertical slice, `formatOnWrite` default ON, integration tests kept out of `selfci` gate.
- [ ] Create `packages/lsp/` package skeleton, wire root `package.json`, and add `devShells.lsp-test` in `flake.nix`.
- [ ] Milestone 1: config/defaults + tests (red/green) for detection inputs.
- [ ] Milestone 2: JSON-RPC LSP client + tests (red/green).
- [ ] Milestone 3: server detection/lifecycle manager + tests (red/green).
- [ ] Milestone 4: write/edit interceptor + tests (red/green).
- [ ] Milestone 5: single `lsp` tool + tests (red/green).
- [ ] Milestone 6: extension wiring, system prompt hint, and integration tests with real TypeScript server.
- [ ] Update README usage docs and run full validation (`npm test`, `selfci check`, manual smoke).


## Surprises & Discoveries

- Observation: repo test conventions now avoid placing tests in extension directories because pi autoloads `*.ts` extension files.
  Evidence: `README.md` section “Testing” and existing tests in `test/extensions/`.

- Observation: this repository’s tests run in plain Node (`node --experimental-strip-types`) and should avoid introducing hard runtime dependencies that are not guaranteed in local test runs.
  Evidence: existing `web_search` extension uses plain JSON-schema-like objects instead of TypeBox runtime imports.


## Decision Log

- Decision: convert this document from proposal to implementation-ready ExecPlan before coding.
  Rationale: prior review flagged missing concrete steps, tests, and acceptance criteria as blocking.
  Date: 2026-02-27

- Decision: auto-load the extension via root `package.json` by adding `./packages/lsp/extensions` to `pi.extensions`.
  Rationale: user requested the LSP extension be available by default when this package is loaded.
  Date: 2026-02-27

- Decision: implement as a package under `packages/lsp/` with a single extension entrypoint `packages/lsp/extensions/lsp.ts`.
  Rationale: keeps extension logic isolated and aligns with existing `packages/*` organization.
  Date: 2026-02-27

- Decision: keep tests outside extension directories at `packages/lsp/test/`.
  Rationale: prevents accidental extension auto-loading of test files.
  Date: 2026-02-27

- Decision: deliver one vertical slice first using TypeScript (`typescript-language-server`) before expanding language coverage.
  Rationale: user approved TypeScript-first sequencing to de-risk architecture before multi-language expansion.
  Date: 2026-02-27

- Decision: use one `lsp` tool with action enum, plus `tool_result` interception for `write`/`edit`.
  Rationale: minimal static context while preserving on-demand code intelligence.
  Date: 2026-02-27

- Decision: format-on-write default is `true`; auto code actions default is `false`.
  Rationale: formatting is usually safe and high value; auto-fix actions are more invasive.
  Date: 2026-02-27

- Decision: static prompt hint string is exactly:
  `Write/edit results include automatic LSP diagnostics and formatting. Use the lsp tool for code intelligence (action "languages" to list supported languages).`
  Rationale: one stable string preserves prompt cache and removes ambiguity.
  Date: 2026-02-27

- Decision: when multiple servers match one file extension, choose the first enabled server in merged config order.
  Rationale: deterministic behavior with explicit override path via config order.
  Date: 2026-02-27

- Decision: keep real-LSP integration tests outside the `selfci` required gate.
  Rationale: user requested integration checks remain opt-in/manual (`nix develop .#lsp-test`) to avoid slowing/fragilizing default CI.
  Date: 2026-02-27


## Outcomes & Retrospective

(To be filled at each milestone completion and at final completion.)


## Context and Orientation

Repository root: `/home/bromanko.linux/Code/llm-agents`.

Relevant existing files and why they matter:

- `package.json` (root): controls package-wide pi extension discovery via `pi.extensions`. This file must include `./packages/lsp/extensions` to load the new extension.
- `flake.nix`: currently defines only `devShells.default`. This plan adds `devShells.lsp-test` for real-server integration testing.
- `.config/selfci/ci.yaml`: validates extensions by reading extension directories from root `package.json`; adding the new extension path automatically includes it in extension load checks.
- `test/helpers.ts`: reusable mock `ExtensionAPI` test helper for extension registration/event tests.
- `shared/extensions/live-edit.ts`: existing example of `tool_result` event usage.

New package layout (all repository-relative):

- `packages/lsp/package.json`
- `packages/lsp/extensions/lsp.ts` (only extension entrypoint)
- `packages/lsp/lib/types.ts`
- `packages/lsp/lib/defaults.json`
- `packages/lsp/lib/config.ts`
- `packages/lsp/lib/lsp-client.ts`
- `packages/lsp/lib/server-manager.ts`
- `packages/lsp/lib/interceptor.ts`
- `packages/lsp/lib/lsp-tool.ts`
- `packages/lsp/lib/render.ts`
- `packages/lsp/test/config.test.ts`
- `packages/lsp/test/lsp-client.test.ts`
- `packages/lsp/test/server-manager.test.ts`
- `packages/lsp/test/interceptor.test.ts`
- `packages/lsp/test/lsp-tool.test.ts`
- `packages/lsp/test/extension.test.ts`
- `packages/lsp/test/integration/typescript.e2e.test.ts`

Environment assumptions:

- Node.js 22+ (required by existing test command using `--experimental-strip-types`).
- `npm test` from repo root is the authoritative unit test command.
- `selfci` is available in `nix develop` default shell.
- Integration test shell: `nix develop .#lsp-test` must provide `typescript-language-server` and `typescript`.
- If not using nix, manual integration requires `typescript-language-server` and `typescript` available in `PATH`.


## Plan of Work

Work proceeds in six milestones, each independently verifiable.

Milestone 1 delivers config + defaults parsing and precedence semantics. Milestone 2 adds the LSP JSON-RPC client. Milestone 3 adds server detection/lifecycle logic. Milestone 4 introduces write/edit interception with diagnostics and formatting safeguards. Milestone 5 adds the single `lsp` tool. Milestone 6 wires extension registration, static prompt hint, real TypeScript integration tests, docs, and final validation.

The implementation strategy is additive and test-first. Each milestone follows red/green/refactor and ends with a passing test command and a commit.


## Concrete Steps

All commands below are run from repository root unless stated otherwise:

`/home/bromanko.linux/Code/llm-agents`

### Milestone 0: package wiring and dev shell

1. Create package directories and empty files.

    mkdir -p packages/lsp/extensions packages/lsp/lib packages/lsp/test/integration
    touch packages/lsp/package.json
    touch packages/lsp/extensions/lsp.ts
    touch packages/lsp/lib/{types.ts,config.ts,lsp-client.ts,server-manager.ts,interceptor.ts,lsp-tool.ts,render.ts,defaults.json}
    touch packages/lsp/test/{config.test.ts,lsp-client.test.ts,server-manager.test.ts,interceptor.test.ts,lsp-tool.test.ts,extension.test.ts}
    touch packages/lsp/test/integration/typescript.e2e.test.ts

Expected result: all listed files exist.

2. Update root `package.json` to include `"./packages/lsp/extensions"` in `pi.extensions`.

Expected result: `selfci` extension loading includes the new extension path automatically.

3. Add `devShells.lsp-test` in `flake.nix` with:

- everything from default shell (`selfci`), plus
- `nodePackages.typescript-language-server`
- `nodePackages.typescript`

Expected result: `nix develop .#lsp-test -c typescript-language-server --version` exits 0.

4. Commit wiring changes.

Suggested commit message:

    chore(lsp): add package skeleton, extension path wiring, and lsp-test dev shell

---

### Milestone 1: config and defaults (red/green)

5. Write failing tests in `packages/lsp/test/config.test.ts` (8 tests):

- loads defaults from `packages/lsp/lib/defaults.json`
- merges user config (`~/.pi/agent/lsp.json`) with project config (`.pi/lsp.json`), project wins
- `disabled: true` removes a default server
- custom server entry is appended and routable by extension
- global defaults: `formatOnWrite=true`, `diagnosticsOnWrite=true`, `autoCodeActions=false`, `idleTimeoutMinutes=10`
- server order is deterministic and preserved for match precedence
- invalid JSON returns deterministic parse error text
- missing config files return defaults without throwing

6. Run red phase for milestone 1.

    node --experimental-strip-types --test packages/lsp/test/config.test.ts

Expected red output includes at least one assertion failure such as “Cannot find module '../lib/config.ts'” or merge expectation mismatches.

7. Implement `packages/lsp/lib/types.ts` and `packages/lsp/lib/config.ts` with concrete interfaces:

- `LspServerDefinition`
- `LspRuntimeConfig`
- `ResolvedLspConfig`
- `loadResolvedConfig(cwd: string): Promise<ResolvedLspConfig>`

8. Populate `packages/lsp/lib/defaults.json` with initial vertical slice entries:

- `typescript-language-server` (`.ts`, `.tsx`, `.js`, `.jsx`; root markers `package.json`, `tsconfig.json`)

9. Run green phase for milestone 1.

    node --experimental-strip-types --test packages/lsp/test/config.test.ts

Expected result: `8` passing tests, `0` failing.

10. Commit milestone 1.

Suggested commit message:

    feat(lsp): add config loading, merge logic, and defaults schema

---

### Milestone 2: LSP client (red/green)

11. Write failing tests in `packages/lsp/test/lsp-client.test.ts` (12 tests) for:

- Content-Length framed parsing
- request/response correlation by id
- notification dispatch (`publishDiagnostics`)
- request timeout rejection with deterministic error
- initialize/initialized handshake order
- graceful shutdown (`shutdown` then `exit`)
- parser handling of chunked/sticky frames
- malformed frame rejection without process crash
- `textDocument/didOpen` and `didChange` emit correct JSON-RPC notifications
- 1-index to 0-index position conversion helper
- URI conversion helper (`file://`)
- cancellation safety when abort signal is triggered

12. Run red phase.

    node --experimental-strip-types --test packages/lsp/test/lsp-client.test.ts

Expected result: failing tests due unimplemented client behavior.

13. Implement `packages/lsp/lib/lsp-client.ts` using stdio JSON-RPC 2.0 with:

- buffered frame parser
- pending request map with timeout
- notification listener registry
- lifecycle methods (`initialize`, `shutdown`)

14. Run green phase.

    node --experimental-strip-types --test packages/lsp/test/lsp-client.test.ts

Expected result: `12` passing tests.

15. Commit milestone 2.

Suggested commit message:

    feat(lsp): implement stdio JSON-RPC client with diagnostics notification support

---

### Milestone 3: detection and server lifecycle manager (red/green)

16. Write failing tests in `packages/lsp/test/server-manager.test.ts` (12 tests):

- root marker detection at project root
- monorepo child scan (`packages/`, `apps/`, `services/`, `libs/`, `crates/`, `modules/`)
- binary resolution order: project-local bin then `PATH`
- reports missing binary status deterministically
- lazy start on first file interaction
- nearest-root-marker workspace root selection
- extension match routing by file extension
- multiple-match precedence uses merged config order
- idle shutdown after configured timeout
- restart after idle shutdown
- full session shutdown cleans all running servers
- `languages` status payload includes `available/running/missing/disabled`

17. Run red phase.

    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts

18. Implement `packages/lsp/lib/server-manager.ts` with explicit APIs:

- `detectServers(cwd, config)`
- `resolveServerForFile(filePath)`
- `ensureServerForFile(filePath)`
- `shutdownIdleServers(now)`
- `shutdownAll()`

19. Run green phase.

    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts

Expected result: `12` passing tests.

20. Commit milestone 3.

Suggested commit message:

    feat(lsp): add server detection, routing, lazy startup, and lifecycle management

---

### Milestone 4: write/edit interceptor (red/green)

21. Write failing tests in `packages/lsp/test/interceptor.test.ts` (10 tests):

- intercepts only `write` and `edit` results
- no-op when `diagnosticsOnWrite=false`
- sends didOpen/didChange/didSave in correct order
- waits for diagnostics up to timeout then continues
- appends deterministic diagnostics block format:
  `[server-name] N issue(s):` + `path:line:column — message`
- suppresses duplicate diagnostics block when no diagnostics
- format-on-write applies edits and rewrites file
- recursion guard prevents infinite loop when rewrite triggers second `tool_result`
- no formatting when `formatOnWrite=false`
- optional auto-code-actions apply only preferred error fixes when enabled

22. Run red phase.

    node --experimental-strip-types --test packages/lsp/test/interceptor.test.ts

23. Implement `packages/lsp/lib/interceptor.ts` with:

- `createToolResultInterceptor(deps)` factory
- recursion guard keyed by `{toolCallId,path}` or short-lived path token
- 3-second diagnostics timeout default
- deterministic appended text formatter

24. Run green phase.

    node --experimental-strip-types --test packages/lsp/test/interceptor.test.ts

Expected result: `10` passing tests.

25. Commit milestone 4.

Suggested commit message:

    feat(lsp): add write/edit diagnostics interceptor with formatting and recursion guard

---

### Milestone 5: single `lsp` tool (red/green)

26. Write failing tests in `packages/lsp/test/lsp-tool.test.ts` (12 tests):

- registers tool named `lsp`
- schema includes required `action` enum and optional fields
- `languages` returns status list
- `diagnostics` returns current diagnostics for file
- `definition`, `references`, `hover`, `symbols`, `rename`, `code_actions`, `incoming_calls`, `outgoing_calls` route to proper client methods
- `symbols` switches between document and workspace based on `query`
- `rename`/`code_actions` respect `apply` flag
- missing required positional fields return deterministic validation errors
- line/column 1-index input is converted to 0-index LSP position
- unsupported action returns deterministic error text

27. Run red phase.

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts

28. Implement `packages/lsp/lib/lsp-tool.ts` and `packages/lsp/lib/render.ts`.

Use a plain JSON-schema-like parameter object (no TypeBox runtime import), matching repo test constraints.

29. Run green phase.

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts

Expected result: `12` passing tests.

30. Commit milestone 5.

Suggested commit message:

    feat(lsp): add unified lsp tool with action routing and compact renderers

---

### Milestone 6: extension wiring, integration, docs, full validation

31. Write failing tests in `packages/lsp/test/extension.test.ts` (8 tests):

- extension registers `tool_result` handler
- extension registers `session_start`, `session_shutdown`, `before_agent_start`
- prompt hint injected only when at least one server is detected
- prompt hint text equals canonical static string (exact match)
- `lsp` tool registered only when at least one server is enabled and detected
- startup notification reports detected + missing binaries
- footer status is updated when servers run and cleared when none run
- session shutdown triggers `shutdownAll`

32. Run red phase.

    node --experimental-strip-types --test packages/lsp/test/extension.test.ts

33. Implement extension entrypoint in `packages/lsp/extensions/lsp.ts`.

34. Run green phase.

    node --experimental-strip-types --test packages/lsp/test/extension.test.ts

Expected result: `8` passing tests.

35. Write integration test in `packages/lsp/test/integration/typescript.e2e.test.ts` (4 tests), designed to run only in `lsp-test` shell:

- detection finds `typescript-language-server` in PATH
- writing invalid `.ts` file yields appended diagnostics block
- writing valid `.ts` file yields no error diagnostics block
- `lsp` tool `definition` returns at least one location for a simple fixture symbol

36. Run integration tests in lsp shell.

    nix develop .#lsp-test -c node --experimental-strip-types --test packages/lsp/test/integration/typescript.e2e.test.ts

Expected result: `4` passing tests.

If shell command fails due missing nix setup, run fallback with manual PATH and record in Surprises & Discoveries.

37. Run full suite.

    npm test

Expected result: all existing tests plus new LSP tests pass; no failures.

38. Run selfci.

    selfci check

Expected result: extension loading and tests pass.

39. Add README section `## Pi lsp tool` with:

- what auto diagnostics/formatting does
- sample `lsp` actions
- config file paths (`~/.pi/agent/lsp.json`, `.pi/lsp.json`)
- how to run in lsp shell for integration tests

40. Commit milestone 6 and docs.

Suggested commit message:

    feat(lsp): wire extension lifecycle, add integration tests, and document usage

41. Update this plan’s living sections (`Progress`, `Surprises`, `Decision Log`, `Outcomes`) with actual timestamps and outcomes from execution.

---

## Validation and Acceptance

Acceptance is behavior-based and must all pass.

1. Loading pi with this repo package yields automatic diagnostics on `write`/`edit` for TypeScript files when `typescript-language-server` is available.
2. Diagnostics are appended directly to tool results in deterministic format, without requiring explicit `lsp` tool calls.
3. Formatting runs after write/edit when enabled and does not create rewrite loops.
4. `lsp` tool exists only when at least one server is detected and supports all listed actions with deterministic errors for invalid calls.
5. Static prompt hint is injected only when servers are detected, and text is byte-for-byte stable across turns.
6. `languages` action reveals detected/running/missing statuses.
7. Idle shutdown occurs after configured timeout and servers restart lazily on next request.
8. Session shutdown always terminates all server processes.

Validation commands:

Integration and selfci are intentionally separate: run the integration command manually in `lsp-test` shell; `selfci check` remains the standard repo gate and does not run real LSP integration tests.

    node --experimental-strip-types --test packages/lsp/test/config.test.ts
    node --experimental-strip-types --test packages/lsp/test/lsp-client.test.ts
    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts
    node --experimental-strip-types --test packages/lsp/test/interceptor.test.ts
    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts
    node --experimental-strip-types --test packages/lsp/test/extension.test.ts
    nix develop .#lsp-test -c node --experimental-strip-types --test packages/lsp/test/integration/typescript.e2e.test.ts
    npm test
    selfci check

Manual smoke (from repo root in lsp shell):

    pi --extension ./packages/lsp/extensions/lsp.ts

Then prompt:

- “Write `tmp/lsp-smoke.ts` with `const x: string = 1` and show diagnostics.”
- “Use `lsp` action `definition` on symbol `x` in that file.”

Expected observable output includes diagnostic line like:

    [typescript-language-server] 1 issue(s):
      tmp/lsp-smoke.ts:1:7 — Type 'number' is not assignable to type 'string'.


## Idempotence and Recovery

All steps are additive and safe to re-run.

- Re-running detection and startup steps is safe; server manager should no-op when server already running.
- If integration test hangs, terminate test process and run targeted unit tests first to isolate parser/client issues.
- If formatter causes unexpected edits, disable with config (`formatOnWrite: false`) and continue diagnostics validation.
- If an LSP server fails to initialize, report deterministic startup error in tool output; do not crash extension runtime.
- If `nix develop .#lsp-test` is unavailable, run unit suite and document integration test skip reason in `Surprises & Discoveries`.


## Artifacts and Notes

Expected startup status notification example:

    LSP detected: typescript-language-server (available), rust-analyzer (missing binary)

Expected `languages` output example:

    - typescript-language-server: available, running
    - rust-analyzer: missing binary

Expected no-server behavior:

- no `lsp` tool registered
- no system prompt hint injection
- write/edit interception remains no-op for unsupported file extensions


## Interfaces and Dependencies

In `packages/lsp/lib/types.ts`, define:

    export type LspAction =
      | "languages"
      | "diagnostics"
      | "definition"
      | "references"
      | "hover"
      | "symbols"
      | "rename"
      | "code_actions"
      | "incoming_calls"
      | "outgoing_calls";

    export interface LspServerDefinition {
      name: string;
      command: string;
      args: string[];
      fileTypes: string[];
      rootMarkers: string[];
      initializationOptions?: Record<string, unknown>;
      settings?: Record<string, unknown>;
      disabled?: boolean;
    }

    export interface LspRuntimeConfig {
      formatOnWrite: boolean;
      diagnosticsOnWrite: boolean;
      autoCodeActions: boolean;
      idleTimeoutMinutes: number;
      servers: Record<string, Partial<LspServerDefinition> & { binary?: string }>;
    }

    export interface LspToolParams {
      action: LspAction;
      file?: string;
      line?: number;
      column?: number;
      query?: string;
      new_name?: string;
      apply?: boolean;
    }

In `packages/lsp/lib/lsp-client.ts`, define:

    export interface LspClient {
      initialize(rootUri: string): Promise<void>;
      shutdown(): Promise<void>;
      request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T>;
      notify(method: string, params: unknown): void;
      onDiagnostics(cb: (uri: string, diagnostics: unknown[]) => void): void;
    }

In `packages/lsp/lib/server-manager.ts`, define:

    export interface ServerManager {
      detectServers(): Promise<void>;
      resolveServerForFile(filePath: string): string | null;
      ensureServerForFile(filePath: string): Promise<ManagedServer | null>;
      listLanguagesStatus(): LanguageStatus[];
      shutdownIdleServers(now?: number): Promise<void>;
      shutdownAll(): Promise<void>;
    }

Dependencies:

- Runtime: Node built-ins only (`node:fs`, `node:path`, `node:url`, `node:child_process`, `node:timers/promises`).
- No new npm runtime dependencies required for v1.
- Nix test shell dependency (integration only): `nodePackages.typescript-language-server`, `nodePackages.typescript`.

---

Revision note (2026-02-27): Replaced draft proposal with full ExecPlan to resolve review findings. Added mandatory living-document sections, file-level implementation steps, explicit TDD cycles, commit checkpoints, deterministic validation commands, edge-case tests, integration touchpoints (`package.json`, `flake.nix`, `README.md`), and explicit interface contracts.