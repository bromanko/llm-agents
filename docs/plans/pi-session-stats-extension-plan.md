# Add a `/session-stats` pi command for cross-session token and cost reporting

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.


## Purpose / Big Picture

After this change, a pi user can run `/session-stats` and get a **system-wide** aggregate of token usage and cost across all saved sessions on the machine, spanning every project - something pi's built-in `/session` command cannot do because it only reports on the current session. The command accepts user-friendly range expressions such as `today`, `last 7 days`, `this month`, `all time`, and explicit `YYYY-MM-DD..YYYY-MM-DD` ranges, and optionally shows a compact breakdown by day, project, or model.

The user-visible value: they can answer "how many tokens did I use this week, across everything?" without reading raw JSONL files, writing scripts, or installing an always-on skill. The command is deterministic, local, and never invokes a model.


## Problem Framing and Constraints

Pi already exposes current-session usage via `/session` and the footer, but there is no built-in cross-session or cross-project aggregate. The user wants exactly that: system-wide totals spanning every project directory that has saved sessions under `~/.pi/agent/sessions/`. A normal skill would not be appropriate because skill descriptions are injected into the system prompt on every turn, adding persistent overhead for a feature that is only needed on demand. A slash command extension is the right vehicle.

The command must work from saved pi session files only. Ephemeral `--no-session` runs are invisible, and the implementation must say so in its help text. The feature must remain proportionate: this is a local report, not a billing dashboard, cloud sync, or provider reconciliation tool. Session files may be migrated to the current format version as a side effect of parsing (this is pi's standard behavior and is acceptable).


## Strategy Overview

Implement this as a new extension package under `pi/session-stats/` that registers a slash command `/session-stats`. The command handler will parse the user's range expression and optional breakdown selector, then perform a **single-pass scan** of every session file under `~/.pi/agent/sessions/`, extract assistant-message usage, aggregate totals, and render the result in a lightweight overlay.

The critical design decision is to reuse pi's exported low-level session helpers for a **one-pass, system-wide scan** without the double I/O that `SessionManager.listAll()` + `SessionManager.open()` would cause. Pi's `@mariozechner/pi-coding-agent` package exports three key functions that together provide everything needed:

- `getAgentDir()` - returns the path to `~/.pi/agent`, from which the `sessions/` subdirectory tree can be discovered.
- `loadEntriesFromFile(path)` - reads and parses a single session JSONL file into an array of typed `FileEntry` objects (header + entries). Handles malformed lines gracefully.
- `migrateSessionEntries(entries)` - runs in-memory migration to the current session format version. Mutates the array in place.

The scanner discovers all `.jsonl` files under `~/.pi/agent/sessions/`, and for each file calls `loadEntriesFromFile()` once, then `migrateSessionEntries()`, then extracts the header (for `cwd`) and iterates entries to collect assistant usage - all from the same parsed array. This avoids the double-parse problem: `listAll()` already reads every file to build `SessionInfo`, and `open()` would read each file again.

Pi's `@mariozechner/pi-ai` package defines the `AssistantMessage` type with its `Usage` interface that carries `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost` fields. The jj-footer extension already demonstrates the pattern of iterating entries, type-checking for assistant messages, and summing usage - this plan follows the same approach at cross-session scale.

The only genuinely new code is: session file discovery, command argument parsing, local-time date range resolution, cross-session duplicate collapse, breakdown grouping, and report formatting. Everything else is delegation to pi builtins.

To avoid inflated totals from forked sessions that copy history, the aggregator collapses duplicate assistant messages using a stable fingerprint derived from message timestamp, provider, model, and usage fields. The report surfaces how many duplicates were collapsed so the user understands the accounting.


## Alternatives Considered

The simplest alternative is a shell script that greps JSONL files and sums numbers. That would skip pi's type system, miss session format migrations, not appear in slash-command discovery, and duplicate argument parsing that extensions already solve.

Another option is `SessionManager.listAll()` for discovery followed by `SessionManager.open()` for each session. This was the previous plan but was rejected because it causes **double I/O**: `listAll()` already reads and fully parses every session file to build `SessionInfo` (including `allMessagesText`), and `open()` then reads and parses each file again. For a system-wide scan touching potentially hundreds of session files, this is wasteful. The one-pass approach using `loadEntriesFromFile()` + `migrateSessionEntries()` reads each file exactly once.

A third option is to call `AgentSession.getSessionStats()` per session. However, that requires constructing a full `AgentSession` with an `Agent`, model, and resource loader - far more machinery than needed.

A fourth option is to skip duplicate collapse and document the caveat. That is the lowest-effort path, but it makes a "total usage" tool least trustworthy for exactly the users who fork frequently. A fingerprint-based collapse using fields already present on every assistant message is proportionate for V1.


## Risks and Countermeasures

The biggest correctness risk is double-counting history copied into forked sessions. The countermeasure is to fingerprint each assistant message using a SHA-256 hash over the concatenation of `message.timestamp`, `message.provider`, `message.model`, `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`, and `usage.cost.total`. These fields are stable across file copies because pi writes them from the original assistant response. The aggregator counts unique fingerprints and surfaces the duplicate count in the report.

The next risk is date-range ambiguity. "Today" and "this month" are user-local calendar concepts. The plan resolves this explicitly: all friendly ranges are interpreted in local time, the resolved start and end dates are formatted in local time, and tests assert local calendar components rather than UTC strings.

Performance when the session store grows large is a potential concern. The one-pass scanner reads each file exactly once using `loadEntriesFromFile()`, which is the minimum possible I/O. For V1, the command scans all sessions and shows a loader overlay while working. No indexing or caching is needed unless profiling later shows a real problem.

Malformed or partially written session files are handled gracefully. `loadEntriesFromFile()` skips malformed JSON lines and returns an empty array for files without a valid session header. The scanner counts files that fail to load (I/O errors) or return no valid entries as warnings, and surfaces the warning count in the report. This is more accurate than relying on `SessionManager.listAll()` which silently drops invalid files.

Session file migration is a known side effect. `migrateSessionEntries()` mutates entries in memory, and `SessionManager.open()` rewrites files on disk if migration was needed. Since the one-pass scanner uses `loadEntriesFromFile()` (read-only) plus in-memory migration only, it does **not** rewrite session files. If the user prefers files to be migrated on disk, they can open them normally through pi. This is acceptable.

A final risk is that `loadEntriesFromFile`, `migrateSessionEntries`, and `getAgentDir` are not available as npm dependencies - they are injected by the pi runtime. The plan handles this the same way every other extension in this repository does: import at the TypeScript level for development, and rely on pi's runtime injection at execution time. The scanner module that calls these functions is tested via integration tests using real temp-directory fixtures, while pure library modules that need to be testable without the pi runtime accept plain data.


## Progress

- [x] (2026-04-03 00:00Z) Wrote the initial ExecPlan.
- [x] (2026-04-03 12:00Z) Rewrote ExecPlan to use pi's built-in SessionManager APIs instead of reinventing session parsing.
- [x] (2026-04-03 18:00Z) Revised ExecPlan: replaced `listAll()` + `open()` with one-pass scanner using `loadEntriesFromFile()` + `migrateSessionEntries()` to eliminate double I/O. Clarified system-wide scope. Strengthened extension tests and date-range tests.
- [ ] Create `pi/session-stats/` package skeleton and register in `package.json`.
- [ ] Implement and test command argument parsing plus local-time date range resolution.
- [ ] Implement and test session scanning, entry extraction, and cross-session aggregation.
- [ ] Implement and test report formatting.
- [ ] Implement extension command handler with overlay.
- [ ] Update documentation and run full validation.


## Surprises & Discoveries

- Observation: pi's `SessionManager` class already provides `listAll()` for cross-project session discovery and `open(path)` for loading any session file into typed entries, making custom JSONL parsing unnecessary.
  Evidence: `session-manager.d.ts` exports `static listAll(onProgress?)` and `static open(path, sessionDir?)`.

- Observation: however, `listAll()` fully parses every session file (building `SessionInfo` with `allMessagesText`), and `open()` parses each file again. For a system-wide scan this means double I/O with no user-visible benefit.
  Evidence: `session-manager.js` shows `buildSessionInfo()` reads and parses entire file contents; `open()` calls `loadEntriesFromFile()` independently.

- Observation: pi exports `loadEntriesFromFile(path)` and `migrateSessionEntries(entries)` as public functions from `@mariozechner/pi-coding-agent`. Together they provide a single-pass read-parse-migrate path without the overhead of constructing full `SessionManager` objects.
  Evidence: `dist/index.d.ts` re-exports both; `loadEntriesFromFile` returns `FileEntry[]` (header + entries); `migrateSessionEntries` mutates entries in place to current version.

- Observation: `loadEntriesFromFile()` is read-only - it does not write back to disk. `migrateSessionEntries()` mutates the in-memory array only. Only `SessionManager`'s constructor path (`setSessionFile`) calls `_rewriteFile()` after migration.
  Evidence: `session-manager.js` line ~454 shows the rewrite happens inside `setSessionFile`, not in `loadEntriesFromFile` or `migrateSessionEntries`.

- Observation: pi exports `getAgentDir()` from `@mariozechner/pi-coding-agent`, returning `~/.pi/agent`. The sessions root is `${getAgentDir()}/sessions/`.
  Evidence: `dist/config.d.ts` exports `declare function getAgentDir(): string`; `dist/index.d.ts` re-exports it.

- Observation: pi's `SessionManager` exports `getDefaultSessionDir(cwd, agentDir?)` as a public function, resolving the session directory for any cwd.
  Evidence: `session-manager.d.ts` exports `declare function getDefaultSessionDir(cwd: string, agentDir?: string): string`.

- Observation: the jj-footer extension already implements the exact pattern of iterating session entries, type-checking for assistant messages with usage, and summing token/cost totals.
  Evidence: `pi/jj/extensions/jj-footer.ts` lines 100-190 define `isUsageLike`, `isAssistantMessageWithUsage`, `isAssistantMessageEntry`, and `computeSessionStats`.

- Observation: `SessionInfo` returned by `listAll()` includes `path`, `cwd`, `created`, `modified`, and `messageCount`, enabling cheap pre-filtering before opening files.
  Evidence: `session-manager.d.ts` `SessionInfo` interface.

- Observation: assistant messages in session JSONL carry `timestamp` as a number (milliseconds since epoch) on the `message` object, and the enclosing `SessionEntryBase` carries `timestamp` as an ISO string. Both are available for date filtering.
  Evidence: real session file shows `"messageTimestamp": 1772641949769` on the message and `"timestamp": "2026-03-04T16:32:34.232Z"` on the entry.

- Observation: test files must not live inside `pi/.../extensions/` directories because pi auto-loads every `*.ts` file there.
  Evidence: `README.md` states extension tests belong in `test/extensions/` and shared code belongs in package-local `lib/` directories.

- Observation: `SessionManager.open()` and `listAll()` are imported from `@mariozechner/pi-coding-agent`, which is only available at pi runtime, not as an npm dependency. Pure library code that needs to be testable standalone must accept plain data, not pi types directly.
  Evidence: all existing extension tests use `test/helpers.ts` mocks and never import `SessionManager` directly.


## Decision Log

- Decision: rewrite the plan to use pi's built-in `SessionManager.listAll()` and `SessionManager.open()` instead of custom JSONL scanning.
  Rationale: the original plan reinvented session file discovery, JSONL parsing, entry type checking, and session directory resolution - all of which pi already provides as public, typed, migration-aware APIs. Using builtins reduces code by roughly 60%, eliminates format drift risk, and produces a more trustworthy feature.
  Date: 2026-04-03

- Decision: replace `listAll()` + `open()` with a one-pass scanner using `getAgentDir()` for discovery plus `loadEntriesFromFile()` and `migrateSessionEntries()` for parsing.
  Rationale: `listAll()` fully parses every session file to build `SessionInfo` (including `allMessagesText`), and `open()` then re-reads and re-parses each file. For a system-wide scan this doubles I/O for no user-visible benefit. The exported low-level helpers read each file exactly once and provide the same migration and type safety. This also gives accurate warning accounting since the scanner owns the file loop.
  Date: 2026-04-03

- Decision: implement as a slash-command extension, not a skill.
  Rationale: skill descriptions are injected into the system prompt on every turn. This feature is deterministic local bookkeeping, not model-guided reasoning.
  Date: 2026-04-06

- Decision: V1 is interactive-first and requires UI availability.
  Rationale: the command should feel like built-in `/session`. Showing output in an overlay avoids polluting conversation context.
  Date: 2026-04-06

- Decision: interpret friendly ranges in local time, not UTC.
  Rationale: phrases like "today" and "this month" are user-local calendar concepts.
  Date: 2026-04-06

- Decision: collapse duplicate assistant messages using SHA-256 over `[timestamp, provider, model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost.total]`.
  Rationale: these fields are stable across file copies from forks and uniquely identify an assistant turn. Including content blocks would be expensive and unnecessary.
  Date: 2026-04-03

- Decision: keep V1 scope to one command with one optional breakdown selector (`day`, `project`, or `model`) plus a built-in compact summary.
  Rationale: covers the target use case without scope creep into a report generator.
  Date: 2026-04-06

- Decision: structure pure library code to accept plain data (numbers, strings, simple interfaces) rather than pi runtime types, so it can be tested without the pi runtime.
  Rationale: matches the existing repository pattern where library modules under `pi/<feature>/lib/` are independently testable and only the thin extension entrypoint imports pi types.
  Date: 2026-04-03


## Outcomes & Retrospective

(To be filled at major milestones and at completion.)


## Context and Orientation

This repository packages pi extensions under `pi/<feature>/extensions/`, shared implementation under `pi/<feature>/lib/`, and extension-specific tests either alongside library modules as `*.test.ts` or under `test/extensions/` when the subject under test is an extension entrypoint.

The files that matter most for this work are:

`package.json` declares extension discovery paths under the `pi.extensions` key. The new extension path `./pi/session-stats/extensions` must be added here so the package exposes `/session-stats`.

`test/helpers.ts` provides `createMockExtensionAPI()`, which returns a `MockExtensionAPI` used by extension tests throughout this repository. It includes `registerCommand`, `on`, `exec`, and `getHandlers` stubs. Its `registerCommand` is a no-op by default - tests that need to capture registrations override it (as seen in `test/extensions/git-worktree.test.ts` and `test/extensions/web-search.test.ts`). It does not include `sessionManager` - extension tests that need session data must mock it separately.

`pi/jj/extensions/jj-footer.ts` is the best reference for how to iterate session entries and sum assistant usage. It defines runtime type guards `isRecord`, `isNumber`, `isUsageLike`, `isAssistantMessageWithUsage`, and `isAssistantMessageEntry`, and a `computeSessionStats` function that sums usage fields. This plan extracts a similar but broader pattern into reusable library code.

`pi/recap/extensions/recap.ts` is the best reference for showing an overlay: it uses `ctx.ui.custom(...)` with a `BorderedLoader` for the loading phase and a bordered overlay for the result display.

Pi's session store saves sessions as JSONL files under `~/.pi/agent/sessions/<encoded-cwd>/`. The `<encoded-cwd>` directory name encodes the working directory with `/` replaced by `-`. Each file starts with a `SessionHeader` line (containing `type: "session"`, `version`, `id`, `timestamp`, `cwd`, and optional `parentSession`), followed by `SessionEntry` objects with `type`, `id`, `parentId`, and `timestamp` fields. Assistant responses are stored as `SessionMessageEntry` objects where `type === "message"` and `message.role === "assistant"`. Those messages carry a `usage` object with this shape (from `@mariozechner/pi-ai`):

    interface Usage {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      totalTokens: number;
      cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
    }

Assistant messages also carry `provider: string`, `model: string`, `stopReason: string`, and `timestamp: number` (milliseconds since epoch).

There is currently no `pi/session-stats/` directory in the repository. The command name `/session-stats` does not collide with any existing command.


## Preconditions and Verified Facts

`package.json` currently registers these extension directories under `pi.extensions`: `./pi/chrome-devtools-mcp/extensions`, `./pi/ci-guard/extensions`, `./pi/code-review/extensions`, `./pi/design-studio/extensions`, `./pi/files/extensions`, `./pi/git/extensions`, `./pi/jj/extensions`, `./pi/live-edit/extensions`, `./pi/lsp/extensions`, `./pi/search/extensions`, `./pi/tmux-titles/extensions`, `./pi/web/extensions`, `./pi/http-bridge/extensions`, and `./pi/recap/extensions`. There is no `./pi/session-stats/extensions` entry yet.

The authoritative test command from the repository root is `npm test`, which runs `node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'`. A single test file is run with `node --experimental-strip-types --test path/to/file.test.ts`.

Pi's `@mariozechner/pi-coding-agent` package exports the following types and functions used by this plan (verified from `dist/index.d.ts`):

- `getAgentDir()` function returning the path to `~/.pi/agent`. The sessions root is `${getAgentDir()}/sessions/`.
- `loadEntriesFromFile(path)` function that reads a session JSONL file and returns `FileEntry[]` (header + entries). Returns empty array for missing or headerless files. Skips malformed JSON lines. Does not write to disk.
- `migrateSessionEntries(entries)` function that runs in-memory migration to the current session format version. Mutates the array in place.
- `SessionEntry`, `SessionMessageEntry`, `SessionHeader`, `FileEntry`, `parseSessionEntries` (function), `getDefaultSessionDir` (function).
- `SessionManager` class (not used in the hot path, but available for reference).
- `SessionInfo` interface with fields `path`, `cwd`, `name`, `created`, `modified`, `messageCount`, `firstMessage`, `id`, `parentSessionPath`.
- `BorderedLoader` class for loading overlays.
- `getMarkdownTheme()` for rendering markdown in overlays.

Pi's `@mariozechner/pi-ai` package exports the `AssistantMessage` type with `role`, `provider`, `model`, `timestamp`, `usage` (type `Usage`), `stopReason`, and `content` fields.

The `ReadonlySessionManager` type (which is what `ctx.sessionManager` provides in extension handlers) includes `getSessionDir()`, `getEntries()`, `getBranch()`, `getHeader()`, `getSessionId()`, `getSessionFile()`, and `getSessionName()`.

A real assistant message entry in a session JSONL file looks like this (fields relevant to this feature):

    {
      "type": "message",
      "id": "b0669e5a",
      "parentId": "a956d482",
      "timestamp": "2026-03-04T16:32:34.232Z",
      "message": {
        "role": "assistant",
        "provider": "openai-codex",
        "model": "gpt-5.3-codex",
        "stopReason": "toolUse",
        "timestamp": 1772641949769,
        "usage": {
          "input": 5051,
          "output": 220,
          "cacheRead": 0,
          "cacheWrite": 0,
          "totalTokens": 5271,
          "cost": {
            "input": 0.00883925,
            "output": 0.00308,
            "cacheRead": 0,
            "cacheWrite": 0,
            "total": 0.01191925
          }
        },
        "content": [...]
      }
    }


## Scope Boundaries

In scope for V1: a new extension command `/session-stats` that scans **all saved sessions system-wide** (across all projects on the machine); parsing of friendly ranges (`today`, `yesterday`, `last 7 days`, `last 30 days`, `this week`, `last week`, `this month`, `last month`, `all time`, and explicit `YYYY-MM-DD..YYYY-MM-DD`); one optional breakdown selector (`by day`, `by project`, or `by model`); aggregate token and cost totals; duplicate collapse across forked session history; compact interactive rendering in an overlay; command argument completions; and a `--help` path.

Also in scope: transparent caveats in the report and help text explaining that the command scans all saved sessions system-wide, `--no-session` runs are invisible, malformed files may be skipped, and totals reflect whatever usage pi recorded.

Out of scope for V1: provider billing reconciliation, JSON/CSV export, persistent dashboards, charts, multiple simultaneous breakdown selectors, configuration files, mutating session files, any model call, and any skill implementation. Nothing in `skills/` should be added or modified.


## Milestones

Milestone 0 creates the package skeleton and registers the extension. At the end, the directory structure exists, `package.json` is updated, and `npm test` still passes with no new test failures.

Milestone 1 implements command argument parsing and local-time date range resolution. These are pure functions with no pi runtime dependency, fully testable in isolation. At the end, a developer can parse strings like `last 7 days by project` into a normalized command request and resolve the date range in local time. This comes first because every later module depends on understanding what the user asked for.

Milestone 2 implements entry extraction, session scanning, and cross-session aggregation. This is the core correctness milestone. It has two layers: pure library code that extracts usage records from untyped entry arrays and aggregates them (fully testable without pi runtime), and a scanner module that discovers session files under `~/.pi/agent/sessions/`, parses each file once using `loadEntriesFromFile()` + `migrateSessionEntries()`, and feeds entries to the extractor. At the end, all extraction, scanning, and aggregation logic is proven correct against fixture data including a duplicate-collapse scenario.

Milestone 3 implements report formatting. At the end, a developer can produce a formatted plain-text report from an aggregated stats object, covering all breakdown variants.

Milestone 4 wires the extension command: argument completions, UI guard, loader overlay, delegation to the scanner and aggregator, and overlay rendering. At the end, `/session-stats` works interactively.

Milestone 5 completes documentation and end-to-end validation.


## Plan of Work

Create `pi/session-stats/extensions/session-stats.ts` as a thin extension entrypoint that registers the `/session-stats` command. It imports `getAgentDir` and `BorderedLoader` from `@mariozechner/pi-coding-agent` at the TypeScript level. Its handler parses args, guards for UI, shows a loader, calls the scanner to discover and parse all session files system-wide, passes the resulting usage records to the pure aggregator, formats the result, and shows it in an overlay.

Create `pi/session-stats/lib/types.ts` with plain TypeScript interfaces used by the pure library modules. These interfaces mirror the data shape extracted from pi's types but do not import pi types directly, keeping the library testable.

Create `pi/session-stats/lib/command-args.ts` with a deterministic parser from raw command text into a structured command request.

Create `pi/session-stats/lib/date-range.ts` with a local-time range resolver that turns strings like `today` or `2026-04-01..2026-04-06` into start/end millisecond timestamps.

Create `pi/session-stats/lib/entry-extract.ts` with helper functions that bridge between untyped session entry objects and the plain `UsageRecord` interface used by the aggregator. These functions follow the same pattern as the jj-footer's type guards (`isRecord`, `isUsageLike`, `isAssistantMessageEntry`) so they work with `unknown` input and are testable without pi runtime imports.

Create `pi/session-stats/lib/scan-sessions.ts` with a function that discovers all `.jsonl` files under the sessions root, parses each using `loadEntriesFromFile()`, runs `migrateSessionEntries()`, extracts the header `cwd`, and calls `extractUsageRecords()` on the entries. Returns all usage records plus scan metadata (files scanned, warnings). This module imports from `@mariozechner/pi-coding-agent` and is tested via integration tests using real temp-directory fixtures.

Create `pi/session-stats/lib/aggregate.ts` with a pure function that accepts an array of usage records (plain objects, not pi types), a resolved date range, and an optional breakdown kind, and returns a stats report with totals, groupings, and duplicate/warning counts.

Create `pi/session-stats/lib/format.ts` with a function that takes the stats report and returns an array of plain text lines suitable for rendering in an overlay.


## Concrete Steps

All commands are run from the repository root.

### Milestone 0: package wiring and skeleton

**Step 1.** Create the directory structure and placeholder files.

    mkdir -p pi/session-stats/extensions pi/session-stats/lib

Create empty files:

    pi/session-stats/extensions/session-stats.ts
    pi/session-stats/lib/types.ts
    pi/session-stats/lib/command-args.ts
    pi/session-stats/lib/date-range.ts
    pi/session-stats/lib/entry-extract.ts
    pi/session-stats/lib/scan-sessions.ts
    pi/session-stats/lib/aggregate.ts
    pi/session-stats/lib/format.ts
    pi/session-stats/lib/command-args.test.ts
    pi/session-stats/lib/date-range.test.ts
    pi/session-stats/lib/entry-extract.test.ts
    pi/session-stats/lib/scan-sessions.test.ts
    pi/session-stats/lib/aggregate.test.ts
    pi/session-stats/lib/format.test.ts
    test/extensions/session-stats.test.ts

Confirm: no test files exist inside `pi/session-stats/extensions/` - only the single extension entrypoint.

**Step 2.** Update `package.json` so `pi.extensions` includes `"./pi/session-stats/extensions"` at the end of the array.

**Step 3.** In `pi/session-stats/extensions/session-stats.ts`, add a minimal default export that registers the command with a stub handler so the extension loads without error:

    import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

    export default function (pi: ExtensionAPI) {
      pi.registerCommand("session-stats", {
        description: "Show token usage and cost across saved sessions",
        handler: async (_args, ctx) => {
          ctx.ui.notify("session-stats: not yet implemented", "info");
        },
      });
    }

**Step 4.** Run `npm test` and confirm the full suite passes with zero new failures.

**Step 5.** Commit.

Suggested message: `feat(session-stats): add extension skeleton and package registration`

### Milestone 1: command parsing and local date ranges

**Step 6.** In `pi/session-stats/lib/types.ts`, define these interfaces:

    export type BreakdownKind = "day" | "project" | "model";

    export interface SessionStatsCommand {
      help: boolean;
      rangeExpression: string;
      breakdown?: BreakdownKind;
    }

    export interface ResolvedDateRange {
      label: string;
      startMs: number;
      endMsExclusive: number;
    }

    export interface UsageRecord {
      fingerprint: string;
      sessionFile: string;
      projectPath: string;
      provider: string;
      model: string;
      timestampMs: number;
      dayKey: string;
      tokens: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
      };
      costTotal: number;
    }

    export interface GroupedStatRow {
      label: string;
      tokensTotal: number;
      costTotal: number;
      messageCount: number;
    }

    export interface SessionStatsReport {
      range: ResolvedDateRange;
      sessionsScanned: number;
      sessionsMatched: number;
      messagesCounted: number;
      duplicatesCollapsed: number;
      warningCount: number;
      totals: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
        costTotal: number;
      };
      defaultTopProjects: GroupedStatRow[];
      breakdown?: {
        kind: BreakdownKind;
        rows: GroupedStatRow[];
        omittedCount: number;
      };
    }

