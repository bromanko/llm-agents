# Add a headless `/review --report` mode for full finding output

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

After this change, `/review` will support a third post-review mode alongside the current interactive triage flow and the existing `--fix` auto-queue flow. The new mode will be `--report <high|medium|low|all>`. It will run the same review pipeline, collect the same parsed and deduplicated findings, and then output the full report instead of asking the user to triage findings one by one or queueing fixes.

The user-visible win is that review results become usable from `pi -p`, which is a non-interactive print-and-exit workflow. A user will be able to run a command like `pi -p "/review gleam --report all"` and receive a complete deterministic report on standard output without creating a temporary file that later needs cleanup.

## Problem Framing and Constraints

Today `/review` has two output behaviors after findings are produced. With no extra flag it opens an interactive per-finding chooser. With `--fix` it batches selected findings into queued follow-up fix requests. Neither path solves the workflow "run review from print mode and just give me all the issues."

The concrete pain is that `pi -p` deliberately disables interactive UI. In the current code, `/review` exits early when `ctx.hasUI` is false, which prevents the command from being used in print mode at all. The feature request is not to add auto-fixing in print mode, and not to introduce file output; it is to let `/review` emit the full issue list directly so the command can participate in shell pipelines and redirection.

This plan must stay proportionate. It should not redesign the reviewer prompts, replace the current finding parser, or add a new persistence layer. It must avoid temporary artifacts on disk. It must not break JSON mode, because machine-readable event streaming and raw markdown-on-stdout are incompatible output contracts.

## Strategy Overview

The change will extend the existing review argument parser with `--report <level>`, using the same severity threshold vocabulary already used by `--fix`. The extension handler in `pi/code-review/extensions/index.ts` will continue to share the existing front half of the workflow: parse args, gather diff, run review skills, parse findings, deduplicate findings, and sort by severity.

After findings are ready, the handler will branch into three mutually exclusive modes. The default mode remains the current interactive triage flow. `--fix` remains the current queued auto-fix flow. `--report` becomes a new report-rendering flow that formats the selected findings into one deterministic markdown document.

To make the feature usable from `pi -p` without corrupting JSON mode, the implementation will add a small runtime-mode detector that distinguishes print mode from other non-interactive modes. In print mode, `--report` will write the report to standard output and write fatal errors or parse-suspicion warnings to standard error. In interactive mode, `--report` will notify the user that this flag requires print mode and direct them to use `pi -p`. A follow-up plan may add a read-only TUI viewer for interactive `--report`, but that is out of scope here.

The design will reuse the existing `matchesFixThreshold()` helper so `--report medium` means the same severity cutoff as `--fix medium`. It will also reuse the existing `ReviewDependencies` injection pattern so tests can assert output behavior without requiring a real TUI or direct writes to process streams.

## Alternatives Considered

The simplest plausible alternative is to make `--fix` optionally dry-run and print the selected findings instead of queueing them. That was rejected because it overloads a flag whose current meaning is "take action on findings." A separate `--report` flag makes the intent obvious and preserves backward-compatible `--fix` behavior.

Another alternative is to write the full report to a file such as `.pi/review-report.md` and only print the path. That was rejected because the user specifically wants `pi -p` output and does not want cleanup work for transient files.

A third alternative is to treat all `ctx.hasUI === false` sessions the same and always print reports to standard output. That was rejected because JSON mode is also non-interactive, and writing plain markdown into a JSON event stream would break that mode's contract.

## Risks and Countermeasures

The largest technical risk is confusing print mode with JSON mode, because both modes make `ctx.hasUI` false. The countermeasure is to introduce an explicit runtime-mode detector, test it directly, and only allow headless report output when the current process is in print mode. Because the detector's correctness depends on `process.argv` containing the expected flags at handler invocation time — which has not been verified — the plan includes an early spike step that confirms the actual argv shape before committing to this approach. If the spike fails, the plan must be revised before continuing.

A second risk is silent failures in headless mode. The current handler reports problems through `ctx.ui.notify()`, but print mode treats UI methods as no-ops. The countermeasure is to make the `--report` headless branch write user-visible errors and warnings to standard error instead of relying on notifications.

A third risk is overbuilding the presentation layer before the core feature is validated. The countermeasure is to scope the first version to print-mode output only, deferring an interactive TUI viewer to a follow-up. This keeps the initial change small and lets the report format stabilize before investing in a richer presenter.

A fourth risk is adding a report format that looks successful even when parsing actually failed. The current command already distinguishes "no issues found" from "response looked substantial but findings could not be parsed." The countermeasure is to preserve that distinction in report mode and treat the parse-suspicion case as a warning or failure message, not as an empty clean report. In print mode, the parse-suspicion warning will be written to stderr with the exact message: `Review completed but no findings could be parsed — the response may not have used the expected format. Try again or check the diff format.` A dedicated test will assert this message.

