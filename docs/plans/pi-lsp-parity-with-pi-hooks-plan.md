# Close LSP behavior gaps with pi-hooks while preserving our unified architecture

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

After this change, our LSP package in `packages/lsp/` will keep its current strengths (large server catalog, layered config, single extension entrypoint, unified `lsp` tool) while adding the operational behaviors that are currently stronger in `prateekmedia/pi-hooks/lsp`.

A user should be able to run long coding sessions with fewer flaky diagnostics, better monorepo behavior, and richer on-demand LSP queries. They should see this concretely by switching diagnostics modes (`agent_end` vs `edit_write`), running workspace-level diagnostics, and using symbol-query-based navigation without manually providing line/column.


## Progress

- [x] (2026-02-28 04:24Z) Compared current `packages/lsp/` behavior against `prateekmedia/pi-hooks/lsp` and identified parity gaps.
- [x] (2026-02-28 04:31Z) Authored this ExecPlan with implementation milestones, concrete steps, and validation commands.
- [ ] Implement server manager per-root instance keying (`serverName + rootPath`) and add tests.
- [ ] Add diagnostics robustness fallback (pull diagnostics when push did not arrive) and add tests.
- [ ] Add hook modes and `/lsp` command (`edit_write`, `agent_end`, `disabled`) and add tests.
- [ ] Extend `lsp` tool with `workspace-diagnostics`, `signature`, severity filtering, and query-to-position resolution.
- [ ] Implement `apply=true` behavior for `rename` and `code_actions`.
- [ ] Update README docs and run full test + validation suite.


## Surprises & Discoveries

- Observation: We already pass `autoCodeActions` through config and tests assert default behavior, but production interceptor code does not currently execute code actions.
  Evidence: `packages/lsp/lib/interceptor.ts` defines `autoCodeActions` in deps, but no `textDocument/codeAction` request is executed.

- Observation: Current running-server map is keyed by server name only, which risks cross-root coupling in monorepos.
  Evidence: `packages/lsp/lib/server-manager.ts` stores `running: Map<string, ManagedServer>` and returns early by server name.

- Observation: Current integration test file is a placeholder and does not assert real LSP behavior yet.
  Evidence: `packages/lsp/test/integration/typescript.e2e.test.ts` contains only a placeholder comment.


## Decision Log

- Decision: Preserve current action names (`code_actions`, `incoming_calls`, `outgoing_calls`) and add compatibility aliases rather than breaking existing callers.
  Rationale: Existing prompts and tests already use current names; additive aliases avoid migration churn.
  Date: 2026-02-28

- Decision: Implement hook-mode behavior in our existing extension (`packages/lsp/extensions/lsp.ts`) instead of splitting into separate hook/tool extension files.
  Rationale: Our repository already organizes LSP as one package extension; this keeps loading simple while still adding parity behaviors.
  Date: 2026-02-28

- Decision: Make `agent_end` the default mode for diagnostics, keep `edit_write` available, and allow full disable.
  Rationale: This matches pi-hooks operational ergonomics and reduces noisy mid-turn diagnostics in long tool chains.
  Date: 2026-02-28

- Decision: Implement per-root server instances before adding new tool actions.
  Rationale: Correct root routing is foundational; all higher-level behavior depends on stable client selection.
  Date: 2026-02-28


## Outcomes & Retrospective

(To be filled at milestone boundaries and at completion.)


## Context and Orientation

Current implementation lives under `packages/lsp/` and includes:

- `packages/lsp/extensions/lsp.ts`: extension entrypoint; registers lifecycle handlers, interceptor wiring, and `lsp` tool.
- `packages/lsp/lib/server-manager.ts`: server detection and lifecycle. This currently routes by extension and keeps one running instance per server name.
- `packages/lsp/lib/interceptor.ts`: appends diagnostics to write/edit results and can run formatting.
- `packages/lsp/lib/lsp-tool.ts`: unified tool with action enum; currently supports single-file diagnostics and code intelligence actions.
- `packages/lsp/lib/config.ts` + `packages/lsp/lib/defaults.json`: layered configuration and broad default server list.

Current tests are in `packages/lsp/test/` and include unit coverage for config, client, server manager, interceptor, tool, and extension wiring. Integration coverage is not yet implemented.

Reference implementation compared in this plan:

- `https://github.com/prateekmedia/pi-hooks/tree/main/lsp`

The compared implementation is stronger in these concrete areas:

1. Per-root LSP process management (same server can run for multiple project roots).
2. Diagnostics resilience (push + pull fallback, clearer unsupported/timeout states).
3. User-facing diagnostics hook modes (`agent_end`, `edit_write`, `disabled`) with `/lsp` command.
4. Tool ergonomics: workspace diagnostics, signature help, severity filtering, and query-based position resolution.


## Plan of Work

The implementation is split into additive milestones. Each milestone leaves the package in a passing state.

