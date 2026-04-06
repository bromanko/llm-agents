# Harden pi LSP foundations for multi-root correctness and protocol completeness

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, the `pi/lsp` extension will behave correctly in multi-root repositories, will speak the Language Server Protocol through a production-grade JSON-RPC implementation, and will keep language servers synchronized with file contents before on-demand LSP queries run.

A user should be able to work in a monorepo with multiple TypeScript or Python projects open under one checkout and trust that definition, hover, references, formatting, and diagnostics are talking to the correct project root. They should also be able to query a file that has not yet been touched by `write` or `edit` in the current session and still get correct LSP results because the file is opened and synchronized before the request is sent.

## Problem Framing and Constraints

Today the `pi/lsp` implementation has three concrete weaknesses.

First, runtime server instances are keyed only by server name in `pi/lsp/lib/server-manager.ts`. If two files in different roots both resolve to `typescript-language-server`, the first started server instance is reused, even if the second file belongs to a different project root. That can send requests to the wrong workspace and produce incorrect results in monorepos.

Second, `pi/lsp/lib/lsp-client.ts` is a custom JSON-RPC transport built directly on Node streams. It handles outbound requests and inbound notifications, but it does not support server-sent requests in the general case. Some language servers send requests back to the client, especially `workspace/configuration`, and those servers are better served by a protocol implementation that already handles request routing, connection lifecycle, and stream-level error handling.

Third, `pi/lsp/lib/lsp-tool.ts` sends LSP requests against file URIs without first guaranteeing that the document has been opened and synchronized with the server. `pi/lsp/lib/interceptor.ts` currently tracks document versions only for `write` and `edit` tool results. That means on-demand LSP queries can run against unopened or stale documents.

This plan intentionally does not change diagnostics strategy, add new `lsp` tool actions, or implement workspace-wide diagnostics. Those are deferred. The goal here is to make the current feature set correct and reliable without widening scope.

The implementation must fit the current repository constraints. Tests run from the repository root with plain Node via the root `package.json` script `node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'`. The `pi/lsp` package currently has no dependencies of its own, so adding `vscode-jsonrpc` must be done in a way that keeps root-level test execution working. The work must remain repository-relative and must not assume any absolute checkout path.

## Strategy Overview

The implementation proceeds in three milestones that match the agreed priorities.

The first milestone makes server identity root-aware. The server manager will still choose a server definition by file extension, but once a file path is known it will compute the appropriate root directory and use a composite runtime key of server name plus root directory. This is the smallest change that fixes the monorepo correctness bug.

The second milestone replaces the custom JSON-RPC transport in `pi/lsp/lib/lsp-client.ts` with `vscode-jsonrpc` while preserving the public shape that the rest of `pi/lsp` already uses. The new client will keep `request`, `notify`, `onDiagnostics`, `onNotification`, and `destroy`, and it will add `onRequest` so the server manager can answer server-sent requests such as `workspace/configuration`. Keeping the external interface mostly stable limits blast radius while still adopting the more complete transport.

The third milestone centralizes document synchronization in `pi/lsp/lib/server-manager.ts`. The manager will own per-document open state, version numbers, and last-synchronized text for each running server instance. Both the write/edit interceptor and the on-demand `lsp` tool will use the same document-sync helpers. This removes duplicated version bookkeeping and ensures on-demand queries run only after the document is known to the language server.

This approach is proportionate because it fixes correctness and protocol completeness without changing the user-facing `lsp` tool contract or reworking diagnostics behavior. It also keeps each milestone independently testable and reversible.

## Alternatives Considered

The simplest alternative was to fix only the server-manager keying bug and leave the custom JSON-RPC client in place. That would address the most obvious monorepo failure, but it would leave known protocol gaps in place and would not solve the inability to respond to server-sent requests. Because the user explicitly chose to switch to `vscode-jsonrpc`, this alternative is insufficient.

Another alternative was to keep the custom client and add just enough support for inbound requests. That would avoid a new dependency, but it would require reimplementing request dispatch, correlation, connection error handling, and close semantics ourselves. That would be more fragile than using a protocol library that already solves these problems and is actively exercised by many LSP clients.