A fifth risk is that `process.stdout.write()` in print mode may not reach the user if `pi -p` buffers or redirects stdout through its own rendering pipeline. The countermeasure is to verify this during the argv spike step: when the temporary instrumentation writes to stdout and stderr, the implementer must confirm the output appears on the terminal. If stdout is captured or redirected by the pi runtime, the plan must be updated with the correct output mechanism.

## Progress

- [x] (2026-04-09 00:00Z) Reviewed the current `/review` extension, parser, and tests in `pi/code-review/extensions/index.ts`, `pi/code-review/lib/review-range.ts`, `pi/code-review/lib/review-range.test.ts`, and `test/extensions/code-review.test.ts`.
- [x] (2026-04-09 00:00Z) Verified that `package.json` registers the review extension from `pi/code-review/extensions`, not from `packages/code-review/extensions`.
- [x] (2026-04-09 00:00Z) Authored this ExecPlan for `--report` with headless `pi -p` output as the primary acceptance target.
- [ ] Add parser and handler tests for `--report`, print-mode detection, `--fix`/`--report` exclusivity, report formatting, and parse-suspicion handling.
- [ ] Implement `--report` argument parsing in `pi/code-review/lib/review-range.ts` and commit.
- [ ] Spike: validate `process.argv` shape under `pi -p` and `pi --mode json` before implementing mode detection.
- [ ] Implement mode detection, report formatting, ReviewDependencies extension, and handler branching in `pi/code-review/extensions/index.ts`.
- [ ] Implement print-mode report output and stderr error writing.
- [ ] Update `README.md` usage and examples, including correction of the stale `packages/code-review/...` path reference.
- [ ] Run focused review tests, run the full test suite, and manually verify `pi -p "/review <language> --report all"` from the repository root.

## Surprises & Discoveries

- Observation: The repository's live review extension is in `pi/code-review/extensions/index.ts`, but `README.md` still describes the feature as living in `packages/code-review/extensions/index.ts`.
  Evidence: `package.json` lists `./pi/code-review/extensions` under `pi.extensions`, while the README review section still names `packages/code-review/extensions/index.ts`.

- Observation: The review extension already has a dependency-injection seam named `ReviewDependencies`, so report output can be tested without coupling tests to a real TUI or real process streams.
  Evidence: `pi/code-review/extensions/index.ts` defines `ReviewDependencies` and uses injected implementations for parsing, diff gathering, review execution, finding processing, and fix queueing.

- Observation: The current tests already exercise the no-UI early return path, so this feature will need to replace that behavior with a narrower rule rather than simply adding more tests.
  Evidence: `test/extensions/code-review.test.ts` contains a test named `/review exits early when hasUI is false`.

## Decision Log

- Decision: Add a new `--report <high|medium|low|all>` flag instead of changing `--fix` semantics.
  Rationale: Reporting and fixing are separate intentions, and keeping them separate preserves existing user expectations.
  Date: 2026-04-09

- Decision: `--report` and `--fix` are mutually exclusive.
  Rationale: Running both in the same invocation creates ambiguous behavior about whether the command should output findings, queue fixes, or do both.
  Date: 2026-04-09

- Decision: Headless report output is supported for print mode only, not for JSON mode.
  Rationale: JSON mode owns standard output for JSON lines, so writing raw markdown there would break the protocol.
  Date: 2026-04-09

- Decision: The report output will be one deterministic markdown document written to standard output in print mode.
  Rationale: Markdown is easy to read in the terminal, easy to redirect to a file intentionally, and requires no cleanup.
  Date: 2026-04-09

- Decision: Interactive `--report` is deferred. The first version rejects `--report` outside print mode with a helpful error.
  Rationale: The primary use case is `pi -p` output. Deferring the interactive TUI viewer keeps the initial change small and avoids designing a custom TUI component before the report format stabilizes. A follow-up plan can add a read-only viewer once the feature is validated.
  Date: 2026-04-09

- Decision: Runtime-mode detection uses an injectable `detectReviewOutputMode` helper that inspects `process.argv`, validated by a spike before implementation.
  Rationale: The pi extension API does not currently expose a mode indicator on `ctx`. Inspecting `process.argv` is the simplest available mechanism, but its correctness depends on the pi runtime not consuming or rewriting argv before the handler runs. Making the helper injectable means tests never depend on real argv, and if the spike reveals argv is unreliable, only the default implementation changes.
  Date: 2026-04-09

- Decision: JSON mode + `--report` produces a specific error: `"--report requires print mode (-p). It cannot be used in JSON mode."`
  Rationale: A deterministic error message makes the rejection testable and gives the user a clear remediation path. Writing markdown into JSON event streams is the worst failure mode, so this case must be caught explicitly.
  Date: 2026-04-09

## Outcomes & Retrospective

This section will be filled in after implementation milestones complete.

## Context and Orientation

The review feature lives under `pi/code-review/`. The main command handler is `pi/code-review/extensions/index.ts`. That file currently parses arguments, resolves the requested revision range through `pi/code-review/lib/review-range.ts`, runs the selected review skills, parses findings from model output using `pi/code-review/lib/parser.ts`, deduplicates and sorts findings, and then either queues fixes or presents each finding interactively.

