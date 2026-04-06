# Context File Approval Gate for Pi

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

When working in monorepos or across multiple Dropbox codebases, pi automatically discovers and injects every `AGENTS.md` and `CLAUDE.md` file it finds — walking from the current directory up through every ancestor to the filesystem root, plus the global config directory. These files are written by various teams with varying quality and intent, and their content is injected into the LLM system prompt verbatim with no user review.

After this change, a pi user can approve or deny each context file before its content reaches the LLM. Approvals are tracked by file content hash, so unchanged files pass through silently on subsequent sessions. New or modified files trigger a review prompt. The user can also permanently deny specific files. The result is that the user controls exactly which project instructions influence the agent's behavior, without losing the convenience of auto-discovery for files they trust.

The user can observe this working by starting pi in a directory that contains an AGENTS.md they have never approved. Instead of the file's content silently appearing in the system prompt, a select menu appears asking the user to approve, deny, view, or permanently block the file. On subsequent sessions in the same directory with the same file content, no prompt appears — the approval is remembered.


## Problem Framing and Constraints

Pi loads `AGENTS.md` / `CLAUDE.md` context files from three sources: the global agent config directory (`~/.pi/agent/`), every ancestor directory from cwd to the filesystem root, and the cwd itself. In a Dropbox monorepo environment, working in a subdirectory like `Code/server/paper/` means pi may pick up context files from `Code/server/paper/`, `Code/server/`, `Code/`, and potentially others. There are currently 38 such files under `~/Code/` alone.

These files are concatenated into the system prompt under a `# Project Context` heading, formatted as `## /absolute/path/to/AGENTS.md` followed by the file content. This content directly shapes LLM behavior with no opt-in or visibility beyond the startup header listing.

Constraints that shape the solution:

- Pi has no built-in flag to disable or filter context files (no `--no-context` equivalent). The extension API is the only control surface.
- The `before_agent_start` event provides `event.systemPrompt` which can be modified, but the context files are already embedded by the time it fires. The extension must strip denied content via string manipulation on the known format.
- The extension must work in interactive mode (full TUI with `ctx.ui` dialogs) and degrade safely in non-interactive modes (print, RPC, JSON) where UI prompts are no-ops.
- The approval store must be global (not per-project) since context files are identified by absolute path and the same file may be encountered from different working directories.
- The extension must not interfere with pi's own display of loaded context files in the startup header — that listing is cosmetic and happens before the extension can act.

This plan will not solve: customizing the content of approved files (accept/reject is binary), filtering by glob patterns or directories (each file is individually tracked), or preventing pi from reading the files in the first place (the extension operates post-discovery).


## Strategy Overview

Build a single-file pi extension (`context-approval.ts`) that hooks two events:

1. `session_start` — discover context files using the same algorithm pi uses (walk from cwd to root, check global dir), compute SHA-256 hashes, compare against a persisted approval store, and prompt the user for any new or changed files.

2. `before_agent_start` — for any files the user denied (session-only or permanently), surgically remove their content from the system prompt string before it reaches the LLM.

The approval store is a JSON file at `~/.pi/agent/context-approvals.json`, keyed by absolute path, containing the approved content hash and a timestamp. A `denied` flag on a record indicates permanent denial.

Files inside `~/.pi/agent/` are auto-trusted without prompting since the user put them there.

A `/context-approvals` command provides management: listing all tracked files with status, revoking individual approvals, and resetting the entire store.

This approach is proportionate because it adds one file, uses only stable extension APIs (`session_start`, `before_agent_start`, `ctx.ui.select`, `ctx.ui.editor`, `ctx.ui.notify`, `registerCommand`), requires no dependencies beyond Node.js built-ins, and degrades gracefully when the UI is unavailable.


## Alternatives Considered

**Use `.pi/SYSTEM.md` to replace the system prompt entirely.** This removes all default pi behavior (tool descriptions, guidelines, skills) and requires manually maintaining a system prompt. Disproportionate — the user wants to filter specific files, not rebuild the prompt from scratch.

**Add an `APPEND_SYSTEM.md` that instructs the LLM to ignore certain files.** This is unreliable — the LLM may or may not honor meta-instructions about ignoring parts of its own system prompt, and the unwanted content still consumes context window tokens.

**Write a `context` event handler to filter messages.** Context files are embedded in the system prompt, not sent as separate messages. The `context` event modifies the message array, not the system prompt. This would not work.

**Patch pi upstream to add `--no-context` support.** Would be ideal long-term but requires an upstream contribution, review cycle, and release. The extension approach works today and can be retired if pi gains native support.


## Risks and Countermeasures