A third alternative was to keep document synchronization inside `pi/lsp/lib/interceptor.ts` and add a second, smaller sync path inside `pi/lsp/lib/lsp-tool.ts`. That would minimize code motion, but it would duplicate lifecycle rules and make version correctness harder to reason about. Because document versions are server-session state, the right place for them is the server manager that owns those sessions.

## Risks and Countermeasures

The largest risk is regressions caused by swapping the transport layer. To reduce that risk, the plan keeps the exported `LspClient` surface stable where possible and rewrites `pi/lsp/test/lsp-client.test.ts` to exercise the behaviors the rest of the package actually relies on: request/response, notifications, inbound requests, diagnostics callbacks, timeouts, and teardown.

Another risk is that composite root-aware keys could strand existing code that still looks up running servers by bare server name. The plan addresses that by introducing explicit lookup helpers in `pi/lsp/lib/server-manager.ts` and updating all call sites in `pi/lsp/extensions/lsp.ts`, `pi/lsp/lib/interceptor.ts`, and `pi/lsp/lib/lsp-tool.ts` to use them.

A third risk is duplicated or inconsistent `didOpen` and `didChange` notifications during the transition. The plan avoids that by moving all document version tracking into the server manager and removing version bookkeeping from `pi/lsp/lib/interceptor.ts`. One module will own the rules for open-versus-change decisions.

The final operational risk is dependency churn. Adding `vscode-jsonrpc` changes installation requirements for the repository. The plan contains an explicit dependency-install step and ends with a full `npm test` run from the repository root so the dependency is validated in the same mode developers already use.

Rollback is straightforward. Each milestone is additive and ends with a green test state. If the transport swap proves too disruptive, the composite keying milestone can still land independently because it does not depend on `vscode-jsonrpc`.

## Progress

- [x] (2026-04-01 18:00Z) Verified current `pi/lsp` architecture, existing tests, and the three agreed priorities from the user.
- [x] (2026-04-01 18:10Z) Authored this ExecPlan as a scoped follow-up to the broader LSP parity work, limited to P0 root-aware keying, P1 `vscode-jsonrpc`, and P2 document synchronization before queries.
- [x] (2026-04-06 20:55Z) Added `vscode-jsonrpc` at the repository root, rewrote `pi/lsp/lib/lsp-client.ts` around `MessageConnection`, and replaced frame-parser tests with behavior tests including inbound `workspace/configuration` handling and destroy-time cleanup.
- [x] (2026-04-06 21:10Z) Refactored `pi/lsp/lib/server-manager.ts` to run one server per `(serverName, rootDir)`, extended `ManagedServer` with `key`, `rootDir`, and document state, and updated formatting lookups to use file-aware runtime identity.
- [x] (2026-04-06 21:25Z) Centralized document synchronization in the server manager, updated `pi/lsp/lib/interceptor.ts` and `pi/lsp/lib/lsp-tool.ts` to use shared sync helpers, and keyed diagnostics listener registration by runtime server key.
- [x] (2026-04-06 21:35Z) Ran `node --experimental-strip-types --test pi/lsp/test/lsp-client.test.ts`, `node --experimental-strip-types --test pi/lsp/test/server-manager.test.ts`, `node --experimental-strip-types --test pi/lsp/test/lsp-tool.test.ts pi/lsp/test/interceptor.test.ts pi/lsp/test/extension.test.ts`, and `npm test`; all passed.

## Surprises & Discoveries

- Observation: Node ESM resolution in this repository required importing the transport library as `vscode-jsonrpc/node.js`, not `vscode-jsonrpc/node`.
  Evidence: the first targeted `pi/lsp/test/lsp-client.test.ts` run failed with `ERR_MODULE_NOT_FOUND` and the hint `Did you mean to import "vscode-jsonrpc/node.js"?`.

- Observation: diagnostics listener deduplication also needed to become root-aware, not just server process lookup.
  Evidence: `pi/lsp/extensions/lsp.ts` originally keyed listener registration by `server.name`; after multi-root keying, the extension now keys listeners and diagnostics caches by `server.key` so separate roots using the same server name both receive diagnostics.