**Step 7.** Write failing tests in `pi/session-stats/lib/command-args.test.ts`:

    import test from "node:test";
    import assert from "node:assert/strict";
    import { parseCommandArgs } from "./command-args.ts";

    test("empty args defaults to last 7 days with no breakdown", () => {
      const result = parseCommandArgs("");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "last 7 days",
        breakdown: undefined,
      });
    });

    test("--help returns help: true", () => {
      const result = parseCommandArgs("--help");
      assert.equal(result.help, true);
    });

    test("help returns help: true", () => {
      const result = parseCommandArgs("help");
      assert.equal(result.help, true);
    });

    test("parses 'last 7 days by project'", () => {
      const result = parseCommandArgs("last 7 days by project");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "last 7 days",
        breakdown: "project",
      });
    });

    test("parses 'this month by day'", () => {
      const result = parseCommandArgs("this month by day");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "this month",
        breakdown: "day",
      });
    });

    test("parses 'all time by model'", () => {
      const result = parseCommandArgs("all time by model");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "all time",
        breakdown: "model",
      });
    });

    test("parses 'all time' without breakdown", () => {
      const result = parseCommandArgs("all time");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "all time",
        breakdown: undefined,
      });
    });

    test("parses explicit date range", () => {
      const result = parseCommandArgs("2026-04-01..2026-04-06");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "2026-04-01..2026-04-06",
        breakdown: undefined,
      });
    });

    test("parses explicit date range with breakdown", () => {
      const result = parseCommandArgs("2026-04-01..2026-04-06 by day");
      assert.deepStrictEqual(result, {
        help: false,
        rangeExpression: "2026-04-01..2026-04-06",
        breakdown: "day",
      });
    });

    test("invalid breakdown returns error", () => {
      assert.throws(
        () => parseCommandArgs("today by provider"),
        /unknown breakdown/i,
      );
    });