**Risk: Pi's system prompt format changes (fail-open).** The extension strips content by searching for `## /path/to/AGENTS.md\n\n` markers followed by content. If pi changes this format, stripping will silently fail and denied content will reach the LLM. This is a **fail-open** design: the exact failure mode the user wanted to prevent (untrusted content reaching the LLM) is what happens when the extension's assumptions break. It is not fail-safe.
Countermeasure: After stripping, the `before_agent_start` handler performs a post-strip verification: for every path in `deniedPaths`, it checks whether the string `## <path>` still appears in the modified prompt. If any denied path is still present, the extension emits a warning via `ctx.ui.notify` telling the user that stripping failed for those paths, likely due to a pi format change. This makes a fail-open condition visible rather than silent. The stripping logic itself is also covered by unit tests written against pi's exact format, which serve as a canary for upstream changes.

Note: the extension uses two independent exact-string matches — per-file markers (`## /path\n\n`) and the section header (`# Project Context\n\nProject-specific instructions and guidelines:\n\n`). A pi update could change either independently, producing different partial-failure modes. The post-strip verification catches both.

**Risk: Race between pi's context loading and the extension's discovery.** Pi loads context files during resource loading; the extension re-discovers them independently at `session_start`. If the file changes between pi's read and the extension's read, the hash comparison is against different content than what is in the system prompt.
Countermeasure: This window is extremely narrow (milliseconds during startup). The consequence is that a changed file might be approved based on content slightly different from what is in the prompt for that one session. On the next session, the file will be re-hashed and the approval will be checked again.

**Risk: Large number of pending files blocks startup.** A user starting pi in a new monorepo area for the first time could face a dozen approval prompts.
Countermeasure: The notification at the start says how many files need review. A future improvement could add a "deny all remaining" or "approve all remaining" batch option. For now, the individual prompts are quick to dismiss.

**Risk: Non-interactive modes silently deny all files.** When `ctx.hasUI` is false (print mode, JSON mode), the extension denies all pending files without prompting.
Countermeasure: This is intentional and safe — non-interactive modes should not hang waiting for input. Previously approved files still pass through. The user can pre-approve files by running pi interactively first.

**Risk: UI prompt throws during approval flow.** If `ctx.ui.select` or `ctx.ui.editor` throws (e.g., the user kills the TUI during a prompt, or an internal error occurs), the extension would crash and pi's startup may fail or behave unpredictably.
Countermeasure: The approval prompt loop in `index.ts` wraps all `ctx.ui.select` and `ctx.ui.editor` calls in a try/catch. On any error, the file is treated as denied for the session (consistent with the fail-safe non-interactive behavior). A warning notification is emitted if possible.

**Risk: Approval store is unwritable.** If `~/.pi/agent/context-approvals.json` cannot be written (permissions, disk full, read-only filesystem), `saveApprovals` would throw and crash the extension mid-session.
Countermeasure: `saveApprovals` is wrapped in a try/catch in `index.ts`. On write failure, the extension logs a warning via `ctx.ui.notify` and continues with session-only tracking (approvals work for the current session but are not persisted). The user sees a warning and can fix the underlying issue.


## Progress

- [x] (2026-04-06 18:00Z) Research pi extension API, system prompt format, and context file discovery algorithm.
- [x] (2026-04-06 18:10Z) Write initial implementation of `context-approval.ts`.
- [x] (2026-04-06 18:10Z) Verify TypeScript compilation against existing extension setup.
- [x] (2026-04-06 19:00Z) Restructure as directory-based extension with `package.json` and test infrastructure.
- [x] (2026-04-06 19:00Z) Extract pure helper functions into `src/helpers.ts` and prompt stripping into `src/prompt.ts`.
- [x] (2026-04-06 19:05Z) Write unit tests for `sha256`, `shortenPath`, `isUserOwnedConfig`.
- [x] (2026-04-06 19:05Z) Write unit tests for `discoverContextFiles` using a temp directory tree.
- [x] (2026-04-06 19:05Z) Write unit tests for `loadApprovals` / `saveApprovals` round-trip.
- [x] (2026-04-06 19:10Z) Write unit tests for system prompt stripping logic (10 tests).
- [x] (2026-04-06 19:10Z) All 24 tests passing (14 helpers + 10 prompt).
- [ ] Manual validation in a real monorepo directory.
- [ ] Commit.


## Surprises & Discoveries

- Observation: Pi walks from cwd all the way to the filesystem root, not just to the git repo root. This means a context file at `/Users/bromanko/AGENTS.md` or even `/AGENTS.md` would be picked up.
  Evidence: `resource-loader.js` line 60: `while (true) { ... if (currentDir === root) break; }`