The parser for review command flags lives in `pi/code-review/lib/review-range.ts`. It currently knows about `-r` and `--revisions`, and it also parses `--fix`. The matching parser test file is `pi/code-review/lib/review-range.test.ts`.

The command-level behavior tests live in `test/extensions/code-review.test.ts`. These tests do not run a full pi session. Instead they register the command with fake dependencies and assert how the handler behaves. That makes this file the correct place to test `--report` routing, headless print behavior, and error handling.

The top-level README has a section called "Pi `/review` command" that documents the command grammar and examples. That section must be updated when the new flag lands.

In this plan, "print mode" means invoking pi with `-p` or `--print`, which prints and exits without interactive TUI controls. "JSON mode" means invoking pi with `--mode json`, which streams machine-readable JSON lines. The implementation must not confuse those two modes even though both are non-interactive.

## Preconditions and Verified Facts

The repository currently uses `package.json` to register `./pi/code-review/extensions` as a pi extension package entry. The review tests run under Node's built-in test runner through the root `npm test` script, which is currently `node --experimental-strip-types --test '**/*.test.ts' '**/*.test.js'`.

`pi/code-review/extensions/index.ts` currently rejects all `ctx.hasUI === false` invocations before argument parsing continues, and it currently documents only `--fix` in its file header comments. The command already uses lazy imports for runtime-only packages, so adding report rendering logic must preserve that test-friendly loading strategy.

`pi/code-review/lib/review-range.ts` already defines `FixLevel`, `ReviewOptions`, `ParsedReviewArgs`, and `REVIEW_USAGE`. The parser already rejects missing values and unknown flags with deterministic messages, so `--report` must follow that style.

`test/extensions/code-review.test.ts` already provides helpers named `createTestCtx()` and `setupReviewCommand()` that make it straightforward to inject new report-specific behavior and capture outputs.

The installed pi runtime defines print mode as non-interactive and disables TUI prompting there. This plan assumes that behavior remains true during implementation. If the runtime changes before implementation begins, the implementer must re-check the actual mode behavior and update this plan before proceeding.

## Scope Boundaries

In scope are the `/review` argument grammar, the command handler's mode routing, deterministic report formatting, print-mode output delivery, targeted tests, and README documentation.

Out of scope are new review prompt formats, changes to the finding parser semantics, a new JSON report format, writing reports to disk automatically, changing how `--fix` batches findings, or a repository-wide abstraction for output streams across all extensions. This is a focused enhancement to the existing review command.

Also out of scope is changing the non-interactive behavior of `/review` when `--report` is not present. The normal command should still require interactive UI for the default triage mode and for any future fix-with-instructions flow.

Also out of scope is a read-only TUI viewer for `--report` in interactive mode. The first version restricts `--report` to print mode. An interactive presenter can be added in a follow-up once the report format is stable.

## Milestones

Milestone 1 proves the command grammar, validates the mode-detection mechanism, and commits the parser changes before any handler logic changes. At the end of it, the parser tests should pass, the spike should have confirmed `process.argv` behavior, and the parser changes should be committed independently so they can be rolled back without affecting the handler.

Milestone 2 implements the new parser and report branch using one shared report formatter. At the end of it, running the targeted test suite should show that the command can build a deterministic report, filter it by severity threshold, bypass both auto-fix queueing and per-finding triage, and emit output correctly in print mode.

Milestone 3 updates the README and performs full validation. At the end of it, the feature should work from `pi -p`, interactive `--report` should produce a clear error directing the user to print mode, and the documentation should match the real file paths and command grammar in the repository.

## Plan of Work

Start in `pi/code-review/lib/review-range.ts`. Extend `ReviewOptions` with `reportLevel?: FixLevel`. Update `REVIEW_USAGE` so it reads `/review <language> [types...] [-r|--revisions <range>] [--fix <high|medium|low|all>] [--report <high|medium|low|all>]`. Parse `--report` using the same normalization helper as `--fix`. If the user supplies both `--fix` and `--report`, return a deterministic parser error that tells them to choose exactly one post-review action flag.

Then move to `pi/code-review/extensions/index.ts`. Change the early `!ctx.hasUI` rejection into a more precise gate. The command should still reject non-interactive sessions when neither `--report` nor print mode support applies. Add a small pure helper named `detectReviewOutputMode` that inspects `process.argv` and returns whether the current run is interactive, print, or JSON. The helper must be injectable through `ReviewDependencies` so that tests can override it without manipulating real process state, and so that the plan can be updated if the argv shape turns out to be different than expected.

Before implementing the mode detector, the implementer must run a spike to confirm that `process.argv` actually contains the expected flags (`-p`, `--print`, `--mode json`) when extensions run inside `pi -p` and `pi --mode json`. If the spike reveals that argv is consumed or rewritten by the pi runtime before the handler runs, the implementer must stop and update this plan with an alternative strategy such as requesting an upstream `ctx.mode` API or detecting mode from an environment variable. Do not key this logic off `ctx.hasUI` alone — that boolean is true for both JSON mode and print mode, which have incompatible output contracts.