- Observation: document synchronization became simpler once write/edit interception and on-demand queries both treated the server manager as the only owner of document text and versions.
  Evidence: `pi/lsp/lib/interceptor.ts` no longer stores `documentVersions`, and `pi/lsp/lib/lsp-tool.ts` now calls `syncDocumentFromDisk(filePath)` before serving `diagnostics`, `definition`, `hover`, `references`, `implementation`, `symbols`, `rename`, `code_actions`, `incoming_calls`, and `outgoing_calls`.

## Decision Log

- Decision: keep this plan narrowly scoped to three infrastructure changes and explicitly defer diagnostics fallback, workspace diagnostics, and new `lsp` tool actions.
  Rationale: the user asked to prioritize the agreed P0, P1, and P2 changes and defer everything else.
  Date: 2026-04-01

- Decision: switch to `vscode-jsonrpc` rather than extending the custom transport.
  Rationale: the user explicitly chose this direction, and it closes the server-sent-request gap with less bespoke protocol code.
  Date: 2026-04-01

- Decision: move document lifecycle ownership into `pi/lsp/lib/server-manager.ts`.
  Rationale: document versions and open state belong to the running LSP session, so the manager that owns server instances should own synchronization state.
  Date: 2026-04-01

- Decision: preserve the existing top-level `lsp` tool actions and extension behavior while changing internals.
  Rationale: the goal is to improve correctness and reliability without expanding the user-visible API in this pass.
  Date: 2026-04-01

- Decision: key diagnostics listener registration and diagnostics caches by `ManagedServer.key` rather than bare server name.
  Rationale: once one server name can correspond to multiple root-scoped processes, listener deduplication by name would silently drop diagnostics from later roots.
  Date: 2026-04-06

- Decision: answer `workspace/configuration` directly from the server manager using the configured per-server settings object.
  Rationale: this keeps protocol completeness close to server lifecycle ownership and avoids scattering transport-specific request handling into the extension entrypoint.
  Date: 2026-04-06

## Outcomes & Retrospective

Completed on 2026-04-06. The `pi/lsp` package now has the three hardening changes this plan set out to deliver.

First, transport correctness improved. `pi/lsp/lib/lsp-client.ts` now uses `vscode-jsonrpc` over stdio, preserves the existing request and notification surface, adds `onRequest`, and rejects outstanding work when the client is destroyed. The new `pi/lsp/test/lsp-client.test.ts` covers request/response, diagnostics notifications, generic notifications, server-sent requests, timeouts, aborts, and teardown rather than low-level frame parsing.

Second, multi-root correctness improved. `pi/lsp/lib/server-manager.ts` now computes a composite runtime key from server name plus resolved root directory, returns root-aware managed servers, and exposes `getRunningServerForFile(filePath)` and `getRunningServerByKey(key)`. Formatting in `pi/lsp/extensions/lsp.ts` now uses file-aware lookup, and the tests prove that two sibling roots using the same language server name get distinct managed instances.

Third, document synchronization is now centralized. The server manager owns per-document version and text state, provides `syncDocumentFromDisk`, `syncDocumentContent`, and `saveDocument`, and answers `workspace/configuration` requests. `pi/lsp/lib/interceptor.ts` and `pi/lsp/lib/lsp-tool.ts` now both use those helpers, which means on-demand LSP queries synchronize untouched files before issuing requests and write/edit interception no longer maintains its own version map.

Validation was fully successful. All targeted LSP tests passed, and the full repository suite passed under `npm test` with zero failures. No deferred scope items were pulled into this implementation.

## Context and Orientation

The `pi/lsp` package is a self-contained pi extension package. `pi/lsp/extensions/lsp.ts` is the entrypoint that loads configuration, creates the server manager, attaches the write/edit interceptor, maintains a diagnostics cache for the session, and registers the unified `lsp` tool.

`pi/lsp/lib/lsp-client.ts` now uses `vscode-jsonrpc` over stdio. It exposes `createLspClient(stdin, stdout)` and an `LspClient` interface that supports outbound requests, outbound notifications, diagnostics callbacks, generic notifications, inbound request handling, and destroy-time cleanup.