Milestone 1 corrects server identity and routing by making runtime keys root-aware. Milestone 2 hardens diagnostics by adding pull fallback when push notifications do not arrive on time. Milestone 3 introduces diagnostics modes and interactive mode control (`/lsp`) without removing existing behavior. Milestone 4 extends tool capabilities to include workspace diagnostics and signature help, and adds query-based position resolution plus severity filtering. Milestone 5 activates `apply=true` for rename and code actions. Milestone 6 completes docs and end-to-end validation.


## Concrete Steps

All commands run from:

    /home/bromanko.linux/Code/llm-agents

### Milestone 1: Per-root server instances

1. Write failing tests in `packages/lsp/test/server-manager.test.ts` for two roots using the same server name.
   Add one test that creates two temp project roots (`rootA`, `rootB`) each with TypeScript files and asserts `ensureServerForFile` creates distinct running instances.

2. Run red phase:

    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts

   Expected: the new per-root test fails because current map keys only by server name.

3. Update `packages/lsp/lib/server-manager.ts`:
   - Change running map key from `serverName` to composite key (for example `${serverName}::${rootDir}`).
   - Keep helper lookup methods explicit (`getRunningServerByNameAndRoot`, `getRunningServerForFile`), so call sites are deterministic.
   - Ensure idle shutdown and shutdownAll iterate over composite keys safely.

4. Update extension call sites in `packages/lsp/extensions/lsp.ts` to use the new lookup helper where needed.

5. Run green phase:

    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts

   Expected: all server-manager tests pass including the new per-root case.

6. Commit:

    git add packages/lsp/lib/server-manager.ts packages/lsp/extensions/lsp.ts packages/lsp/test/server-manager.test.ts
    git commit -m "feat(lsp): run servers per root to improve monorepo routing"

### Milestone 2: Diagnostics robustness (push + pull fallback)

7. Add failing tests in `packages/lsp/test/server-manager.test.ts` and `packages/lsp/test/interceptor.test.ts` for this sequence:
   - no push diagnostics received within timeout,
   - pull diagnostics request returns diagnostics,
   - diagnostics are surfaced to caller instead of timing out silently.

8. Run red phase:

    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts packages/lsp/test/interceptor.test.ts

9. Implement fallback in `packages/lsp/lib/server-manager.ts`:
   - After timeout waiting for push diagnostics, request `textDocument/diagnostic` when supported.
   - If unsupported there, attempt workspace diagnostic request.
   - Cache and return pulled diagnostics.
   - Return deterministic status metadata for unsupported/timeout/error cases.

10. Update `packages/lsp/lib/interceptor.ts` to display a stable, concise diagnostic block when fallback data is used.

11. Run green phase:

    node --experimental-strip-types --test packages/lsp/test/server-manager.test.ts packages/lsp/test/interceptor.test.ts

12. Commit:

    git add packages/lsp/lib/server-manager.ts packages/lsp/lib/interceptor.ts packages/lsp/test/server-manager.test.ts packages/lsp/test/interceptor.test.ts
    git commit -m "feat(lsp): add pull-diagnostics fallback for reliable diagnostics"

### Milestone 3: Hook modes and `/lsp` command

13. Add failing extension tests in `packages/lsp/test/extension.test.ts`:
   - default mode is `agent_end`,
   - `edit_write` appends diagnostics immediately,
   - `agent_end` defers diagnostics and emits one follow-up message,
   - `disabled` suppresses auto diagnostics but keeps tool available,
   - `/lsp` command updates mode for session and global scope.

14. Run red phase:

    node --experimental-strip-types --test packages/lsp/test/extension.test.ts

15. Implement in `packages/lsp/extensions/lsp.ts`:
   - Add mode state machine: `edit_write | agent_end | disabled`.
   - Add `/lsp` command to choose mode and scope.
   - Persist session setting in branch custom entry and global in `~/.pi/agent/settings.json` under `lsp.hookMode`.
   - In `agent_end`, gather touched files and emit one diagnostics summary message when agent completes successfully.

16. Run green phase:

    node --experimental-strip-types --test packages/lsp/test/extension.test.ts

17. Commit:

    git add packages/lsp/extensions/lsp.ts packages/lsp/test/extension.test.ts
    git commit -m "feat(lsp): add agent-end diagnostics mode and /lsp mode control"

### Milestone 4: Tool capability parity improvements

18. Add failing tests in `packages/lsp/test/lsp-tool.test.ts` for:
   - `workspace-diagnostics` action with `files[]`,
   - `signature` action,
   - severity filter behavior for diagnostics actions,
   - query-based position resolution when line/column omitted,
   - action alias support (`codeAction` -> `code_actions`).

19. Run red phase:

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts

20. Update `packages/lsp/lib/types.ts` and `packages/lsp/lib/lsp-tool.ts`:
   - Add new action names and aliases.
   - Add optional params needed for workspace diagnostics and severity filtering.
   - Implement query-to-position resolution via document symbols helper.
   - Implement `signature` and `workspace-diagnostics` handlers.