- Observation: Pi uses `AGENTS.md` before `CLAUDE.md` as candidates per directory, and stops at the first match per directory. So a directory with both files will only load `AGENTS.md`.
  Evidence: `resource-loader.js` line 30: `const candidates = ["AGENTS.md", "CLAUDE.md"];` with an early return after first match.

- Observation: The system prompt format uses the absolute path as a heading: `## /absolute/path/to/AGENTS.md\n\n<content>\n\n`. This is consistent between the custom-prompt and default-prompt code paths.
  Evidence: `system-prompt.js` lines 24-26 and 98-100: `prompt += \`## ${filePath}\n\n${content}\n\n\`;`

- Observation: The `before_agent_start` event handler return value is consumed by pi. If the handler returns `{ systemPrompt: <string> }`, pi applies it to `this.agent.state.systemPrompt`. This is the mechanism that makes prompt stripping work.
  Evidence: `runner.js` lines 598-606: handler result is checked for `result.systemPrompt !== undefined`, and if present, `currentSystemPrompt` is updated and `systemPromptModified` is set to true. The combined result is returned to the caller. `agent-session.js` line 752: calls `emitBeforeAgentStart(expandedText, currentImages, this._baseSystemPrompt)`. Lines 770-776: if `result?.systemPrompt` is truthy, sets `this.agent.state.systemPrompt = result.systemPrompt`; otherwise resets to `this._baseSystemPrompt`.

- Observation: Pi catches extension handler errors internally via try/catch in `runner.js` (lines 610-618) and emits them to `emitError`. A throwing handler does not crash pi — it logs the error and continues with other extensions. However, the session_start handler is in the generic `emit()` path which also catches errors, so an unhandled throw in our session_start handler would be caught by pi but would skip the remaining approval flow.


## Decision Log

- Decision: Auto-trust files inside `~/.pi/agent/` without prompting.
  Rationale: The user explicitly placed these files in their personal config directory. Prompting for them adds friction with no security benefit.
  Date: 2026-04-06

- Decision: Deny all pending files in non-interactive mode rather than approving them.
  Rationale: Fail-safe default. Untrusted content should not reach the LLM without explicit consent. The user can pre-approve by running interactively.
  Date: 2026-04-06

- Decision: Use absolute paths as keys in the approval store rather than content-addressable hashes.
  Rationale: Two different files may have the same content but different trust levels (e.g., a copy of a trusted file in an untrusted location). Path-based keying lets the user make per-location decisions. The content hash is stored as a value to detect changes.
  Date: 2026-04-06

- Decision: Implement as a single top-level `.ts` file initially, then restructure as a directory-based extension for testability.
  Rationale: The prototype was useful for validating the approach, but the helper functions (discovery, hashing, prompt stripping) need unit tests. The directory structure matches the existing MCP extension pattern in this repo.
  Date: 2026-04-06

- Decision: Acknowledge fail-open design and add post-strip verification in v1.
  Rationale: The extension's stripping mechanism depends on pi's undocumented system prompt format. If the format changes, denied content silently reaches the LLM — the exact failure mode the user is trying to prevent. Rather than deferring verification to a "future improvement," the `verifyStripping` function checks for residual denied-path markers after stripping and emits a visible warning when stripping failed. This converts silent failure into visible failure.
  Date: 2026-04-06

- Decision: Wrap UI calls and approval store writes in try/catch with fail-safe defaults.
  Rationale: The `session_start` handler runs during pi startup. An unhandled throw in `ctx.ui.select` or `saveApprovals` would abort the approval flow and potentially leave pi in an inconsistent state. Catching errors and defaulting to "denied" (for UI failures) or session-only tracking (for write failures) keeps the extension robust without compromising the fail-safe principle.
  Date: 2026-04-06


## Outcomes & Retrospective

(To be filled at major milestones and at completion.)


## Context and Orientation

The extension lives in the user's pi configuration repository at `~/Code/dbx-nix-config/configs/pi/extensions/`. This directory is referenced by the user's `settings.nix` which generates the pi `settings.json`. Pi auto-discovers extensions from this path.

The existing extension structure in this directory uses two patterns:

1. **Single-file extensions** like `dbx-bedrock.ts` — a single `.ts` file at the extensions root. Pi discovers and loads it directly via jiti.

2. **Directory-based extensions** like `figma-mcp/`, `dash-mcp/`, etc. — a directory containing `index.ts` (the entry point), a `src/` directory with implementation modules, a `test/` directory with `node:test` based tests, and a `package.json` declaring the extension entry point under `pi.extensions`.

All directory-based extensions in this repo share a workspace root `package.json` at `~/Code/dbx-nix-config/configs/pi/extensions/package.json` that lists them as workspaces and provides shared dev dependencies (`@types/node`, `tsx`, `typescript`).