`pi/lsp/lib/server-manager.ts` detects available servers from config, chooses a server definition by file extension, computes root directories from marker files such as `package.json`, starts language servers lazily, keys them by `(serverName, rootDir)`, and owns per-document synchronization state. This is now the single source of truth for server identity, root routing, and session-level document state.

`pi/lsp/lib/interceptor.ts` hooks `write` and `edit` tool results. It reads the changed file from disk, delegates synchronization to the server manager through injected helpers, optionally requests formatting, calls `didSave` through the manager, waits briefly for diagnostics, and appends a diagnostics block to the tool result.

`pi/lsp/lib/lsp-tool.ts` defines the single `lsp` tool. It handles actions such as `definition`, `hover`, `references`, and `diagnostics`. Before any file-scoped request other than `languages`, it now synchronizes the current file through the server manager so the language server sees current text.

Existing tests cover these areas. `pi/lsp/test/lsp-client.test.ts` now tests behavior-level transport guarantees. `pi/lsp/test/server-manager.test.ts` covers root marker detection, routing, detection, multi-root isolation, synchronization state, and idle shutdown. `pi/lsp/test/interceptor.test.ts` covers manager-backed synchronization and formatting flow. `pi/lsp/test/lsp-tool.test.ts` covers tool actions and synchronization ordering. `pi/lsp/test/extension.test.ts` covers extension registration and session lifecycle.

## Preconditions and Verified Facts

The following repository facts were verified in the current tree before writing this plan.

The repository root `package.json` contains the authoritative test script:

    "test": "node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'"

The `pi/lsp` package manifest at `pi/lsp/package.json` still has no local dependencies section. The repository root `package.json` now contains `"vscode-jsonrpc": "^8.2.1"`, and `package-lock.json` was generated at the repository root so Node-based root test execution can resolve the transport dependency.

`pi/lsp/lib/lsp-client.ts` now exports `createLspClient`, `toLspPosition`, and `fileUri`, and the `LspClient` interface includes `onRequest` in addition to request, notify, diagnostics, generic notifications, and destroy behavior.

`pi/lsp/lib/server-manager.ts` now exports `findNearestRootMarker`, `resolveServerBinary`, `createServerManager`, `ManagedServer`, and `ServerManager`. The `ServerManager` interface now exposes `getRunningServerForFile(filePath)`, `getRunningServerByKey(key)`, `syncDocumentFromDisk(filePath)`, `syncDocumentContent(filePath, content)`, and `saveDocument(filePath)`.

`pi/lsp/extensions/lsp.ts` now uses `getRunningServerForFile(filePath)` during formatting, wires diagnostics listeners lazily per runtime server key, and passes manager-backed sync helpers into both the interceptor and the `lsp` tool.

`pi/lsp/lib/interceptor.ts` only intercepts `write` and `edit`, still owns the recursion guard, and now delegates document lifecycle operations entirely to injected manager-backed helpers.

`pi/lsp/lib/lsp-tool.ts` still resolves file paths with `path.resolve` and converts line and column to LSP positions, but it now synchronizes file content from disk before serving file-scoped requests.

## Scope Boundaries

In scope are the transport swap to `vscode-jsonrpc`, root-aware server identity, and shared document synchronization before requests.

In scope are the tests required to prove those changes: `pi/lsp/test/lsp-client.test.ts`, `pi/lsp/test/server-manager.test.ts`, `pi/lsp/test/interceptor.test.ts`, `pi/lsp/test/lsp-tool.test.ts`, and any small updates needed in `pi/lsp/test/extension.test.ts`.

In scope is a repository-root dependency change in `package.json` so the new transport library resolves under the current test model.

Out of scope are new LSP tool actions, diagnostics pull fallback, hook modes, workspace diagnostics, rename application, code-action application, and large documentation changes beyond a short note if command or dependency setup changes.

Existing behavior that must stay unchanged includes the public `lsp` tool name, the existing action names, the canonical system prompt hint string in `pi/lsp/extensions/lsp.ts`, the current configuration file format in `pi/lsp/lib/config.ts`, and the current diagnostics-on-write plus format-on-write user experience.