**Step 8.** Write failing tests in `pi/session-stats/lib/date-range.test.ts`:

    import test from "node:test";
    import assert from "node:assert/strict";
    import { resolveDateRange } from "./date-range.ts";

    // Use a fixed "now" for deterministic tests: 2026-04-06 at 15:30 local time.
    // Construct using local components so the test works in any timezone.
    const now = new Date(2026, 3, 6, 15, 30, 0, 0); // month is 0-indexed

    test("'today' resolves to start-of-day through start-of-next-day", () => {
      const range = resolveDateRange("today", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      assert.equal(start.getFullYear(), 2026);
      assert.equal(start.getMonth(), 3); // April
      assert.equal(start.getDate(), 6);
      assert.equal(start.getHours(), 0);
      assert.equal(start.getMinutes(), 0);
      assert.equal(end.getDate(), 7);
      assert.equal(end.getHours(), 0);
      assert.equal(range.label, "today");
    });

    test("'yesterday' resolves to previous day", () => {
      const range = resolveDateRange("yesterday", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      assert.equal(start.getDate(), 5);
      assert.equal(end.getDate(), 6);
      assert.equal(range.label, "yesterday");
    });

    test("'last 7 days' covers 7 calendar days ending at end of today", () => {
      const range = resolveDateRange("last 7 days", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      assert.equal(start.getMonth(), 2); // March
      assert.equal(start.getDate(), 31);
      assert.equal(start.getHours(), 0);
      assert.equal(end.getMonth(), 3); // April
      assert.equal(end.getDate(), 7);
      assert.equal(end.getHours(), 0);
    });

    test("'last 30 days' covers 30 calendar days ending at end of today", () => {
      const range = resolveDateRange("last 30 days", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      // Start is March 8 (April 7 minus 30 days)
      assert.equal(start.getMonth(), 2); // March
      assert.equal(start.getDate(), 8);
      assert.equal(start.getHours(), 0);
      assert.equal(end.getMonth(), 3); // April
      assert.equal(end.getDate(), 7);
      assert.equal(end.getHours(), 0);
    });

    test("'this week' starts on Monday of the current week", () => {
      const range = resolveDateRange("this week", now);
      const start = new Date(range.startMs);
      assert.equal(start.getDay(), 1); // Monday
      assert.equal(start.getHours(), 0);
    });

    test("'last week' covers the previous Monday-through-Sunday", () => {
      const range = resolveDateRange("last week", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      assert.equal(start.getDay(), 1); // Monday
      assert.equal(start.getHours(), 0);
      assert.equal(end.getDay(), 1); // Next Monday (exclusive)
      assert.equal(end.getHours(), 0);
      // Exactly 7 calendar days apart
      const startDate = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const endDate = new Date(end.getFullYear(), end.getMonth(), end.getDate());
      const diffDays = Math.round((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      assert.equal(diffDays, 7);
    });

    test("'this month' starts on first of the month", () => {
      const range = resolveDateRange("this month", now);
      const start = new Date(range.startMs);
      assert.equal(start.getDate(), 1);
      assert.equal(start.getMonth(), 3); // April
    });

    test("'last month' covers the previous calendar month", () => {
      const range = resolveDateRange("last month", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      assert.equal(start.getMonth(), 2); // March
      assert.equal(start.getDate(), 1);
      assert.equal(end.getMonth(), 3); // April
      assert.equal(end.getDate(), 1);
    });

    test("'all time' uses very old start and far-future end", () => {
      const range = resolveDateRange("all time", now);
      assert.ok(range.startMs < new Date(2000, 0, 1).getTime());
      assert.ok(range.endMsExclusive > now.getTime());
      assert.equal(range.label, "all time");
    });

    test("explicit 'YYYY-MM-DD..YYYY-MM-DD' parses correctly", () => {
      const range = resolveDateRange("2026-04-01..2026-04-06", now);
      const start = new Date(range.startMs);
      const end = new Date(range.endMsExclusive);
      assert.equal(start.getFullYear(), 2026);
      assert.equal(start.getMonth(), 3);
      assert.equal(start.getDate(), 1);
      // End is exclusive: start of day after the end date
      assert.equal(end.getDate(), 7);
      assert.match(range.label, /2026-04-01/);
    });

    test("reversed explicit range throws", () => {
      assert.throws(
        () => resolveDateRange("2026-04-06..2026-04-01", now),
        /start date.*after.*end date/i,
      );
    });

    test("unknown range expression throws", () => {
      assert.throws(
        () => resolveDateRange("last fortnight", now),
        /unknown range/i,
      );
    });

**Step 9.** Run both test files and confirm the red phase:

    node --experimental-strip-types --test pi/session-stats/lib/command-args.test.ts pi/session-stats/lib/date-range.test.ts

Expected: failures due to missing exports (empty source files).

**Step 10.** Implement `pi/session-stats/lib/command-args.ts`:

Export a function `parseCommandArgs(raw: string): SessionStatsCommand`. The parser trims whitespace, checks for `--help` or `help`, peels off an optional `by day|project|model` suffix using a regex match at the end of the string, validates the breakdown kind (throw `Error("Unknown breakdown: ...")` for invalid values), and returns the remainder as `rangeExpression` (defaulting to `"last 7 days"` when empty).

**Step 11.** Implement `pi/session-stats/lib/date-range.ts`:

Export a function `resolveDateRange(input: string, now?: Date): ResolvedDateRange`. The function normalizes the input to lowercase and trims it. It handles the known friendly range strings by constructing `Date` objects using local-time component constructors (e.g., `new Date(year, month, date)`) and converting to milliseconds. For `this week` and `last week`, Monday is day 1 (ISO week). For explicit `YYYY-MM-DD..YYYY-MM-DD`, it splits on `..`, parses each side as `new Date(year, month-1, day)` in local time, and sets the exclusive end to start-of-day after the end date. For `all time`, use `startMs = 0` and `endMsExclusive = now.getTime() + 365 * 24 * 60 * 60 * 1000`. Throw `Error("Unknown range: ...")` for unrecognized expressions.

**Step 12.** Re-run the tests and confirm all pass (green):

    node --experimental-strip-types --test pi/session-stats/lib/command-args.test.ts pi/session-stats/lib/date-range.test.ts

Expected: all tests pass, zero failures.

**Step 13.** Commit.

Suggested message: `feat(session-stats): parse command arguments and resolve local date ranges`

### Milestone 2: entry extraction, session scanning, and aggregation

**Step 14.** Write failing tests in `pi/session-stats/lib/entry-extract.test.ts`. This module extracts plain `UsageRecord` objects from untyped entry data (the same shape that `loadEntriesFromFile()` returns, minus the header). The tests construct fixture objects matching the real JSONL structure verified in Preconditions:

    import test from "node:test";
    import assert from "node:assert/strict";
    import { extractUsageRecords } from "./entry-extract.ts";

    const assistantEntry = {
      type: "message",
      id: "abc1",
      parentId: "parent1",
      timestamp: "2026-04-05T10:00:00.000Z",
      message: {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        stopReason: "stop",
        timestamp: 1775127600000,
        usage: {
          input: 1000,
          output: 200,
          cacheRead: 500,
          cacheWrite: 100,
          totalTokens: 1800,
          cost: { input: 0.003, output: 0.006, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0105 },
        },
        content: [{ type: "text", text: "Hello" }],
      },
    };

    const userEntry = {
      type: "message",
      id: "user1",
      parentId: null,
      timestamp: "2026-04-05T09:59:00.000Z",
      message: { role: "user", content: "hi", timestamp: 1775127540000 },
    };

    const toolResultEntry = {
      type: "message",
      id: "tr1",
      parentId: "abc1",
      timestamp: "2026-04-05T10:01:00.000Z",
      message: { role: "toolResult", toolCallId: "tc1", toolName: "bash", content: [], isError: false, timestamp: 1775127660000 },
    };

    test("extracts a UsageRecord from an assistant message entry", () => {
      const records = extractUsageRecords([assistantEntry], "/path/to/session.jsonl", "/Users/me/Code/project");
      assert.equal(records.length, 1);
      const r = records[0];
      assert.equal(r.provider, "anthropic");
      assert.equal(r.model, "claude-sonnet-4-20250514");
      assert.equal(r.timestampMs, 1775127600000);
      assert.equal(r.tokens.input, 1000);
      assert.equal(r.tokens.output, 200);
      assert.equal(r.tokens.total, 1800);
      assert.equal(r.costTotal, 0.0105);
      assert.equal(r.projectPath, "/Users/me/Code/project");
      assert.equal(r.sessionFile, "/path/to/session.jsonl");
      assert.ok(r.fingerprint.length > 0);
      assert.ok(r.dayKey.length > 0);
    });

    test("ignores user and toolResult entries", () => {
      const records = extractUsageRecords(
        [userEntry, assistantEntry, toolResultEntry],
        "s.jsonl", "/cwd",
      );
      assert.equal(records.length, 1);
    });

    test("ignores non-message entry types", () => {
      const compaction = { type: "compaction", id: "c1", parentId: null, timestamp: "2026-04-05T10:00:00.000Z", summary: "...", firstKeptEntryId: "x", tokensBefore: 100 };
      const records = extractUsageRecords([compaction], "s.jsonl", "/cwd");
      assert.equal(records.length, 0);
    });

    test("ignores assistant messages without usage", () => {
      const noUsage = { ...assistantEntry, message: { ...assistantEntry.message, usage: undefined } };
      const records = extractUsageRecords([noUsage], "s.jsonl", "/cwd");
      assert.equal(records.length, 0);
    });

    test("two identical assistant messages produce the same fingerprint", () => {
      const records = extractUsageRecords([assistantEntry, assistantEntry], "s.jsonl", "/cwd");
      assert.equal(records.length, 2);
      assert.equal(records[0].fingerprint, records[1].fingerprint);
    });

**Step 15.** Write failing tests in `pi/session-stats/lib/aggregate.test.ts`:

    import test from "node:test";
    import assert from "node:assert/strict";
    import { aggregateUsage } from "./aggregate.ts";
    import type { UsageRecord, ResolvedDateRange } from "./types.ts";

    function makeRecord(overrides: Partial<UsageRecord> = {}): UsageRecord {
      return {
        fingerprint: "fp-" + Math.random().toString(36).slice(2, 8),
        sessionFile: "session-a.jsonl",
        projectPath: "/Users/me/Code/foo",
        provider: "anthropic",
        model: "claude-sonnet-4-20250514",
        timestampMs: new Date(2026, 3, 5, 12, 0).getTime(),
        dayKey: "2026-04-05",
        tokens: { input: 1000, output: 200, cacheRead: 500, cacheWrite: 100, total: 1800 },
        costTotal: 0.01,
        ...overrides,
      };
    }

    const rangeAllApril: ResolvedDateRange = {
      label: "this month",
      startMs: new Date(2026, 3, 1).getTime(),
      endMsExclusive: new Date(2026, 4, 1).getTime(),
    };

    test("single record inside range is counted", () => {
      const records = [makeRecord()];
      const report = aggregateUsage(records, rangeAllApril, 1);
      assert.equal(report.messagesCounted, 1);
      assert.equal(report.totals.input, 1000);
      assert.equal(report.totals.output, 200);
      assert.equal(report.totals.total, 1800);
      assert.equal(report.totals.costTotal, 0.01);
      assert.equal(report.sessionsScanned, 1);
      assert.equal(report.sessionsMatched, 1);
    });

    test("records outside range are excluded", () => {
      const outOfRange = makeRecord({
        timestampMs: new Date(2026, 2, 15, 12, 0).getTime(), // March
      });
      const report = aggregateUsage([outOfRange], rangeAllApril, 1);
      assert.equal(report.messagesCounted, 0);
      assert.equal(report.totals.total, 0);
    });

    test("duplicate fingerprints are collapsed", () => {
      const r1 = makeRecord({ fingerprint: "same-fp", sessionFile: "s1.jsonl" });
      const r2 = makeRecord({ fingerprint: "same-fp", sessionFile: "s2.jsonl" });
      const report = aggregateUsage([r1, r2], rangeAllApril, 2);
      assert.equal(report.messagesCounted, 1);
      assert.equal(report.duplicatesCollapsed, 1);
      assert.equal(report.totals.total, 1800); // counted once, not doubled
    });

    test("breakdown by project groups correctly", () => {
      const r1 = makeRecord({ projectPath: "/Code/foo" });
      const r2 = makeRecord({ projectPath: "/Code/bar", fingerprint: "fp-other" });
      const report = aggregateUsage([r1, r2], rangeAllApril, 2, "project");
      assert.ok(report.breakdown);
      assert.equal(report.breakdown!.kind, "project");
      assert.equal(report.breakdown!.rows.length, 2);
      // sorted by descending total tokens
      assert.equal(report.breakdown!.rows[0].tokensTotal, 1800);
    });

    test("breakdown by model groups by provider/model", () => {
      const r1 = makeRecord({ provider: "anthropic", model: "claude-sonnet-4" });
      const r2 = makeRecord({ provider: "openai", model: "gpt-5", fingerprint: "fp2" });
      const report = aggregateUsage([r1, r2], rangeAllApril, 2, "model");
      assert.ok(report.breakdown);
      const labels = report.breakdown!.rows.map((r) => r.label);
      assert.ok(labels.includes("anthropic/claude-sonnet-4"));
      assert.ok(labels.includes("openai/gpt-5"));
    });

    test("breakdown by day uses dayKey", () => {
      const r1 = makeRecord({ dayKey: "2026-04-05" });
      const r2 = makeRecord({ dayKey: "2026-04-06", fingerprint: "fp2" });
      const report = aggregateUsage([r1, r2], rangeAllApril, 1, "day");
      assert.ok(report.breakdown);
      assert.equal(report.breakdown!.rows.length, 2);
    });

    test("defaultTopProjects are populated without explicit breakdown", () => {
      const r1 = makeRecord({ projectPath: "/Code/foo" });
      const r2 = makeRecord({ projectPath: "/Code/bar", fingerprint: "fp2" });
      const report = aggregateUsage([r1, r2], rangeAllApril, 2);
      assert.equal(report.breakdown, undefined);
      assert.ok(report.defaultTopProjects.length > 0);
    });

    test("sessionsScanned reflects the count passed in", () => {
      const report = aggregateUsage([], rangeAllApril, 42);
      assert.equal(report.sessionsScanned, 42);
      assert.equal(report.sessionsMatched, 0);
    });

**Step 16.** Write failing tests in `pi/session-stats/lib/scan-sessions.test.ts`. This module discovers session files, parses them using pi's exported helpers, and returns usage records. The tests use real temp directories with fixture JSONL files:

    import test, { before, after } from "node:test";
    import assert from "node:assert/strict";
    import * as fs from "node:fs";
    import * as os from "node:os";
    import * as path from "node:path";
    import { scanSessionFiles } from "./scan-sessions.ts";

    const SESSION_HEADER = JSON.stringify({
      type: "session", version: 3, id: "test-id-1",
      timestamp: "2026-04-05T10:00:00.000Z", cwd: "/Users/me/Code/project-a",
    });

    const ASSISTANT_ENTRY = JSON.stringify({
      type: "message", id: "a1", parentId: null,
      timestamp: "2026-04-05T10:01:00.000Z",
      message: {
        role: "assistant", provider: "anthropic",
        model: "claude-sonnet-4-20250514", stopReason: "stop",
        timestamp: 1775127660000,
        usage: {
          input: 1000, output: 200, cacheRead: 500, cacheWrite: 100,
          totalTokens: 1800,
          cost: { input: 0.003, output: 0.006, cacheRead: 0.001, cacheWrite: 0.0005, total: 0.0105 },
        },
        content: [{ type: "text", text: "Hello" }],
      },
    });

    const USER_ENTRY = JSON.stringify({
      type: "message", id: "u1", parentId: null,
      timestamp: "2026-04-05T09:59:00.000Z",
      message: { role: "user", content: "hi", timestamp: 1775127540000 },
    });

    let sessionsRoot: string;

    before(() => {
      sessionsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "session-stats-test-"));
    });

    after(() => {
      fs.rmSync(sessionsRoot, { recursive: true, force: true });
    });

    function writeSession(subdir: string, filename: string, lines: string[]): string {
      const dir = path.join(sessionsRoot, subdir);
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, filename);
      fs.writeFileSync(filePath, lines.join("\n") + "\n");
      return filePath;
    }

    test("discovers and parses a single session file", () => {
      writeSession("--Users--me--Code--project-a--", "session1.jsonl", [
        SESSION_HEADER, USER_ENTRY, ASSISTANT_ENTRY,
      ]);
      const result = scanSessionFiles(sessionsRoot);
      assert.equal(result.filesScanned, 1);
      assert.equal(result.warningCount, 0);
      assert.equal(result.records.length, 1);
      assert.equal(result.records[0].provider, "anthropic");
      assert.equal(result.records[0].projectPath, "/Users/me/Code/project-a");
    });

    test("discovers sessions across multiple project directories", () => {
      const header2 = JSON.stringify({
        type: "session", version: 3, id: "test-id-2",
        timestamp: "2026-04-05T11:00:00.000Z", cwd: "/Users/me/Code/project-b",
      });
      writeSession("--Users--me--Code--project-b--", "session2.jsonl", [
        header2, ASSISTANT_ENTRY,
      ]);
      const result = scanSessionFiles(sessionsRoot);
      assert.ok(result.filesScanned >= 2);
      const projects = new Set(result.records.map((r) => r.projectPath));
      assert.ok(projects.has("/Users/me/Code/project-a"));
      assert.ok(projects.has("/Users/me/Code/project-b"));
    });

    test("counts warnings for files that fail to parse", () => {
      writeSession("--bad-project--", "bad.jsonl", ["not valid json at all"]);
      const result = scanSessionFiles(sessionsRoot);
      assert.ok(result.warningCount >= 1);
    });

    test("skips non-jsonl files", () => {
      const dir = path.join(sessionsRoot, "--other--");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "readme.txt"), "not a session");
      const result = scanSessionFiles(sessionsRoot);
      // readme.txt should not be counted in filesScanned
      assert.ok(!result.records.some((r) => r.sessionFile.endsWith(".txt")));
    });

    test("returns empty result for missing sessions root", () => {
      const result = scanSessionFiles("/nonexistent/path/that/does/not/exist");
      assert.equal(result.filesScanned, 0);
      assert.equal(result.records.length, 0);
      assert.equal(result.warningCount, 0);
    });

**Step 17.** Run all Milestone 2 tests and confirm the red phase:

    node --experimental-strip-types --test pi/session-stats/lib/entry-extract.test.ts pi/session-stats/lib/scan-sessions.test.ts pi/session-stats/lib/aggregate.test.ts

Expected: failures due to missing exports.

**Step 18.** Implement `pi/session-stats/lib/entry-extract.ts`:

Export a function `extractUsageRecords(entries: unknown[], sessionFile: string, projectPath: string): UsageRecord[]`. For each entry, check `entry.type === "message"` and `entry.message.role === "assistant"`, then validate that `entry.message.usage` has the expected numeric fields (following the same `isRecord`/`isNumber`/`isUsageLike` guard pattern from `pi/jj/extensions/jj-footer.ts`). For valid entries, construct a `UsageRecord` with:

- `fingerprint`: SHA-256 hex digest of `JSON.stringify([msg.timestamp, msg.provider, msg.model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.cost.total])` using `crypto.createHash("sha256")`.
- `timestampMs`: `msg.timestamp` (the number field on the message, not the entry's ISO string).
- `dayKey`: format `timestampMs` as `YYYY-MM-DD` in local time using `new Date(timestampMs)`.
- `tokens`: directly from `usage.input`, `usage.output`, `usage.cacheRead`, `usage.cacheWrite`, `usage.totalTokens`.
- `costTotal`: from `usage.cost.total`.
- `provider`, `model`, `sessionFile`, `projectPath`: passed through or extracted from the message.

Skip entries that fail the type guards.

**Step 19.** Implement `pi/session-stats/lib/scan-sessions.ts`:

Export an interface `ScanResult` with fields `records: UsageRecord[]`, `filesScanned: number`, and `warningCount: number`.

Export a function `scanSessionFiles(sessionsRoot: string, onProgress?: (scanned: number, total: number) => void): ScanResult`. The function:

1. If `sessionsRoot` does not exist, returns `{ records: [], filesScanned: 0, warningCount: 0 }`.
2. Lists all subdirectories under `sessionsRoot` using `readdirSync` with `{ withFileTypes: true }`. Each subdirectory represents a project.
3. Within each subdirectory, lists all `.jsonl` files.
4. For each `.jsonl` file, calls `loadEntriesFromFile(filePath)` (imported from `@mariozechner/pi-coding-agent`). If the result is empty (invalid or missing file), increments `warningCount` and continues.
5. Calls `migrateSessionEntries(entries)` (imported from `@mariozechner/pi-coding-agent`) to normalize to current session format in memory.
6. Extracts the session header (first entry where `type === "session"`) to get `cwd`. Falls back to empty string if no header.
7. Filters out the header, then calls `extractUsageRecords(entries, filePath, cwd)` and appends results to the records array.
8. Calls `onProgress?.(scannedSoFar, totalFiles)` after each file.
9. Returns `{ records, filesScanned, warningCount }`.

Wrap each per-file operation in a try/catch. On I/O failure, increment `warningCount` and continue.

**Step 20.** Implement `pi/session-stats/lib/aggregate.ts`:

Export a function `aggregateUsage(records: UsageRecord[], range: ResolvedDateRange, sessionsScanned: number, breakdown?: BreakdownKind): SessionStatsReport`. The function:

1. Filters records where `record.timestampMs >= range.startMs && record.timestampMs < range.endMsExclusive`.
2. Deduplicates by fingerprint using a `Set<string>`, counting the number of duplicates collapsed.
3. Sums token and cost fields across unique records.
4. Counts distinct `sessionFile` values among matched records as `sessionsMatched`.
5. If `breakdown` is provided, groups by the appropriate key (`dayKey`, `projectPath`, or `${provider}/${model}`), produces `GroupedStatRow[]` sorted by descending `tokensTotal` then ascending `label`, clamps to top 10 rows, and records `omittedCount`.
6. When no breakdown is requested, builds `defaultTopProjects` by grouping on `projectPath` and returning the top 3.

**Step 21.** Re-run the tests and confirm all pass (green):

    node --experimental-strip-types --test pi/session-stats/lib/entry-extract.test.ts pi/session-stats/lib/scan-sessions.test.ts pi/session-stats/lib/aggregate.test.ts

Expected: all tests pass, zero failures.

**Step 22.** Commit.

Suggested message: `feat(session-stats): extract usage records, scan sessions, and aggregate stats`

### Milestone 3: report formatting

**Step 23.** Write failing tests in `pi/session-stats/lib/format.test.ts`:

    import test from "node:test";
    import assert from "node:assert/strict";
    import { formatReport } from "./format.ts";
    import type { SessionStatsReport } from "./types.ts";

    function makeReport(overrides: Partial<SessionStatsReport> = {}): SessionStatsReport {
      return {
        range: { label: "last 7 days", startMs: 0, endMsExclusive: 1 },
        sessionsScanned: 42,
        sessionsMatched: 11,
        messagesCounted: 173,
        duplicatesCollapsed: 12,
        warningCount: 0,
        totals: {
          input: 482190,
          output: 96441,
          cacheRead: 310220,
          cacheWrite: 24000,
          total: 912851,
          costTotal: 4.82,
        },
        defaultTopProjects: [
          { label: "~/Code/foo", tokensTotal: 410220, costTotal: 2.0, messageCount: 80 },
          { label: "~/Code/bar", tokensTotal: 301044, costTotal: 1.5, messageCount: 60 },
        ],
        ...overrides,
      };
    }

    test("header includes range label and local time note", () => {
      const lines = formatReport(makeReport());
      assert.ok(lines.some((l) => l.includes("last 7 days")));
      assert.ok(lines.some((l) => l.toLowerCase().includes("local time")));
    });

    test("token totals use comma separators", () => {
      const lines = formatReport(makeReport());
      const joined = lines.join("\n");
      assert.ok(joined.includes("482,190"));
      assert.ok(joined.includes("912,851"));
    });

    test("cost formatted to two decimal places", () => {
      const lines = formatReport(makeReport());
      assert.ok(lines.some((l) => l.includes("$4.82")));
    });

    test("zero cost is omitted or shows $0.00", () => {
      const lines = formatReport(makeReport({ totals: { ...makeReport().totals, costTotal: 0 } }));
      const joined = lines.join("\n");
      // Should either not show cost section or show $0.00
      assert.ok(!joined.includes("$NaN"));
    });

    test("duplicates collapsed shown when non-zero", () => {
      const lines = formatReport(makeReport({ duplicatesCollapsed: 12 }));
      assert.ok(lines.some((l) => l.includes("12")));
    });

    test("duplicates collapsed not shown when zero", () => {
      const lines = formatReport(makeReport({ duplicatesCollapsed: 0 }));
      assert.ok(!lines.some((l) => l.toLowerCase().includes("duplicate")));
    });

    test("warnings shown when non-zero", () => {
      const lines = formatReport(makeReport({ warningCount: 3 }));
      assert.ok(lines.some((l) => l.includes("3") && l.toLowerCase().includes("warning")));
    });

    test("default top projects shown when no breakdown", () => {
      const lines = formatReport(makeReport());
      const joined = lines.join("\n");
      assert.ok(joined.includes("~/Code/foo"));
      assert.ok(joined.includes("~/Code/bar"));
    });

    test("breakdown replaces default top projects", () => {
      const report = makeReport({
        breakdown: {
          kind: "model",
          rows: [
            { label: "anthropic/claude-sonnet-4", tokensTotal: 500000, costTotal: 3.0, messageCount: 100 },
            { label: "openai/gpt-5", tokensTotal: 300000, costTotal: 1.5, messageCount: 50 },
          ],
          omittedCount: 0,
        },
      });
      const lines = formatReport(report);
      const joined = lines.join("\n");
      assert.ok(joined.includes("anthropic/claude-sonnet-4"));
      assert.ok(joined.includes("openai/gpt-5"));
      assert.ok(joined.toLowerCase().includes("model"));
    });

    test("omitted count shown when non-zero", () => {
      const report = makeReport({
        breakdown: {
          kind: "project",
          rows: [{ label: "~/Code/foo", tokensTotal: 500, costTotal: 0.01, messageCount: 1 }],
          omittedCount: 7,
        },
      });
      const lines = formatReport(report);
      assert.ok(lines.some((l) => l.includes("7") && l.toLowerCase().includes("omitted")));
    });

**Step 24.** Run the test and confirm red phase:

    node --experimental-strip-types --test pi/session-stats/lib/format.test.ts

**Step 25.** Implement `pi/session-stats/lib/format.ts`:

Export a function `formatReport(report: SessionStatsReport): string[]` that returns an array of plain text lines. The format should be:

    Session stats - {range.label} (local time)
    Sessions scanned: {sessionsScanned}
    Sessions matched: {sessionsMatched}
    Assistant messages counted: {messagesCounted}
    [Duplicate copied messages collapsed: {duplicatesCollapsed}]  // only if > 0
    [Warnings: {warningCount}]  // only if > 0

    Tokens
      input:       {formatted}
      output:      {formatted}
      cache read:  {formatted}
      cache write: {formatted}
      total:       {formatted}

    Cost
      total: ${formatted to 2 decimals}

    [Top projects | Breakdown: {kind}]
      1. {label}  {tokensTotal}  ${costTotal}
      ...
    [... {omittedCount} additional rows omitted]  // only if > 0

Format token numbers with comma separators using `Intl.NumberFormat("en-US")`. Pad labels for alignment.

**Step 26.** Re-run and confirm green:

    node --experimental-strip-types --test pi/session-stats/lib/format.test.ts

**Step 27.** Commit.

Suggested message: `feat(session-stats): format cross-session usage reports`

### Milestone 4: extension command and overlay

**Step 28.** Write tests in `test/extensions/session-stats.test.ts`. These tests verify the extension's registration and wiring without requiring the pi runtime. Override `registerCommand` on the mock to capture the registration:

    import test from "node:test";
    import assert from "node:assert/strict";
    import { createMockExtensionAPI } from "../../test/helpers.ts";
    import extension from "../../pi/session-stats/extensions/session-stats.ts";

    interface CommandRegistration {
      description: string;
      handler: (args: string, ctx: unknown) => Promise<void>;
      getArgumentCompletions?: (prefix: string) => unknown[] | null;
    }

    function setupExtension() {
      const pi = createMockExtensionAPI();
      const commands = new Map<string, CommandRegistration>();
      pi.registerCommand = (name: string, options: CommandRegistration) => {
        commands.set(name, options);
      };
      extension(pi as unknown as Parameters<typeof extension>[0]);
      return { pi, commands };
    }

    test("registers /session-stats command with description", () => {
      const { commands } = setupExtension();
      assert.ok(commands.has("session-stats"));
      assert.ok(commands.get("session-stats")!.description.length > 0);
    });

    test("provides argument completions", () => {
      const { commands } = setupExtension();
      const cmd = commands.get("session-stats")!;
      assert.ok(cmd.getArgumentCompletions);
      const completions = cmd.getArgumentCompletions!("");
      assert.ok(completions && completions.length > 0);
    });

    test("handler notifies error without UI", async () => {
      const { commands } = setupExtension();
      const handler = commands.get("session-stats")!.handler;
      const notifications: Array<{ message: string; level: string }> = [];
      const ctx = {
        hasUI: false,
        ui: {
          notify(message: string, level: string) { notifications.push({ message, level }); },
          custom: () => Promise.resolve(null),
        },
      };
      await handler("", ctx);
      assert.ok(notifications.some((n) => n.level === "error" && /interactive/i.test(n.message)));
    });

**Step 29.** Run the test and confirm green (the stub handler from Step 3 should pass the registration tests; the no-UI test validates behavior):

    node --experimental-strip-types --test test/extensions/session-stats.test.ts

**Step 30.** Implement the full command handler in `pi/session-stats/extensions/session-stats.ts`. Replace the stub handler with the real implementation:

    import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
    import { getAgentDir, BorderedLoader } from "@mariozechner/pi-coding-agent";
    import { Text, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
    import { parseCommandArgs } from "../lib/command-args.ts";
    import { resolveDateRange } from "../lib/date-range.ts";
    import { scanSessionFiles } from "../lib/scan-sessions.ts";
    import { aggregateUsage } from "../lib/aggregate.ts";
    import { formatReport } from "../lib/format.ts";
    import * as path from "node:path";

The command handler should:

1. Parse args with `parseCommandArgs`. If it throws, show the error via `ctx.ui.notify(message, "error")` and return.
2. If `command.help`, show a help overlay with supported range phrases and examples, then return.
3. If `!ctx.hasUI`, notify `"session-stats requires interactive mode"` and return.
4. Resolve the date range with `resolveDateRange(command.rangeExpression)`. If it throws, notify the error and return.
5. Show a `BorderedLoader` overlay while scanning.
6. Compute the sessions root as `path.join(getAgentDir(), "sessions")`.
7. Call `scanSessionFiles(sessionsRoot, onProgress)` where `onProgress` updates the loader message with `"Scanning sessions: {scanned}/{total}..."`.
8. Call `aggregateUsage(scanResult.records, range, scanResult.filesScanned, command.breakdown)` and merge `scanResult.warningCount` into the report.
9. Call `formatReport(report)` to get the text lines.
10. Replace the loader with a bordered overlay showing the formatted report and a `"Press Enter or Esc to close"` footer, following the same pattern as `pi/recap/extensions/recap.ts`.

Register argument completions for common range phrases (`today`, `yesterday`, `last 7 days`, `last 30 days`, `this week`, `last week`, `this month`, `last month`, `all time`) and `by day`, `by project`, `by model` suffixes.

**Step 31.** Run the full test suite:

    npm test

Expected: all tests pass, zero failures.

**Step 32.** Commit.

Suggested message: `feat(session-stats): wire interactive slash command with overlay`

### Milestone 5: documentation and end-to-end validation

**Step 33.** Add a section to `README.md` documenting `/session-stats`:

    ## Pi `/session-stats` command

    Cross-session token usage and cost reporting.

    ### Usage

        /session-stats [range] [by day|project|model]

    ### Examples

        /session-stats
        /session-stats today
        /session-stats last 7 days
        /session-stats this month by project
        /session-stats 2026-04-01..2026-04-06 by day
        /session-stats all time by model

    ### Notes

    - Scans all saved sessions across all projects on this machine.
    - Only saved sessions are counted. Ephemeral `--no-session` runs are invisible.
    - Ranges are interpreted in local time.
    - Does not invoke a model. Deterministic and read-only.

**Step 34.** Run the full test suite:

    npm test

Expected: all tests pass.

**Step 35.** Perform manual interactive validation. Launch pi with the extension:

    pi -e ./pi/session-stats/extensions/session-stats.ts

Inside pi, run each of:

    /session-stats
    /session-stats this month
    /session-stats last 7 days by project
    /session-stats all time by model
    /session-stats --help

Expected for each:

- The command opens a readable overlay without invoking a model.
- No new assistant response appears in the conversation.
- Token totals and cost are shown derived from saved sessions.
- The `--help` variant shows the usage examples and supported range phrases.

**Step 36.** Commit.

Suggested message: `docs(session-stats): document usage and validate end to end`


## Testing and Falsifiability

The plan is only correct if it can be proven wrong with concrete tests.

The pure-library tests in `pi/session-stats/lib/command-args.test.ts`, `pi/session-stats/lib/date-range.test.ts`, `pi/session-stats/lib/entry-extract.test.ts`, `pi/session-stats/lib/scan-sessions.test.ts`, `pi/session-stats/lib/aggregate.test.ts`, and `pi/session-stats/lib/format.test.ts` must fail before implementation and pass afterward. They are specified with concrete inputs and assertions, not vague descriptions.

The scan-sessions integration test is the most important end-to-end falsification point. It writes real JSONL fixture files into a temp directory tree mimicking `~/.pi/agent/sessions/`, calls `scanSessionFiles()`, and asserts that records are discovered across multiple project subdirectories with accurate `projectPath` values and correct warning counts for malformed files.

The aggregate duplicate-collapse test is the most important correctness falsification point. It provides two `UsageRecord` objects with the same fingerprint but different `sessionFile` values. If total tokens double instead of staying constant, the deduplication claim is false.

The entry-extract test verifies that user messages, tool results, compaction entries, and assistant messages without usage are all ignored. If any of these produce a `UsageRecord`, the extraction logic is wrong.

Manual validation must prove the non-functional claims. After launching pi with the extension and running `/session-stats`, there should be no model turn, no new assistant response, and only a local overlay. If the command causes a provider call or changes the conversation history, the "zero prompt overhead" claim is false.


## Validation and Acceptance

From the repository root, run:

    npm test

and expect the full suite to pass.

Then launch pi with the extension:

    pi -e ./pi/session-stats/extensions/session-stats.ts

Inside pi, run `/session-stats last 7 days`. Acceptance:

- The command appears in slash-command discovery.
- It completes without invoking a model.
- It shows a compact report labeled with the resolved local-time range.
- It displays token totals (input, output, cache read, cache write, total) and cost total.
- It shows sessions scanned/matched counts and duplicate collapsed count when applicable.

Run `/session-stats last 7 days by project` and `/session-stats all time by model`. Acceptance:

- The report shows data across all projects on the machine, not just the current working directory.
- The report switches to the requested breakdown.
- Rows are sorted by descending total tokens.
- Long result sets are clamped with an omitted-row note.

Run `/session-stats --help`. Acceptance: a help view listing supported phrases and examples.


## Rollout, Recovery, and Idempotence

This feature is additive. It introduces one new extension path and one new slash command. No existing commands or settings are mutated. Session files may be migrated in memory during scanning (via `migrateSessionEntries()`), but the one-pass scanner uses `loadEntriesFromFile()` which does not write back to disk — session files are not modified on disk by this command. If implementation stalls halfway, the recovery path is to remove `"./pi/session-stats/extensions"` from `package.json` and delete the `pi/session-stats/` directory.

The command itself is idempotent. Running it repeatedly does not change repository state, session files, or pi state beyond transient UI overlays.


## Artifacts and Notes

A representative formatted report:

    Session stats - last 7 days (local time)
    Sessions scanned: 42
    Sessions matched: 11
    Assistant messages counted: 173
    Duplicate copied messages collapsed: 12

    Tokens
      input:       482,190
      output:       96,441
      cache read:  310,220
      cache write:  24,000
      total:       912,851

    Cost
      total: $4.82

    Top projects
      1. ~/Code/foo              410,220   $2.00
      2. ~/Code/bar              301,044   $1.50
      3. ~/Code/baz              201,587   $1.32

The help text:

    /session-stats [range] [by day|project|model]

    Ranges:
      today, yesterday, last 7 days, last 30 days,
      this week, last week, this month, last month,
      all time, YYYY-MM-DD..YYYY-MM-DD

    Examples:
      /session-stats
      /session-stats today
      /session-stats last 7 days by project
      /session-stats 2026-04-01..2026-04-06 by day
      /session-stats all time by model

    Notes:
      Scans all saved sessions across all projects.
      Only saved sessions are counted.
      Ranges are in local time.
      Does not invoke a model.


## Interfaces and Dependencies

No new npm dependencies. Use only Node built-ins (`crypto` for SHA-256, `node:fs` and `node:path` for file discovery, `Intl.NumberFormat` for formatting) and the pi runtime types already used elsewhere in this repository.

In `pi/session-stats/lib/types.ts`, the full set of interfaces is specified in Step 6.

In `pi/session-stats/lib/command-args.ts`:

    export function parseCommandArgs(raw: string): SessionStatsCommand

In `pi/session-stats/lib/date-range.ts`:

    export function resolveDateRange(input: string, now?: Date): ResolvedDateRange

In `pi/session-stats/lib/entry-extract.ts`:

    export function extractUsageRecords(
      entries: unknown[],
      sessionFile: string,
      projectPath: string,
    ): UsageRecord[]

In `pi/session-stats/lib/scan-sessions.ts`:

    export interface ScanResult {
      records: UsageRecord[];
      filesScanned: number;
      warningCount: number;
    }

    export function scanSessionFiles(
      sessionsRoot: string,
      onProgress?: (scanned: number, total: number) => void,
    ): ScanResult

In `pi/session-stats/lib/aggregate.ts`:

    export function aggregateUsage(
      records: UsageRecord[],
      range: ResolvedDateRange,
      sessionsScanned: number,
      breakdown?: BreakdownKind,
    ): SessionStatsReport

In `pi/session-stats/lib/format.ts`:

    export function formatReport(report: SessionStatsReport): string[]

In `pi/session-stats/extensions/session-stats.ts`:

    export default function (pi: ExtensionAPI): void

The extension entrypoint imports `getAgentDir` and `BorderedLoader` from `@mariozechner/pi-coding-agent` and TUI components from `@mariozechner/pi-tui`. The scanner module imports `loadEntriesFromFile` and `migrateSessionEntries` from `@mariozechner/pi-coding-agent`. These are only available at pi runtime, not as npm dependencies. This is the standard pattern used by every other extension in this repository.