Tests use Node.js built-in test runner (`node:test`) with `node:assert/strict`, run via `node --import tsx --test test/*.test.ts`.

Key files in the pi codebase (read-only, for reference):

- `dist/core/resource-loader.js` in the pi package — contains `loadContextFileFromDir` and `loadProjectContextFiles` which implement the AGENTS.md discovery algorithm the extension must replicate.
- `dist/core/system-prompt.js` in the pi package — contains `buildSystemPrompt` which formats context files into the system prompt as `## <path>\n\n<content>\n\n` under a `# Project Context` heading.


## Preconditions and Verified Facts

The following facts were verified against the current tree on 2026-04-06:

- `~/Code/dbx-nix-config/configs/pi/extensions/package.json` exists and declares workspaces for the directory-based extensions. The `devDependencies` include `@types/node`, `tsx`, and `typescript`.
- `~/Code/dbx-nix-config/configs/pi/extensions/context-approval.ts` exists as the initial prototype. It compiles cleanly with `tsc --noEmit`.
- The `before_agent_start` event return value is consumed by pi: if the handler returns `{ systemPrompt: string }`, pi applies it to `this.agent.state.systemPrompt` (verified in `runner.js` lines 598-606 and `agent-session.js` lines 770-776). This is the mechanism that makes prompt stripping effective.
- `~/Code/dbx-nix-config/configs/pi/settings.nix` includes `extensions = ["~/Code/dbx-nix-config/configs/pi/extensions"];` which causes pi to auto-discover all extensions in that directory.
- There are 38 `AGENTS.md` / `CLAUDE.md` files under `~/Code/` across multiple repos.
- There is no `~/.pi/agent/AGENTS.md` (the global config dir has no context file currently).
- There is no `~/.pi/agent/extensions/` directory — all extensions are loaded via the settings path.
- The `@mariozechner/pi-coding-agent` package is available as a peer dependency for type imports.


## Scope Boundaries

**In scope:**

- Restructure `context-approval.ts` from a single file into a directory-based extension (`context-approval/`) with `index.ts`, `src/` modules, `test/` directory, and `package.json`.
- Extract pure functions (hashing, path helpers, discovery, approval store I/O, prompt stripping) into testable modules.
- Write comprehensive unit tests for all extracted helpers.
- Write a unit test for the system prompt stripping logic using a synthetic prompt string that matches pi's known format.
- Register the new directory in the workspace `package.json`.
- Remove the old single-file `context-approval.ts`.

**Unchanged:**

- `settings.nix` — no changes needed; the extensions directory path already covers subdirectories.
- All other extensions in the directory.
- Pi itself — no upstream changes.

**Explicitly deferred:**

- Batch approve/deny ("approve all remaining", "deny all remaining") for many pending files.
- Glob-based allow/deny rules (e.g., "always deny anything under `Code/server/`").
- A diff view showing what changed when a previously-approved file is modified.
- Status widget showing approved/denied count in the footer.
- Integration with pi's startup header to annotate which files were filtered.


## Milestones

### Milestone 1: Restructure as Directory-Based Extension

Convert the working single-file prototype into the directory structure used by other extensions in this repo. After this milestone, pi loads the extension from `context-approval/index.ts`, the old `context-approval.ts` is gone, and the test runner executes against the new structure. No behavioral changes.

### Milestone 2: Extract and Test Pure Helpers

Move all pure functions (sha256, path shortening, user-owned-config check, context file discovery, approval store I/O) into `src/helpers.ts`. Write unit tests for each. After this milestone, running `node --import tsx --test test/*.test.ts` from the `context-approval/` directory passes all tests.

### Milestone 3: Extract and Test Prompt Stripping

Move the system prompt stripping logic into a pure function in `src/prompt.ts`. Write unit tests that construct synthetic system prompts matching pi's known format and verify that denied files are removed correctly, including edge cases (single file, multiple files, all files denied, empty Project Context cleanup). After this milestone, the prompt stripping logic is fully covered by tests.

### Milestone 4: Manual Validation and Commit

Start pi in a directory with unapproved AGENTS.md files. Verify the approval flow works end-to-end: prompt appears, approve/deny/view options work, approved files appear in context, denied files are stripped. Verify `/context-approvals`, `/context-approvals revoke`, and `/context-approvals reset` work. Verify subsequent sessions with unchanged files skip the prompt. Commit.


## Plan of Work

The work proceeds by creating the directory scaffold, moving code, extracting pure functions, writing tests, and validating.

In `context-approval/index.ts`, the default export function will import helpers from `./src/helpers.js` and `./src/prompt.js` and wire them into the `session_start`, `before_agent_start`, and `registerCommand` calls. The event handler logic (prompting, state management) stays in `index.ts`; only pure, side-effect-free functions move to `src/`.