## Milestones

The first milestone introduces the dependency and swaps the transport implementation in `pi/lsp/lib/lsp-client.ts`. At the end of this milestone, the package will still pass request, notification, timeout, and teardown tests, but the implementation will be backed by `vscode-jsonrpc` and will support inbound requests through `onRequest`. This milestone comes first because later milestones depend on a stable client abstraction.

The second milestone fixes server identity in `pi/lsp/lib/server-manager.ts`. At the end of this milestone, two files in different roots that resolve to the same server definition will produce distinct managed server instances. Formatting and other extension code will use file-aware server lookups rather than bare server-name lookups. This milestone comes second because it fixes an existing correctness bug without entangling document-sync logic.

The third milestone centralizes document synchronization and updates the interceptor and `lsp` tool to use it. At the end of this milestone, a document-scoped LSP query on an untouched file will open and synchronize that file before the request is sent, and write/edit interception will use the same synchronization path rather than its own version bookkeeping. This milestone comes last because it depends on the root-aware manager and the upgraded transport.

## Plan of Work

Start in `package.json` at the repository root. Add a `dependencies` section containing `vscode-jsonrpc`, then install it from the repository root so Node-based test execution can resolve it. If this repository conventionally tracks a generated `package-lock.json`, commit that file along with the manifest update. If it does not, keep the dependency declaration and any repository-standard generated artifacts only.

In `pi/lsp/lib/lsp-client.ts`, replace the hand-written frame parser and request map with a `vscode-jsonrpc` `MessageConnection` built from the existing stdio streams. Keep the exported helper functions `toLspPosition` and `fileUri`. Keep the `LspClient` surface largely stable so the rest of the package changes minimally, but add `onRequest` and implement it through the JSON-RPC connection. Preserve diagnostics convenience registration through `onDiagnostics` by translating `textDocument/publishDiagnostics` notifications into the existing callback shape. Implement transport error and close handling so `destroy()` always removes listeners, rejects or clears pending work, and does not leak stream listeners.

In `pi/lsp/test/lsp-client.test.ts`, replace frame-parser-specific tests with behavior tests that match the new implementation. Keep request/response and notification coverage. Add a test that registers `onRequest('workspace/configuration', handler)`, sends a framed request from the fake server side, and asserts the handler result is returned to the server. Add a test that `destroy()` cleans up without throwing after requests and listeners have been registered. Keep timeout coverage.

In `pi/lsp/lib/server-manager.ts`, change the running-server map so its key is a composite derived from the selected server name and resolved root directory. Add a helper that computes that key from a file path and server definition. Extend `ManagedServer` with `rootDir` and `key` so callers and tests can assert which root a server belongs to. Replace `getRunningServer(name)` with `getRunningServerForFile(filePath)` and, if needed for tests, `getRunningServerByKey(key)`. Update idle shutdown and `shutdownAll()` to iterate composite keys. Do not change how `resolveServerForFile(filePath)` chooses a server definition; it should still answer only which server definition matches by extension.

In `pi/lsp/extensions/lsp.ts`, update formatting so it asks the server manager for the running server associated with the target file rather than looking up by bare server name. Keep diagnostics listener registration where it is, but make sure it works no matter how many root-scoped server instances exist for the same server definition name.

In `pi/lsp/test/server-manager.test.ts`, add a failing test that creates two separate roots under one temporary directory, each with a matching root marker such as `package.json`, and asserts that `ensureServerForFile` returns two different managed servers with different `rootDir` or `key` values for files under those roots. Add a second test that proves `getRunningServerForFile` returns the correct root-scoped server after both instances exist. Keep current routing and status tests green.

In `pi/lsp/lib/server-manager.ts`, add document lifecycle state per managed server. Each managed server should track a map of document URI to an object containing at least the current LSP version number and the last synchronized text. Add methods on the manager with these exact responsibilities: one to ensure a document is synchronized from disk before a query, one to synchronize supplied content after a write or edit, and one to send `didSave` after the file is on disk. The disk-backed sync helper should read the current file contents, decide whether the document is unopened or stale, and send `didOpen` or `didChange` as appropriate. The supplied-content sync helper should use the same rules but skip the disk read because the caller already has the new text.