Add a pure report formatter in `pi/code-review/extensions/index.ts` and export it for tests. The formatter should accept the deduplicated findings plus lightweight metadata such as language, range, requested threshold, total findings, and matched findings. It should return one markdown string. The string must be deterministic so tests can compare exact substrings. Include a header summary and then list findings grouped by severity in the already-sorted order. Each finding entry should include title, file when present, originating skill, issue text, and suggested fix text.

Add a report presenter layer in the same file. The presenter should accept the formatted string and write it to standard output in print mode. For errors and the parse-suspicion warning, a separate error writer should write to standard error. Both the presenter and the error writer should be injectable through `ReviewDependencies` so tests can capture output without writing to real process streams. In interactive mode, the handler should reject `--report` with a notification telling the user to run the command via `pi -p` instead. In JSON mode, the handler should reject with `"--report requires print mode (-p). It cannot be used in JSON mode."`

Update the handler so that after findings are parsed, deduplicated, and sorted, it branches in this order: report path first, then fix path, then default interactive triage path. The report path must apply `matchesFixThreshold()` to choose which findings to include, because the report threshold semantics should match the fix threshold semantics exactly.

Preserve the existing distinction between "no issues found" and "response could not be parsed reliably." If the review result has zero parsed findings and the current code would emit the parse-suspicion warning, the report path should surface that warning instead of outputting an empty successful report. If there are parsed findings but none match the selected report threshold, output a valid report that says the review ran and that zero findings matched the selected threshold.

Finally update `README.md`. Correct the stale `packages/code-review/extensions/index.ts` path reference to `pi/code-review/extensions/index.ts`, add `--report` to the documented usage string, and add examples showing `pi -p` use.

## Concrete Steps

All commands below run from the repository root.

### Milestone 1: Parser tests, spike, and parser commit

1. In `pi/code-review/lib/review-range.test.ts`, add seven failing tests for the `--report` flag:

   - `"parseReviewArgs parses --report high into reportLevel"` — call `parseReviewArgs("gleam --report high")`, assert `result.options.reportLevel` equals `"high"` and `result.error` is `undefined`.
   - `"parseReviewArgs parses --report medium into reportLevel"` — same pattern, assert `"medium"`.
   - `"parseReviewArgs parses --report low into reportLevel"` — assert `"low"`.
   - `"parseReviewArgs parses --report all into reportLevel"` — assert `"all"`.
   - `"parseReviewArgs errors on --report without a value"` — call `parseReviewArgs("gleam --report")`, assert `result.error` contains `"Missing value for --report"`.
   - `"parseReviewArgs errors on invalid --report level"` — call `parseReviewArgs("gleam --report urgent")`, assert `result.error` contains `"Invalid --report level"`.
   - `"parseReviewArgs errors when --fix and --report are both present"` — call `parseReviewArgs("gleam --fix high --report all")`, assert `result.error` contains `"Cannot use --fix and --report together"`.

2. In `test/extensions/code-review.test.ts`, replace the existing `"/review exits early when hasUI is false"` test with three tests. All three use `setupReviewCommand` with an injected `detectOutputMode` override (a new seam in `ReviewDependencies` described in step 16).

   - `"/review gleam still errors without UI when --report is not present"` — set `ctx.hasUI = false`, inject `detectOutputMode: () => "interactive"`. Call `review.handler("gleam", ctx)`. Assert notifications include a message containing `"interactive terminal"`.
   - `"/review gleam --report all in print mode outputs report and bypasses triage"` — set `ctx.hasUI = false`, inject `detectOutputMode: () => "print"`, inject a `reportPresenter` that captures its argument into a local `let capturedReport: string`. Inject `runReviews` returning one `sampleFinding("MEDIUM", "test-find")`. Call `review.handler("gleam --report all", ctx)`. Assert `capturedReport` is defined and contains `"test-find"`. Assert `processFindingActions` was not called (inject a counter). Assert `queueFixFollowUp` was not called.
   - `"/review gleam --report all in interactive mode notifies user to use pi -p"` — set `ctx.hasUI = true`, inject `detectOutputMode: () => "interactive"`. Call `review.handler("gleam --report all", ctx)`. Assert notifications include a message containing `"pi -p"`.

3. In `test/extensions/code-review.test.ts`, add three failing report-content tests. All inject `detectOutputMode: () => "print"`, set `ctx.hasUI = false`, inject a `reportPresenter` that captures its string argument, and inject `runReviews` returning three findings: `sampleFinding("HIGH", "high-find")`, `sampleFinding("MEDIUM", "medium-find")`, `sampleFinding("LOW", "low-find")`.

   - `"/review gleam --report high includes only HIGH findings in report"` — call `review.handler("gleam --report high", ctx)`. Assert the captured report contains `"high-find"` and does not contain `"medium-find"` or `"low-find"`. Assert the report contains `"Findings: 1 of 3 matched"`.
   - `"/review gleam --report medium includes HIGH and MEDIUM findings"` — assert report contains `"high-find"` and `"medium-find"`, does not contain `"low-find"`. Contains `"Findings: 2 of 3 matched"`.
   - `"/review gleam --report all includes all findings in severity order"` — assert report contains all three. Assert `report.indexOf("high-find") < report.indexOf("medium-find")` and `report.indexOf("medium-find") < report.indexOf("low-find")`. Contains `"Findings: 3 of 3 matched"`.