In `context-approval/src/helpers.ts`, the following functions will be exported: `sha256(content: string): string`, `shortenPath(path: string, cwd: string): string`, `isUserOwnedConfig(filePath: string): boolean`, `discoverContextFiles(cwd: string): ContextFile[]`, `getApprovalsPath(): string`, `loadApprovals(): ApprovalStore`, `saveApprovals(store: ApprovalStore): void`. The types `ApprovalRecord`, `ApprovalStore`, and `ContextFile` will also be exported.

In `context-approval/src/prompt.ts`, two functions will be exported: `stripDeniedContextFiles(systemPrompt: string, deniedPaths: Set<string>): string` which encapsulates all the string manipulation logic currently inline in the `before_agent_start` handler, and `verifyStripping(systemPrompt: string, deniedPaths: Set<string>): string[]` which checks whether any denied path strings (`## <path>`) still appear in the prompt after stripping and returns the list of paths that failed to strip.

Tests in `context-approval/test/helpers.test.ts` will cover the pure helper functions using temp directories created with `node:fs/promises` `mkdtemp`. Tests in `context-approval/test/prompt.test.ts` will construct synthetic system prompt strings matching the exact format from `system-prompt.js` and verify stripping behavior.


## Concrete Steps

All paths below are relative to `~/Code/dbx-nix-config/configs/pi/extensions/`.

### Milestone 1 steps

**Step 1.1: Create the directory scaffold.**

Create the following files:

- `context-approval/package.json`
- `context-approval/index.ts`
- `context-approval/src/helpers.ts`
- `context-approval/src/prompt.ts`

The `package.json` should follow the pattern used by `figma-mcp/package.json`:

    {
      "name": "pi-context-approval",
      "private": true,
      "type": "module",
      "scripts": {
        "test": "node --import tsx --test test/*.test.ts"
      },
      "peerDependencies": {
        "@mariozechner/pi-coding-agent": "*"
      },
      "pi": {
        "extensions": ["./index.ts"]
      }
    }

**Step 1.2: Move types and helpers into `src/helpers.ts`.**

Move `ApprovalRecord`, `ApprovalStore`, `ContextFile`, `FileVerdict`, `APPROVALS_FILENAME`, `CONTEXT_FILENAMES`, and all the helper functions (`getAgentDir`, `getApprovalsPath`, `sha256`, `loadApprovals`, `saveApprovals`, `isUserOwnedConfig`, `discoverContextFiles`, `shortenPath`) from the current `context-approval.ts` into `context-approval/src/helpers.ts`. Export all of them.

**Step 1.3: Move prompt stripping into `src/prompt.ts`.**

Extract the system prompt stripping logic from the `before_agent_start` handler into a pure function `stripDeniedContextFiles(systemPrompt: string, deniedPaths: Set<string>): string` in `context-approval/src/prompt.ts`.

Also add a post-strip verification function: `verifyStripping(systemPrompt: string, deniedPaths: Set<string>): string[]`. This function checks whether the string `## <path>` still appears in `systemPrompt` for each path in `deniedPaths`. It returns an array of paths that failed to strip (empty array means success). This is used by the `before_agent_start` handler to emit a warning when stripping silently fails due to a pi format change.

**Step 1.4: Write the new `index.ts` entry point.**

The new `context-approval/index.ts` imports from `./src/helpers.js` and `./src/prompt.js` and contains only the extension factory function with the event handlers and command registration. The logic is mostly identical to the prototype, with these differences from the import restructuring:

- The `promptForApproval` function wraps the `ctx.ui.select` and `ctx.ui.editor` calls in a try/catch. On any error, the function returns `"denied"` (fail-safe default) and emits a warning notification if possible.
- The `session_start` handler wraps the `saveApprovals` call in a try/catch. On write failure, it emits a warning via `ctx.ui.notify` and continues with session-only tracking (the in-memory `deniedPaths` set is still correct).
- The `before_agent_start` handler calls `stripDeniedContextFiles` then `verifyStripping`. If `verifyStripping` returns any paths, it emits a warning: `"⚠️ Failed to strip N denied context file(s) — pi's prompt format may have changed"`. The modified prompt is still returned (partial stripping is better than none).

**Step 1.5: Register the workspace.**

Edit `package.json` (the workspace root) to add `"context-approval"` to the `workspaces` array.

**Step 1.6: Remove the old single-file extension.**

Delete `context-approval.ts` from the extensions root.

**Step 1.7: Verify compilation.**

From `context-approval/`, run:

    npx tsc --noEmit --esModuleInterop --moduleResolution node --target es2022 --module es2022 --strict index.ts