In `pi/lsp/lib/interceptor.ts`, remove the local `documentVersions` map. Keep the recursion guard. Replace direct `didOpen` and `didChange` notifications with calls into the new manager-backed sync helper exposed through injected dependencies. After formatting rewrites the file, call the same sync helper again with the formatted text before waiting for diagnostics. Keep output formatting unchanged.

In `pi/lsp/lib/lsp-tool.ts`, before any file-scoped LSP request other than `languages`, call a new dependency such as `syncDocumentFromDisk(filePath)` so the file is open and current on the server. For the `diagnostics` action, synchronize the document first and then read cached diagnostics. For position-based actions such as `definition`, `hover`, `references`, `implementation`, `rename`, `code_actions`, `incoming_calls`, and `outgoing_calls`, synchronize the file before building the request. Keep non-file actions unchanged.

In `pi/lsp/extensions/lsp.ts`, pass the new manager-backed sync functions into the interceptor and tool factories. This file is also the right place to keep diagnostics listeners attached to each started server instance, because it already owns the per-session diagnostics cache.

In `pi/lsp/test/interceptor.test.ts`, add a test that verifies the interceptor uses the injected sync helper rather than sending notifications directly. Add a test that formatting a file results in a second sync call with the formatted content. Remove assumptions about interceptor-local document versions because those versions will now live in the server manager.

In `pi/lsp/test/lsp-tool.test.ts`, add a test that a position-based action calls the injected sync helper before issuing the LSP request. Add a second test for the `diagnostics` action to prove the sync helper is invoked before cached diagnostics are rendered. Keep current action-contract coverage unchanged.

## Concrete Steps

All commands in this section are run from the repository root.

### Milestone 1: switch `pi/lsp/lib/lsp-client.ts` to `vscode-jsonrpc`

1. Add the new dependency at the repository root.

    npm install vscode-jsonrpc

Expected result: the repository root `package.json` gains a `dependencies` section containing `vscode-jsonrpc`, and Node can resolve the package from `pi/lsp/lib/lsp-client.ts`.

2. Rewrite `pi/lsp/test/lsp-client.test.ts` so it describes the end-state behavior instead of frame-parser internals. Keep tests for request/response, diagnostics notifications, timeouts, and notifications. Add a red-phase test for inbound requests handled through `onRequest`.

3. Run the LSP client tests in red phase.

    node --experimental-strip-types --test pi/lsp/test/lsp-client.test.ts

Expected result: at least the new inbound-request test fails because `onRequest` does not exist yet or the current client cannot answer the request.

4. Refactor `pi/lsp/lib/lsp-client.ts` to use `vscode-jsonrpc`. Remove the hand-written frame parser from production code. Keep `toLspPosition` and `fileUri`. Add `onRequest` to the `LspClient` interface and implement it.

5. Run the LSP client tests in green phase.

    node --experimental-strip-types --test pi/lsp/test/lsp-client.test.ts

Expected result: all tests in `pi/lsp/test/lsp-client.test.ts` pass.

6. Commit the transport milestone.

Suggested commit message:

    feat(lsp): use vscode-jsonrpc for LSP transport

### Milestone 2: make server identity root-aware

7. Add failing tests to `pi/lsp/test/server-manager.test.ts` for two roots under one temporary workspace using the same server definition name. Assert that `ensureServerForFile` returns distinct `ManagedServer` objects with different `rootDir` or `key` values. Add a second test for `getRunningServerForFile(filePath)`.

8. Run the server-manager tests in red phase.

    node --experimental-strip-types --test pi/lsp/test/server-manager.test.ts

Expected result: the new multi-root test fails because the current manager reuses one running server per bare server name.

9. Refactor `pi/lsp/lib/server-manager.ts` to compute a composite runtime key of server name plus resolved root directory. Extend `ManagedServer` with `rootDir` and `key`. Replace bare-name lookup helpers with file-aware helpers.

10. Update `pi/lsp/extensions/lsp.ts` so formatting uses `getRunningServerForFile(filePath)` or an equivalent file-aware lookup.