4. In `test/extensions/code-review.test.ts`, add `"/review gleam --report all bypasses processFindingActions and queueFixFollowUp"`. Inject `detectOutputMode: () => "print"`, set `ctx.hasUI = false`, inject counters for both `processFindingActions` and `queueFixFollowUp`, and inject `runReviews` returning one finding. Assert both counters remain zero after calling `review.handler("gleam --report all", ctx)`.

5. In `test/extensions/code-review.test.ts`, add two failing edge-case tests:

   - `"/review gleam --report high with only LOW findings reports zero matches"` — inject `runReviews` returning `[sampleFinding("LOW", "minor-thing")]`, inject `detectOutputMode: () => "print"`, set `ctx.hasUI = false`, inject a capturing `reportPresenter`. Call with `"gleam --report high"`. Assert the captured report contains `"Findings: 0 of 1 matched"` and `"No findings matched --report high."`.
   - `"/review gleam --report all with zero findings and large response writes parse-suspicion warning to stderr"` — inject `runReviews` returning `{ ok: true, findings: [], totalResponseLength: 500 }`, inject `detectOutputMode: () => "print"`, set `ctx.hasUI = false`, inject a capturing `reportErrorWriter` and a capturing `reportPresenter`. Call with `"gleam --report all"`. Assert the `reportErrorWriter` was called with a string containing `"no findings could be parsed"`. Assert `reportPresenter` was not called.

6. In `test/extensions/code-review.test.ts`, add `"/review gleam --report all in JSON mode rejects with error"`. Set `ctx.hasUI = false`, inject `detectOutputMode: () => "json"`. Call `review.handler("gleam --report all", ctx)`. Assert notifications include a message containing `"--report requires print mode (-p). It cannot be used in JSON mode."`.

7. In `test/extensions/code-review.test.ts`, add `"buildFindingsReport produces deterministic markdown with heading, metadata, and findings"`. Import `buildFindingsReport` directly. Call it with findings `[sampleFinding("HIGH", "auth-bypass"), sampleFinding("MEDIUM", "missing-guard")]`, language `"gleam"`, range `"@"`, threshold `"medium"`, and `totalFindings: 3`. Assert the result:
   - Starts with `"# Review report\n"`.
   - Contains `"Language: gleam"`, `"Range: @"`, `"Threshold: medium"`, and `"Findings: 2 of 3 matched"`.
   - Contains `"## HIGH"` followed by `"### 1. auth-bypass"` with `"File: src/auth-bypass.gleam"`, `"Skill: gleam-code-review"`, `"Issue:\nauth-bypass issue"`, and `"Suggested fix:\nauth-bypass suggestion"`.
   - Contains `"## MEDIUM"` followed by `"### 2. missing-guard"` with matching fields.

8. In `test/extensions/code-review.test.ts`, add `"detectReviewOutputMode classifies argv correctly"`. Import `detectReviewOutputMode` directly. Assert the following cases:
   - `detectReviewOutputMode(["node", "pi", "-p"])` returns `"print"`.
   - `detectReviewOutputMode(["/usr/local/bin/node", "/path/to/pi", "-p", "/review gleam"])` returns `"print"`.
   - `detectReviewOutputMode(["node", "pi", "--print"])` returns `"print"`.
   - `detectReviewOutputMode(["node", "pi", "--mode", "json"])` returns `"json"`.
   - `detectReviewOutputMode(["node", "pi"])` returns `"interactive"`.
   - `detectReviewOutputMode(["node", "pi", "--mode", "json", "-p"])` returns `"json"` (JSON takes precedence as the safer classification).
   - `detectReviewOutputMode([])` returns `"interactive"`.

9. Run the focused red phase:

        node --experimental-strip-types --test pi/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts

   Expect all new tests to fail. Existing tests should still pass.

10. In `pi/code-review/lib/review-range.ts`, add `reportLevel?: FixLevel` to `ReviewOptions`. In `parseReviewArgs`, add a `--report` branch that mirrors the existing `--fix` branch: consume the next token, validate it with `normalizeFixLevel`, and set `result.options.reportLevel`. After the token loop, if both `fixLevel` and `reportLevel` are set, return `{ ...result, error: "Cannot use --fix and --report together. Choose one post-review action." }`. Update `REVIEW_USAGE` to include `[--report <high|medium|low|all>]`.

11. Run the parser tests only to confirm they pass:

        node --experimental-strip-types --test pi/code-review/lib/review-range.test.ts

    Expect all parser tests to pass, including the seven new `--report` tests.