Expected: no output (clean compilation). If peer dependency resolution fails, run from the workspace root with `--skipLibCheck`.

### Milestone 2 steps

**Step 2.1: Create `test/helpers.test.ts`.**

Create `context-approval/test/helpers.test.ts` with the following tests:

- `sha256 produces consistent hex digest`: Call `sha256("hello")` and assert the result equals `"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"`.

- `sha256 changes when content changes`: Assert `sha256("a") !== sha256("b")`.

- `shortenPath returns relative path when under cwd`: Call `shortenPath("/home/user/project/AGENTS.md", "/home/user/project")` and assert it returns `"AGENTS.md"`.

- `shortenPath returns tilde path when under home`: Call `shortenPath(join(homedir(), "Code/repo/AGENTS.md"), "/tmp/other")` and assert the result starts with `"~/Code"`.

- `shortenPath returns absolute path otherwise`: Call `shortenPath("/etc/AGENTS.md", "/home/user")` and assert it returns `"/etc/AGENTS.md"`.

- `isUserOwnedConfig returns true for files in agent dir`: Set `PI_CODING_AGENT_DIR` to a temp directory, call `isUserOwnedConfig(join(tempDir, "AGENTS.md"))`, assert true. Restore env after.

- `isUserOwnedConfig returns false for files outside agent dir`: Assert `isUserOwnedConfig("/tmp/other/AGENTS.md")` returns false.

- `discoverContextFiles finds AGENTS.md walking up from cwd`: Create a temp directory tree: `root/AGENTS.md`, `root/sub/AGENTS.md`. Set `PI_CODING_AGENT_DIR` to a separate empty temp dir. Call `discoverContextFiles(join(root, "sub"))`. Assert both files are found, with the root file before the sub file (ancestors are ordered root-first). Restore env after. **Note:** On macOS, `/tmp` is a symlink to `/private/tmp`. Use `realpathSync` on the `mkdtemp` result before using paths in assertions, or the path comparisons will fail.

- `discoverContextFiles includes global dir file first`: Create a temp directory tree: `globalDir/AGENTS.md` (with content "global"), `root/AGENTS.md` (with content "root"). Set `PI_CODING_AGENT_DIR` to `globalDir`. Call `discoverContextFiles(root)`. Assert the first result is the global file and the second is the root file.

- `discoverContextFiles prefers AGENTS.md over CLAUDE.md`: Create a temp directory with both `AGENTS.md` and `CLAUDE.md`. Call `discoverContextFiles`. Assert only `AGENTS.md` is returned.

- `discoverContextFiles finds CLAUDE.md when AGENTS.md absent`: Create a temp directory with only `CLAUDE.md`. Call `discoverContextFiles`. Assert `CLAUDE.md` is found.

- `loadApprovals returns empty object when file missing`: Set `PI_CODING_AGENT_DIR` to an empty temp dir. Call `loadApprovals()`. Assert the result deep-equals `{}`.

- `saveApprovals then loadApprovals round-trips`: Set `PI_CODING_AGENT_DIR` to a temp dir. Call `saveApprovals({ "/tmp/test": { hash: "abc", approvedAt: "2026-01-01" } })`. Call `loadApprovals()`. Assert the result matches.

- `loadApprovals returns empty object on corrupt JSON`: Write invalid JSON to the approvals file. Call `loadApprovals()`. Assert `{}`.

**Step 2.2: Run tests.**

From `context-approval/`, run:

    npm test

Expected output: all tests pass. The number of tests should be 14. Each test name is printed. No failures.

### Milestone 3 steps

**Step 3.1: Create `test/prompt.test.ts`.**

Create `context-approval/test/prompt.test.ts` with the following tests. Each test constructs a synthetic system prompt string matching pi's format and calls `stripDeniedContextFiles`.

The synthetic prompt format (derived from `system-prompt.js`) is:

    <preamble text>

    # Project Context

    Project-specific instructions and guidelines:

    ## /path/to/first/AGENTS.md

    <first file content>

    ## /path/to/second/AGENTS.md

    <second file content>

    The following skills provide specialized instructions...
    Current date: 2026-04-06
    Current working directory: /some/dir

Tests:

- `strips a single denied file`: Build a prompt with one context file. Deny it. Assert the result does not contain the file's heading or content. Assert the `# Project Context` section is also removed (since it is now empty).

- `strips one of two files`: Build a prompt with two context files. Deny the first. Assert the first file's heading and content are gone. Assert the second file's heading and content remain. Assert `# Project Context` heading remains.

- `strips all files and cleans up empty section`: Build a prompt with two context files. Deny both. Assert the entire `# Project Context` section (heading, intro text, and both files) is removed. Assert the preamble and skills/date sections remain intact.