11. Run the server-manager tests in green phase.

    node --experimental-strip-types --test pi/lsp/test/server-manager.test.ts

Expected result: all server-manager tests pass, including the new multi-root assertions.

12. Run the extension tests to catch lookup regressions.

    node --experimental-strip-types --test pi/lsp/test/extension.test.ts

Expected result: all extension tests pass.

13. Commit the root-aware keying milestone.

Suggested commit message:

    feat(lsp): run one language server per root directory

### Milestone 3: centralize document synchronization and use it before queries

14. Add failing tests to `pi/lsp/test/lsp-tool.test.ts` that verify file-scoped actions call a synchronization helper before the LSP request. Add failing tests to `pi/lsp/test/interceptor.test.ts` that verify the interceptor delegates synchronization instead of owning document versions directly.

15. Run the tool and interceptor tests in red phase.

    node --experimental-strip-types --test pi/lsp/test/lsp-tool.test.ts pi/lsp/test/interceptor.test.ts

Expected result: the new synchronization-order tests fail because the current code sends requests without a shared sync path.

16. Refactor `pi/lsp/lib/server-manager.ts` to add document-state tracking and the three synchronization methods described above: synchronize from disk before query, synchronize supplied content after write/edit, and send `didSave` after disk writes.

17. Update `pi/lsp/lib/interceptor.ts` to call the new sync helper(s) and remove local `documentVersions` state.

18. Update `pi/lsp/lib/lsp-tool.ts` to synchronize from disk before file-scoped requests and before the `diagnostics` action reads cached diagnostics.

19. Update `pi/lsp/extensions/lsp.ts` to pass the new manager-backed synchronization functions into the interceptor and tool factories.

20. Run the targeted tests in green phase.

    node --experimental-strip-types --test pi/lsp/test/lsp-tool.test.ts pi/lsp/test/interceptor.test.ts pi/lsp/test/extension.test.ts

Expected result: all listed tests pass.

21. Run the full repository test suite.

    npm test

Expected result: the full suite passes with zero failures.

22. Commit the document-synchronization milestone.

Suggested commit message:

    feat(lsp): synchronize documents before LSP queries

## Testing and Falsifiability

This plan makes three falsifiable claims.

The first claim is that root-aware keying fixes multi-root correctness. To disprove it, create one temporary workspace with two child roots, ensure a server for a file in each root, and show that both calls still return the same managed server key or root directory. The test belongs in `pi/lsp/test/server-manager.test.ts` and must fail before the composite-key change and pass after it.

The second claim is that switching to `vscode-jsonrpc` enables server-sent request handling. To disprove it, register an inbound request handler in `pi/lsp/test/lsp-client.test.ts`, send a `workspace/configuration` request from the fake server side, and observe that no response is emitted or the process throws. The test must fail before the transport swap and pass after it.

The third claim is that on-demand `lsp` queries now synchronize documents before requests. To disprove it, create a mock sync helper and a mock LSP client in `pi/lsp/test/lsp-tool.test.ts`, invoke `definition`, and assert that the LSP request fires before synchronization or without synchronization. The test must fail before the manager-backed sync path exists and pass after it. Add the same style of assertion to `pi/lsp/test/interceptor.test.ts` so write/edit interception and on-demand queries are proven to use one shared synchronization model.

Run the targeted tests after each milestone. Do not rely only on `npm test` at the end because these failures are easier to diagnose in isolation.

## Validation and Acceptance

Acceptance for the first milestone is behavioral: run

    node --experimental-strip-types --test pi/lsp/test/lsp-client.test.ts

and expect all LSP client tests to pass, including the new server-sent request test. The old frame-parser-specific tests will have been removed or replaced because they no longer describe the production implementation.

Acceptance for the second milestone is behavioral: run

    node --experimental-strip-types --test pi/lsp/test/server-manager.test.ts

and expect the new multi-root test to pass, proving that two files in different roots no longer reuse one server instance. Then run

    node --experimental-strip-types --test pi/lsp/test/extension.test.ts

and expect extension registration and lifecycle tests to stay green.