21. Update any render helpers in `packages/lsp/lib/render.ts` for stable output formatting.

22. Run green phase:

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts

23. Commit:

    git add packages/lsp/lib/types.ts packages/lsp/lib/lsp-tool.ts packages/lsp/lib/render.ts packages/lsp/test/lsp-tool.test.ts
    git commit -m "feat(lsp): add workspace diagnostics, signature help, and query-based positioning"

### Milestone 5: `apply=true` for rename and code actions

24. Add failing tests in `packages/lsp/test/lsp-tool.test.ts` for:
   - rename returns preview when `apply=false`, writes edits when `apply=true`,
   - code action returns list when `apply=false`, applies selected workspace edit when `apply=true`.

25. Run red phase:

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts

26. Implement edit-application helper in `packages/lsp/lib/lsp-tool.ts`:
   - Convert LSP ranges to string offsets.
   - Apply edits in reverse-order offsets per file.
   - Write files atomically (read -> transform -> write).
   - Return deterministic summary text: files changed, edit count, and paths.

27. Run green phase:

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts

28. Commit:

    git add packages/lsp/lib/lsp-tool.ts packages/lsp/test/lsp-tool.test.ts
    git commit -m "feat(lsp): support applying rename and code action edits"

### Milestone 6: Integration test + docs + final validation

29. Replace placeholder in `packages/lsp/test/integration/typescript.e2e.test.ts` with real test flow:
   - create temp TypeScript workspace,
   - start extension/tool in test harness,
   - run definition and diagnostics actions,
   - assert expected non-empty responses.

30. Run integration test:

    node --experimental-strip-types --test packages/lsp/test/integration/typescript.e2e.test.ts

31. Update repository docs in `README.md` (LSP section) with:
   - mode behavior,
   - new tool actions,
   - `apply` semantics,
   - expected prerequisites for integration testing.

32. Run full test suite:

    npm test

   Expected: all tests pass.

33. Run self check:

    selfci check

   Expected: no extension loading errors.

34. Commit:

    git add packages/lsp/test/integration/typescript.e2e.test.ts README.md docs/plans/pi-lsp-parity-with-pi-hooks-plan.md
    git commit -m "test/docs(lsp): add integration coverage and document parity features"


## Validation and Acceptance

Acceptance is complete when all of the following are true:

1. In a monorepo with two subprojects, LSP server state does not leak between roots. This is proven by server-manager tests that create two roots and assert distinct running instances.
2. If push diagnostics are delayed or absent, fallback pull diagnostics still produce output for supported servers instead of silent failure.
3. `/lsp` command can switch auto-diagnostics mode and mode persists according to selected scope.
4. Tool supports `workspace-diagnostics`, `signature`, severity filtering, and query-based position resolution.
5. `apply=true` on rename/code actions performs file edits and reports changed files.
6. `npm test` and `selfci check` pass from repo root.


## Idempotence and Recovery

All test steps are repeatable. The plan is additive and safe to rerun.

If a milestone fails midway:

- Re-run the milestone-specific test command first to confirm current failure state.
- Use targeted restore for accidental edits:

    git restore --source=HEAD -- <file-path>

- Re-apply only the milestone changes and re-run tests.

If `apply=true` edit logic introduces incorrect file writes during development, use:

    git restore --source=HEAD -- packages/lsp

and rerun milestone tests before continuing.


## Artifacts and Notes

During implementation, add concise outputs here, for example:

    node --experimental-strip-types --test packages/lsp/test/lsp-tool.test.ts
    # ...
    # tests 18
    # pass 18
    # fail 0

And for full validation:

    npm test
    # ...
    # <final pass count>

    selfci check
    # ...
    # OK


## Interfaces and Dependencies

The final code should expose these stable interfaces and behaviors:

- In `packages/lsp/lib/server-manager.ts`:

    export interface ManagedServer {
      name: string;
      client: LspClient | null;
      rootUri: string;
      lastActivity: number;
    }

  plus root-aware lookup methods used by extension and tool code.

- In `packages/lsp/lib/types.ts`, `LspAction` and `LspToolParams` should include additive actions/params:

    - workspace-diagnostics
    - signature
    - severity filter
    - apply flag semantics for actionable edits

- In `packages/lsp/lib/lsp-tool.ts`, action routing must support backward-compatible aliases and deterministic error text for missing parameters.

No new external runtime dependencies are required for this milestone set. Continue using Node built-ins and existing package dependencies.


Revision note (2026-02-28): Created this new ExecPlan to guide post-implementation parity improvements after direct comparison with `prateekmedia/pi-hooks/lsp`. This plan intentionally builds on the already-completed `docs/plans/pi-lsp-extension-plan.md` and focuses only on remaining behavior gaps, not initial package creation.