- `no-op when no paths are denied`: Build a prompt with one context file. Pass an empty denied set. Assert the prompt is unchanged.

- `no-op when denied path is not in prompt`: Build a prompt with one context file at path A. Deny path B. Assert the prompt is unchanged.

- `handles prompt with no Project Context section`: Build a prompt with no context files (no `# Project Context` heading). Deny a path. Assert the prompt is unchanged.

- `handles context file as last section before date`: Build a prompt where the context file section is immediately followed by `\nCurrent date:` (no skills section). Deny the file. Assert the content is stripped and the date line is preserved.

- `does not produce triple newlines after stripping`: Build a prompt with two context files separated by `\n\n`. Deny the first. Assert the result does not contain `\n\n\n` (three consecutive newlines). The splice should leave clean double-newline boundaries.

- `verifyStripping returns empty array when all denied paths are gone`: Build a prompt, strip a denied file, call `verifyStripping` on the result. Assert it returns `[]`.

- `verifyStripping returns failed paths when stripping missed`: Build a prompt with a context file. Call `verifyStripping` on the *unmodified* prompt with the file in `deniedPaths`. Assert it returns an array containing that path.

**Step 3.2: Run tests.**

From `context-approval/`, run:

    npm test

Expected output: all tests pass. The total count should be 24 (14 from helpers + 10 from prompt).

### Milestone 4 steps

**Step 4.1: Manual validation.**

Start pi in `~/Code/server/paper/` (which contains an AGENTS.md). On the first run after resetting approvals, verify:

1. A notification appears: "1 context file needs review".
2. A select menu shows the file path, tag `[NEW]`, line count, and size.
3. Selecting "👁 View content" opens the editor with the file content.
4. After viewing, the select menu reappears.
5. Selecting "✅ Approve" dismisses the prompt and the session starts normally.
6. Running `/context-approvals` shows the file as approved with today's date.

Start pi again in the same directory. Verify no prompt appears (file is unchanged and approved).

Edit the AGENTS.md content (add a blank line), start pi again. Verify a prompt appears with tag `[CHANGED]`. Deny it. Verify the file content is not in the system prompt by asking the agent "what AGENTS.md files are in your context?" Revert the edit.

Run `/context-approvals reset`. Verify the approvals are cleared.

**Step 4.2: Non-interactive mode validation.**

Reset approvals with `/context-approvals reset`, then exit pi. Run pi in non-interactive print mode in a directory with an unapproved AGENTS.md:

    pi --print "what context files do you see?"

Verify that pi does not hang (it should start and produce output). Verify that the unapproved file's content does not appear in the response (it was denied automatically in non-interactive mode). Then run pi interactively, approve the file, exit, and re-run the print command — verify the file's content now appears because it was previously approved.

**Step 4.3: Commit.**