Acceptance for the third milestone is behavioral: run

    node --experimental-strip-types --test pi/lsp/test/lsp-tool.test.ts pi/lsp/test/interceptor.test.ts

and expect the new synchronization-order assertions to pass. Then run

    npm test

and expect the full repository suite to pass with zero failures.

At the end of the full plan, a manual spot-check should also be possible: in a repository with two separate TypeScript project roots, invoking the `lsp` tool on files from each root during one session should route to the correct root-scoped server instance rather than cross-contaminating workspaces.

## Rollout, Recovery, and Idempotence

The rollout is safe because each milestone is independently shippable and keeps the system working.

If the `vscode-jsonrpc` migration causes unexpected regressions, stop after Milestone 1, update the plan, and debug within `pi/lsp/test/lsp-client.test.ts` before touching server-manager logic. If needed, the dependency addition and transport swap can be reverted independently of the later milestones.

If the composite-key milestone causes regressions in formatting or diagnostics listener wiring, revert the file-aware lookup changes in `pi/lsp/extensions/lsp.ts` while keeping the new server-manager tests as the guide for reimplementation.

The document-sync milestone is idempotent by design. Synchronizing a document from disk when the stored text matches should be a no-op. Synchronizing supplied content after a write/edit when the manager already holds the same text should also be a no-op. These rules must be encoded in the server manager so repeated calls do not bump document versions unnecessarily.

After all milestones land, there should be no leftover duplicate version bookkeeping in `pi/lsp/lib/interceptor.ts`. The server manager should be the single source of truth for open documents and versions.

## Artifacts and Notes

Key validation artifacts from implementation:

    $ node --experimental-strip-types --test pi/lsp/test/lsp-client.test.ts
    ✔ request/response correlation by id
    ✔ server-sent requests are handled through onRequest
    ✔ destroy rejects pending requests and remains safe after listeners are registered
    ℹ pass 11

    $ node --experimental-strip-types --test pi/lsp/test/server-manager.test.ts
    ✔ ensureServerForFile creates distinct servers for different roots
    ✔ getRunningServerForFile returns the correct root-scoped server
    ✔ syncDocumentContent opens once and changes on subsequent updates
    ℹ pass 14

    $ node --experimental-strip-types --test pi/lsp/test/lsp-tool.test.ts pi/lsp/test/interceptor.test.ts pi/lsp/test/extension.test.ts
    ✔ definition synchronizes before issuing the LSP request
    ✔ diagnostics action synchronizes the document before rendering cached diagnostics
    ✔ delegates document synchronization to the injected sync helper
    ℹ pass 34

    $ npm test
    ℹ pass 869
    ℹ fail 0

These excerpts are enough to prove the three claims in the plan without preserving full raw logs.

## Interfaces and Dependencies

At the end of this plan, `pi/lsp/lib/lsp-client.ts` must export an `LspClient` interface with at least these methods:

    request<T = unknown>(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>
    notify(method: string, params: unknown): void
    onDiagnostics(cb: (uri: string, diagnostics: unknown[]) => void): void
    onNotification(method: string, cb: (params: unknown) => void): void
    onRequest<TParams, TResult>(method: string, cb: (params: TParams) => TResult | Promise<TResult>): void
    destroy(): void

At the end of this plan, `pi/lsp/lib/server-manager.ts` must expose a `ManagedServer` shape that includes runtime identity and document state, at minimum:

    interface ManagedServer {
      name: string
      key: string
      rootDir: string
      rootUri: string
      client: LspClient | null
      lastActivity: number
    }

The `ServerManager` interface must include file-aware lookup and synchronization methods. The names may differ slightly if needed for repository style, but the responsibilities must exist and be covered by tests:

    getRunningServerForFile(filePath: string): ManagedServer | undefined
    syncDocumentFromDisk(filePath: string): Promise<ManagedServer | null>
    syncDocumentContent(filePath: string, content: string): Promise<ManagedServer | null>
    saveDocument(filePath: string): Promise<void>

The repository root `package.json` must contain a runtime dependency on `vscode-jsonrpc` because `pi/lsp` code is imported directly during root-level test runs.