12. Commit the parser changes:

        git add pi/code-review/lib/review-range.ts pi/code-review/lib/review-range.test.ts
        git commit -m "feat(code-review): parse --report flag in review args"

### Milestone 2: Mode detection spike, handler, and report output

13. Spike: validate `process.argv` shape in print mode and JSON mode. Add a temporary `console.error("SPIKE_ARGV:", JSON.stringify(process.argv))` line to the top of the review handler in `pi/code-review/extensions/index.ts`, then run:

        pi -p "/review gleam"
        pi --mode json "/review gleam"

    Observe the argv arrays printed to stderr. Record the exact shapes in the Surprises & Discoveries section. Confirm that `-p` or `--print` appears as a distinct token in print mode, and `--mode` followed by `"json"` appears in JSON mode. Also confirm that `process.stdout.write("SPIKE_STDOUT_TEST\n")` output from the handler is visible on the terminal in print mode. Remove all temporary instrumentation before proceeding. If argv does not contain the expected flags, or if stdout writes are swallowed, stop and update this plan with an alternative detection strategy before continuing.

14. In `pi/code-review/extensions/index.ts`, add and export a pure function `detectReviewOutputMode(argv?: string[]): "interactive" | "print" | "json"`. The function should default `argv` to `process.argv`. It should scan the array for `--mode` followed by `"json"` and return `"json"` if found (checking JSON first is the safer default since misclassifying JSON mode is the worst failure). Then scan for `-p` or `--print` and return `"print"` if found. Otherwise return `"interactive"`.

15. In `pi/code-review/extensions/index.ts`, add and export a pure function `buildFindingsReport`. It accepts `findings: Finding[]` and `options: { language: string; range: string; threshold: FixLevel; totalFindings: number }`. It returns a deterministic markdown string structured as follows:

    - Line 1: `# Review report` followed by a blank line.
    - Metadata block: `Language: <language>`, `Range: <range>`, `Threshold: <threshold>`, `Findings: <matched count> of <totalFindings> matched`, each on its own line, followed by a blank line.
    - If no findings were passed, append `No findings matched --report <threshold>.\n` and return.
    - Otherwise, group findings by severity in the order they appear (already sorted). For each severity group, emit `## <SEVERITY>` as a heading. For each finding, emit `### <n>. <title>` (where n is the 1-indexed position across all findings), then `File: <file>` if present, `Skill: <skill>`, a blank line, `Issue:\n<issue>`, a blank line, `Suggested fix:\n<suggestion>`, and a trailing blank line.

16. In `pi/code-review/extensions/index.ts`, extend the `ReviewDependencies` type with three optional seams:

    - `detectOutputMode?: () => "interactive" | "print" | "json"` — defaults to `() => detectReviewOutputMode()`.
    - `reportPresenter?: (report: string) => void` — defaults to `(report) => process.stdout.write(report)`.
    - `reportErrorWriter?: (message: string) => void` — defaults to `(msg) => process.stderr.write(msg + "\n")`.

    Wire these defaults in `registerReviewCommand` alongside the existing dependency wiring.

17. In `pi/code-review/extensions/index.ts`, refactor the handler's non-interactive guard. Currently the handler starts with:

        if (!ctx.hasUI) {
          ctx.ui.notify("review requires interactive terminal", "error");
          return;
        }

    Move the `parseArgs(args)` call, its error check, and its usage check above this guard so that `--report` can be detected before rejection. Then replace the blanket `!ctx.hasUI` check with mode-aware logic:

    - If `parsed.options.reportLevel` is set, check the output mode via the injected `detectOutputMode()`. If the mode is `"json"`, call `ctx.ui.notify("--report requires print mode (-p). It cannot be used in JSON mode.", "error")` and return. If the mode is `"interactive"`, call `ctx.ui.notify("--report requires print mode. Run: pi -p \"/review <args>\"", "error")` and return. If the mode is `"print"`, continue to the review pipeline.
    - If `parsed.options.reportLevel` is not set and `!ctx.hasUI`, keep the existing `"review requires interactive terminal"` rejection.

18. In `pi/code-review/extensions/index.ts`, add the report-output branch after findings are deduplicated and sorted. Insert it before the existing `--fix` branch. The branch activates when `parsed.options.reportLevel` is set:

    - First check the parse-suspicion case: if `dedupedFindings.length === 0` and `totalResponseLength >= MIN_RESPONSE_FOR_SUSPICION` (the constant already exists as `200`), call `reportErrorWriter("Review completed but no findings could be parsed \u2014 the response may not have used the expected format. Try again or check the diff format.")` and return.
    - Filter findings using `matchesFixThreshold(finding.severity, parsed.options.reportLevel)`.
    - Call `buildFindingsReport(matchedFindings, { language, range: parsed.options.range, threshold: parsed.options.reportLevel, totalFindings: dedupedFindings.length })`.
    - Call `reportPresenter(report)` and return.