Stage all files in `context-approval/` and the updated workspace `package.json`. Remove the old `context-approval.ts`. Commit with message:

    feat: context file approval gate extension

    Adds a pi extension that requires explicit user approval before
    AGENTS.md / CLAUDE.md content reaches the LLM. Approvals are
    tracked by content hash in ~/.pi/agent/context-approvals.json.

    - Prompts for new or changed files at session start
    - Strips denied file content from the system prompt
    - /context-approvals command for managing approvals
    - Auto-trusts files in ~/.pi/agent/ (user's own config)
    - Degrades safely in non-interactive modes


## Testing and Falsifiability

All tests use Node.js built-in test runner (`node:test`) with `node:assert/strict`, executed via `node --import tsx --test test/*.test.ts` from the `context-approval/` directory.

Tests for helpers (14 tests in `test/helpers.test.ts`):

- `sha256("hello")` returns `"2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"`. This is the known SHA-256 digest.
- `sha256("a") !== sha256("b")` — different inputs produce different hashes.
- `shortenPath` returns a cwd-relative path, a tilde path, or an absolute path depending on input relationship to cwd and home.
- `isUserOwnedConfig` returns true only for paths inside the agent dir pointed to by `PI_CODING_AGENT_DIR`.
- `discoverContextFiles` walks up from cwd, finds files in ancestor order, prefers `AGENTS.md` over `CLAUDE.md`, and includes the global dir. A separate test verifies global dir files appear first.
- `loadApprovals` / `saveApprovals` round-trips correctly, returns `{}` when file is missing, returns `{}` when file contains invalid JSON.

All `discoverContextFiles` tests that create temp directories use `realpathSync` on the `mkdtemp` result before using paths in assertions (macOS `/tmp` → `/private/tmp` symlink).

Tests for prompt stripping (10 tests in `test/prompt.test.ts`):

- Stripping one file from a single-file prompt removes the `# Project Context` section entirely.
- Stripping one of two files leaves the other intact.
- Stripping all files removes the entire `# Project Context` section.
- An empty denied set leaves the prompt unchanged.
- A denied path not present in the prompt leaves the prompt unchanged.
- A prompt with no `# Project Context` section is left unchanged.
- A context file immediately before `\nCurrent date:` (no skills section) is stripped correctly.
- No triple-newline artifacts appear after stripping a file between two others.
- `verifyStripping` returns empty array when all denied paths were successfully removed.
- `verifyStripping` returns the list of paths that failed to strip when the prompt was not modified.

If the system prompt format claim is false — meaning pi changes how it formats context files — the prompt stripping tests will fail because they are written against the exact format observed in `system-prompt.js`. This is intentional: the tests serve as a canary for format changes.


## Validation and Acceptance

After all milestones, the following are true:

1. Running `npm test` from `context-approval/` produces 24 passing tests and 0 failures.

2. Starting pi in a directory with an unapproved AGENTS.md triggers a review prompt. Approving it stores the hash. Starting pi again in the same directory with the same file triggers no prompt.

3. Modifying the file and restarting pi triggers a new review prompt with `[CHANGED]` tag.

4. Denying a file causes the agent to not see its content. This is verifiable by asking the agent "what project context files are loaded?" — the denied file should not appear.

5. `/context-approvals` lists all tracked files with correct status. `/context-approvals revoke` allows removing an entry. `/context-approvals reset` clears all entries.

6. `~/.pi/agent/context-approvals.json` contains valid JSON with path keys, hash values, and timestamps after approvals are made.


## Rollout, Recovery, and Idempotence

The extension is additive. It does not modify any existing files, does not change pi's behavior for users who do not have it installed, and can be removed by deleting the `context-approval/` directory.

If the extension malfunctions, the worst case is that denied file content leaks into the system prompt (the same as the current behavior without the extension). There is no scenario where the extension causes approved content to be stripped — it only acts on paths in the `deniedPaths` set, which is populated exclusively by explicit user denial or permanent-deny records.

The approval store at `~/.pi/agent/context-approvals.json` can be deleted at any time to reset all approvals. The extension recreates it as needed.

Running `/context-approvals reset` inside a session clears the store and the in-memory denied set. The user should then `/reload` to re-evaluate context files.

All steps are safe to repeat. Re-running the restructure produces the same file layout. Re-running tests is idempotent (temp directories are created fresh each run). Re-approving an already-approved file updates the timestamp but changes nothing else.


## Artifacts and Notes

Pi's system prompt format for context files (from `system-prompt.js`):

    prompt += "\n\n# Project Context\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path: filePath, content } of contextFiles) {
        prompt += `## ${filePath}\n\n${content}\n\n`;
    }

Pi's context file discovery algorithm (from `resource-loader.js`):

    candidates = ["AGENTS.md", "CLAUDE.md"]  // first match per dir wins
    1. Check global agent dir (~/.pi/agent/)
    2. Walk from cwd up to filesystem root, collecting matches
    3. Prepend ancestors in root-first order, then append to global

The SHA-256 of "hello" is `2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824`, used as a known-good test vector.


## Interfaces and Dependencies

No external dependencies. The extension uses only Node.js built-ins:

- `node:crypto` — `createHash` for SHA-256
- `node:fs` — `existsSync`, `readFileSync`, `writeFileSync`, `mkdirSync`
- `node:os` — `homedir`
- `node:path` — `join`, `resolve`

Peer dependency on `@mariozechner/pi-coding-agent` for types: `ExtensionAPI`, `ExtensionContext`.

In `context-approval/src/helpers.ts`, define and export:

    export interface ApprovalRecord {
      hash: string;
      approvedAt: string;
      denied?: boolean;
    }

    export type ApprovalStore = Record<string, ApprovalRecord>;

    export interface ContextFile {
      path: string;
      content: string;
    }

    export type FileVerdict = "approved" | "denied";

    export function getAgentDir(): string
    export function getApprovalsPath(): string
    export function sha256(content: string): string
    export function loadApprovals(): ApprovalStore
    export function saveApprovals(store: ApprovalStore): void
    export function isUserOwnedConfig(filePath: string): boolean
    export function discoverContextFiles(cwd: string): ContextFile[]
    export function shortenPath(path: string, cwd: string): string

In `context-approval/src/prompt.ts`, define and export:

    export function stripDeniedContextFiles(
      systemPrompt: string,
      deniedPaths: Set<string>,
    ): string

    /** Returns paths from deniedPaths whose ## marker still appears in the prompt. */
    export function verifyStripping(
      systemPrompt: string,
      deniedPaths: Set<string>,
    ): string[]