19. Run the focused green phase:

        node --experimental-strip-types --test pi/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts

    Expect all targeted review tests to pass, including all new `--report`, routing, formatter, and mode-detection tests.

20. Commit the handler and report work:

        git add pi/code-review/extensions/index.ts test/extensions/code-review.test.ts
        git commit -m "feat(code-review): implement --report print-mode output"

### Milestone 3: Documentation and validation

21. In `README.md`, update the `/review` section: correct the stale `packages/code-review/extensions/index.ts` path reference to `pi/code-review/extensions/index.ts`. Update the usage line to `/review <language> [types...] [-r|--revisions <range>] [--fix <high|medium|low|all>] [--report <high|medium|low|all>]`. Add a `--report` description and an example: `pi -p "/review gleam --report all"`.

22. Run the full test suite:

        npm test

    Expect all tests to pass.

23. Manually validate print-mode behavior:

        pi -p "/review gleam --report all"

    Expect a markdown report on standard output starting with `# Review report`, followed by `Language: gleam`, `Range: @`, `Threshold: all`, `Findings: N of N matched`, and finding sections grouped by severity. No interactive prompts, no temporary files.

24. Manually validate JSON-mode rejection:

        pi --mode json "/review gleam --report all"

    Expect the command to be rejected without emitting raw markdown into the JSON event stream. The handler calls `ctx.ui.notify("--report requires print mode (-p). It cannot be used in JSON mode.", "error")` and returns early. The specific way this surfaces in JSON mode output depends on the pi runtime's error serialization, but no markdown report text should appear.

25. Manually validate interactive-mode rejection:

    Run `/review gleam --report all` from inside a normal interactive pi session. Expect a notification telling the user to use `pi -p "/review gleam --report all"` instead. The command should not enter the triage flow or produce a report.

26. Commit the documentation update:

        git add README.md docs/plans/pi-code-review-report-mode-plan.md
        git commit -m "docs(code-review): document report mode for /review"

## Testing and Falsifiability

The parser changes are falsified by seven tests in `pi/code-review/lib/review-range.test.ts`. Four tests assert that `parseReviewArgs("gleam --report <level>")` sets `options.reportLevel` to the expected level and leaves `error` undefined. Three tests assert deterministic error messages: `"Missing value for --report"` when the value is absent, `"Invalid --report level"` for an unrecognized level like `"urgent"`, and `"Cannot use --fix and --report together"` when both flags are present.

The command-routing changes are falsified by three tests in `test/extensions/code-review.test.ts`. The first confirms that `/review gleam` with `ctx.hasUI = false` and no `--report` still reports `"interactive terminal"` error. The second confirms that `/review gleam --report all` with `detectOutputMode` injected as `() => "print"` reaches the `reportPresenter` and does not call `processFindingActions` or `queueFixFollowUp`. The third confirms that `/review gleam --report all` with `detectOutputMode` returning `"interactive"` notifies the user that `--report` requires `pi -p`.

Report-content tests use three sample findings (HIGH `"high-find"`, MEDIUM `"medium-find"`, LOW `"low-find"`) and inject a `reportPresenter` that captures its string argument. For `--report high`, the captured report contains `"high-find"` and `"Findings: 1 of 3 matched"` but not `"medium-find"` or `"low-find"`. For `--report medium`, it contains both `"high-find"` and `"medium-find"` and `"Findings: 2 of 3 matched"` but not `"low-find"`. For `--report all`, it contains all three and `"Findings: 3 of 3 matched"`, with severity order verified by `report.indexOf("high-find") < report.indexOf("medium-find")` and `report.indexOf("medium-find") < report.indexOf("low-find")`.

The zero-match case is falsified by a test that injects one LOW finding and calls `--report high`. The captured report contains `"Findings: 0 of 1 matched"` and `"No findings matched --report high."`.

The parse-suspicion case is falsified by a test that injects `runReviews` returning `{ ok: true, findings: [], totalResponseLength: 500 }`. The test injects a capturing `reportErrorWriter` and asserts the captured string contains `"no findings could be parsed"`. The `reportPresenter` must not be called — the handler writes to stderr instead of producing a successful-looking empty report.

The JSON-mode rejection is falsified by a test that injects `detectOutputMode: () => "json"` and asserts the notification contains `"--report requires print mode (-p). It cannot be used in JSON mode."`.

A direct `buildFindingsReport` unit test calls the formatter with `[sampleFinding("HIGH", "auth-bypass"), sampleFinding("MEDIUM", "missing-guard")]`, language `"gleam"`, range `"@"`, threshold `"medium"`, and `totalFindings: 3`. It asserts the output starts with `"# Review report\n"`, contains the metadata lines `"Language: gleam"`, `"Range: @"`, `"Threshold: medium"`, `"Findings: 2 of 3 matched"`, and includes per-finding sections: `"## HIGH"` before `"### 1. auth-bypass"` with `"File: src/auth-bypass.gleam"`, `"Skill: gleam-code-review"`, `"Issue:\nauth-bypass issue"`, `"Suggested fix:\nauth-bypass suggestion"`, then `"## MEDIUM"` before `"### 2. missing-guard"` with matching fields.

A direct `detectReviewOutputMode` unit test classifies multiple realistic argv shapes:
- `["node", "pi", "-p"]` → `"print"`
- `["/usr/local/bin/node", "/path/to/pi", "-p", "/review gleam"]` → `"print"`
- `["node", "pi", "--print"]` → `"print"`
- `["node", "pi", "--mode", "json"]` → `"json"`
- `["node", "pi"]` → `"interactive"`
- `["node", "pi", "--mode", "json", "-p"]` → `"json"` (JSON takes precedence as the safer classification)
- `[]` → `"interactive"`

The final falsifier is the manual print-mode smoke test. If `pi -p "/review gleam --report all"` does not emit a full report to standard output, or if it creates a file as part of normal operation, the plan has failed.

## Validation and Acceptance

Acceptance is behavioral. After implementation, the user must be able to run `pi -p "/review gleam --report all"` from the repository root and receive the report on standard output with no interactive prompt and no temporary file. Running `/review gleam --report all` in a normal interactive session must produce a notification directing the user to use `pi -p` instead. Running `pi --mode json "/review gleam --report all"` must produce an error without emitting markdown into the JSON event stream.

From the repository root, run:

    node --experimental-strip-types --test pi/code-review/lib/review-range.test.ts test/extensions/code-review.test.ts

Expect all targeted tests to pass. Then run:

    npm test

Expect the full test suite to pass.

Finally run:

    pi -p "/review gleam --report high"

Expect output shaped like this, with repository-specific findings substituted for the example text:

    # Review report

    Language: gleam
    Range: @
    Threshold: high
    Findings: 1 of 3 matched

    ## HIGH

    ### 1. high-find
    File: src/high-find.gleam
    Skill: gleam-code-review

    Issue:
    high-find issue

    Suggested fix:
    high-find suggestion

If no findings match the threshold, expect a valid report that states the review ran and that zero findings matched, not an empty output stream.

## Rollout, Recovery, and Idempotence

This change is additive and localized. No migration is required, and existing `/review` invocations without `--report` should keep their current behavior. If implementation goes wrong, the change can be rolled back by removing the new parser branch and report presenter code from `pi/code-review/lib/review-range.ts`, `pi/code-review/extensions/index.ts`, and the README section.

The manual validation commands are idempotent. Re-running the review in print mode should simply emit another report; it must not create or depend on temporary state.

Because JSON mode must remain clean, any uncertainty about mode detection should default to the safer failure path that rejects headless reporting outside print mode. A false negative there is acceptable; a false positive that corrupts JSON output is not.

## Artifacts and Notes

Expected updated command grammar in `README.md` and in `pi/code-review/lib/review-range.ts`:

    /review <language> [types...] [-r|--revisions <range>] [--fix <high|medium|low|all>] [--report <high|medium|low|all>]

Example threshold-no-match report:

    # Review report

    Language: gleam
    Range: @
    Threshold: high
    Findings: 0 of 1 matched

    No findings matched --report high.

Example exclusivity error from the parser:

    Cannot use --fix and --report together. Choose one post-review action.

## Interfaces and Dependencies

No new npm dependencies are required.

In `pi/code-review/lib/review-range.ts`, keep using the existing `FixLevel` type for both fix and report thresholds. `ReviewOptions` should become:

    export interface ReviewOptions {
      range: string;
      fixLevel?: FixLevel;
      reportLevel?: FixLevel;
    }

In `pi/code-review/extensions/index.ts`, extend `ReviewDependencies` with three report-specific injectable seams so tests can observe behavior without writing to real process streams:

    detectOutputMode?: () => "interactive" | "print" | "json";
    reportPresenter?: (report: string) => void;
    reportErrorWriter?: (message: string) => void;

The defaults should be `() => detectReviewOutputMode()`, `(report) => process.stdout.write(report)`, and `(msg) => process.stderr.write(msg + "\n")` respectively.

Export a pure report formatter helper, for example:

    export function buildFindingsReport(
      findings: Finding[],
      options: {
        language: string;
        range: string;
        threshold: FixLevel;
        totalFindings: number;
      },
    ): string;

Also add a pure helper that distinguishes runtime output modes from `process.argv`, for example:

    export function detectReviewOutputMode(argv?: string[]): "interactive" | "print" | "json";

The default `argv` parameter should be `process.argv`. The function should check for JSON mode first (`--mode` followed by `"json"`) since misclassifying JSON mode is the worst failure. Then check for print mode (`-p` or `--print`). Default to `"interactive"`. This function is injectable through `ReviewDependencies` so tests never depend on real process state.

The handler in `pi/code-review/extensions/index.ts` must preserve its existing behavior for `runReviews`, `queueAutoFixes`, and `processFindingActions`; `--report` is a new branch after findings are available, not a replacement for the earlier pipeline.
