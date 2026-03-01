---
name: exec-plan
description: >
  Write or implement execution plans (ExecPlans) — thorough, self-contained
  design documents that guide a coding agent through complex features or
  significant refactors. Use this skill when the user asks to "write a plan",
  "create an exec plan", "make an ExecPlan", "plan this feature", "design this
  refactor", "write a design doc for implementation", or when they ask to
  "implement a plan", "execute this plan", "follow the plan", "continue the
  plan", "pick up where the plan left off". Also trigger when the user mentions
  "ExecPlan", "execution plan", or references a PLAN.md or similar planning
  document. This skill covers both authoring plans and executing them.
---

# Execution Plans (ExecPlans)

This skill describes how to author and implement execution plans — thorough, self-contained design documents that a coding agent can follow to deliver a working feature or system change. ExecPlans are living documents: they are written before implementation begins, updated continuously as work proceeds, and serve as the single source of truth throughout the process.

ExecPlans enable complex tasks that take significant time to research, design, and implement. They let the user verify the approach before a long implementation begins, and they let any agent — or human — pick up the work from the plan alone.

## Determining the Mode

Based on the user's request, operate in one of three modes:

- **Authoring**: The user wants to create a new plan. Follow the authoring guidance below to produce a complete ExecPlan.
- **Implementing**: The user wants to execute an existing plan. Follow the implementation guidance below to carry out the work.
- **Discussing**: The user wants to refine, debate, or amend an existing plan without implementing it yet.

---

## Mode 1: Authoring an ExecPlan

When creating an ExecPlan, follow the rules in this skill file _to the letter_. Be thorough in reading (and re-reading) source material to produce an accurate specification. Start from the skeleton and flesh it out as you do your research.

### Non-Negotiable Requirements

Every ExecPlan must satisfy all of the following:

- **Fully self-contained.** The plan contains all knowledge and instructions needed for a novice to succeed. There is no memory of prior plans and no external context. Treat the reader as a complete beginner to the repository: they have only the current working tree and the ExecPlan file.
- **A living document.** Contributors must revise it as progress is made, as discoveries occur, and as design decisions are finalized. Each revision must remain fully self-contained.
- **Novice-enabling.** A complete novice must be able to implement the feature end-to-end without prior knowledge of the repo.
- **Outcome-focused.** The plan must produce a demonstrably working behavior, not merely code changes that "meet a definition."
- **Jargon-free.** Define every term of art in plain language, or do not use it.

### Who This Plan Is For

Write every ExecPlan for a developer who is:

- **Skilled at programming** — they can write code, use a terminal, run tests, and commit. You do not need to explain what a function is.
- **Ignorant of your codebase** — they have never seen the repository. They do not know what files exist, what the architecture looks like, or where anything lives. Name every file, every directory, every module they need to touch.
- **Ignorant of your toolchain** — they may not know your build system, test runner, linter, or deployment target. State the exact command to run, the working directory, and the expected output. Not "run the tests" but "from the repo root, run `npm test` and expect all 47 tests to pass."
- **Ignorant of your domain** — they do not know your business logic, your users, or the problem you are solving. Explain the why, not just the what.
- **Mediocre at test design** — they will write tests if told exactly what to test and how, but they will not invent good test cases on their own. Spell out the scenarios, edge cases, and expected behaviors. Do not say "write tests for the parser." Say "write a test that calls `parse("")` and asserts it returns `Err(EmptyInput)`, and a test that calls `parse("hello world")` and asserts it returns `Ok(Greeting("hello world"))`."

If a plan cannot be implemented by this person without asking questions, it is not ready.

### Writing Principles

**Purpose and intent come first.** Begin by explaining, in a few sentences, why the work matters from a user's perspective: what someone can do after this change that they could not do before, and how to see it working. Then guide the reader through the exact steps to achieve that outcome, including what to edit, what to run, and what they should observe.

**Self-containment and plain language are paramount.** If you introduce a phrase that is not ordinary English ("daemon", "middleware", "RPC gateway", "filter graph"), define it immediately and remind the reader how it manifests in this repository (for example, by naming the files or commands where it appears). Do not say "as defined previously" or "according to the architecture doc." Include the needed explanation here, even if you repeat yourself.

**Embed all required knowledge.** The agent executing the plan can list files, read files, search, run the project, and run tests. It does not know any prior context and cannot infer what you meant from earlier milestones. Repeat any assumption you rely on. Do not point to external blogs or docs; if knowledge is required, embed it in the plan itself in your own words. If a plan builds upon a prior plan that is checked in, incorporate it by reference. If it is not checked in, include all relevant context from that plan.

**Avoid common failure modes.** Do not rely on undefined jargon. Do not describe "the letter of a feature" so narrowly that the resulting code compiles but does nothing meaningful. Do not outsource key decisions to the reader. When ambiguity exists, resolve it in the plan itself and explain why you chose that path. Err on the side of over-explaining user-visible effects and under-specifying incidental implementation details.

**Anchor the plan with observable outcomes.** State what the user can do after implementation, the commands to run, and the outputs they should see. Acceptance should be phrased as behavior a human can verify ("after starting the server, navigating to http://localhost:8080/health returns HTTP 200 with body OK") rather than internal attributes ("added a HealthCheck struct"). If a change is internal, explain how its impact can still be demonstrated (for example, by running tests that fail before and pass after, and by showing a scenario that uses the new behavior).

**Specify repository context explicitly.** Name files with full repository-relative paths, name functions and modules precisely, and describe where new files should be created. If touching multiple areas, include a short orientation paragraph that explains how those parts fit together so a novice can navigate confidently. When running commands, show the working directory and exact command line. When outcomes depend on environment, state the assumptions and provide alternatives when reasonable.

**Be idempotent and safe.** Write the steps so they can be run multiple times without causing damage or drift. If a step can fail halfway, include how to retry or adapt. If a migration or destructive operation is necessary, spell out backups or safe fallbacks. Prefer additive, testable changes that can be validated as you go.

**Validation is not optional.** Include instructions to run tests, to start the system if applicable, and to observe it doing something useful. Describe comprehensive testing for any new features or capabilities. Include expected outputs and error messages so a novice can tell success from failure. Where possible, show how to prove that the change is effective beyond compilation (for example, through a small end-to-end scenario, a CLI invocation, or an HTTP request/response transcript). State the exact test commands appropriate to the project's toolchain and how to interpret their results.

**Capture evidence.** When steps produce terminal output, short diffs, or logs, include them as indented examples. Keep them concise and focused on what proves success. If you need to include a patch, prefer file-scoped diffs or small excerpts that a reader can recreate by following the instructions rather than pasting large blobs.

### Milestones

Milestones are narrative, not bureaucracy. If you break the work into milestones, introduce each with a brief paragraph that describes the scope, what will exist at the end of the milestone that did not exist before, the commands to run, and the acceptance you expect to observe. Keep it readable as a story: goal, work, result, proof. Progress and milestones are distinct: milestones tell the story, progress tracks granular work. Both must exist. Never abbreviate a milestone merely for the sake of brevity — do not leave out details that could be crucial to a future implementation.

Each milestone must be independently verifiable and incrementally implement the overall goal of the plan.

### Task Granularity

Break every milestone into bite-sized steps. Each step is a single, unambiguous action that takes roughly 2–5 minutes. The developer should never wonder "what do I do next?" or "am I done with this step?"

Where applicable, steps follow the TDD cycle:

1. Write the failing test — one step.
2. Run the test to confirm it fails — one step.
3. Write the minimal code to make the test pass — one step.
4. Run the tests to confirm they pass — one step.
5. Commit — one step.

Each step must name the exact file(s) to touch, with full repository-relative paths. Each step must describe what to add, change, or remove concretely — not "update the handler" but "in `src/handlers/auth.ts`, add a new function `validateToken` that takes a `string` and returns a `Result<Claims, AuthError>`." Steps that produce output (running tests, starting a server, making a request) must include the expected output so the developer can tell success from failure.

No step should require the developer to make a design decision. If a decision is needed, the plan makes it and explains why. No step should bundle multiple unrelated changes. "Add the type and write the test and update the config" is three steps, not one.

### Testing Specificity

Assume the developer will not invent good tests on their own. The plan must specify exactly what to test and how.

Every new behavior needs at least one test specified in the plan — not "write tests for this" but "write a test that calls `parse("")` and asserts it returns `Err(EmptyInput)`." Edge cases must be called out explicitly. The developer should not have to think about what the edge cases are; enumerate them.

Name test file locations with full paths. State the test runner command, including how to run a single test or a subset. Describe expected test output (pass/fail counts, specific assertion messages) so the developer knows what "working" looks like. When a test should fail before implementation (the red phase of TDD), say so and describe what the failure looks like. Include integration or end-to-end validation steps where appropriate — not just unit tests.

### Design Principles

Guide the developer toward clean, maintainable code:

- **DRY.** Do not instruct the developer to duplicate logic. If two steps touch similar code, explain where to extract the common part.
- **YAGNI.** Do not introduce abstractions, interfaces, or features that are not required by the current work. No "we might need this later."
- **Minimal scope.** Each milestone delivers the smallest useful increment. No milestone tries to do everything at once.
- **Additive changes.** Where possible, steps add new code before modifying or removing old code, keeping the system working at every commit point.

### Commit Discipline

The plan must produce a clean, readable commit history. Call out commit points explicitly so the developer never has to wonder when to commit. Each commit should represent a logical, self-contained unit of progress — a passing test, a completed refactor step, a new function with its tests. The system must be in a working state (tests pass) at every commit point. Do not instruct the developer to commit broken intermediate states.

Where helpful, suggest commit messages or describe what the commit contains clearly enough that writing a good message is obvious.

### Prototyping and Parallel Implementations

It is acceptable — and often encouraged — to include explicit prototyping milestones when they de-risk a larger change. Examples: adding a low-level operator to a dependency to validate feasibility, or exploring two composition orders while measuring optimizer effects. Keep prototypes additive and testable. Clearly label the scope as "prototyping"; describe how to run and observe results; and state the criteria for promoting or discarding the prototype.

Prefer additive code changes followed by subtractions that keep tests passing. Parallel implementations (e.g., keeping an adapter alongside an older path during migration) are fine when they reduce risk or enable tests to continue passing during a large migration. Describe how to validate both paths and how to retire one safely with tests. When working with multiple new libraries or feature areas, consider creating spikes that evaluate the feasibility of these features _independently_ of one another, proving that the external library performs as expected and implements the needed features in isolation.

When researching a design with challenging requirements or significant unknowns, use milestones to implement proof of concepts, "toy implementations", etc., that allow validating whether the proposal is feasible. Read the source code of libraries by finding or acquiring them, research deeply, and include prototypes to guide a fuller implementation.

### Living Document Sections

Every ExecPlan must contain and maintain all four of the following sections. These are not optional.

1. **Progress** — A checklist summarizing granular steps. Every stopping point must be documented here, even if it requires splitting a partially completed task into two ("done" vs. "remaining"). This section must always reflect the actual current state of the work. Use timestamps to measure rates of progress.

2. **Surprises & Discoveries** — Document unexpected behaviors, bugs, optimizations, or insights discovered during implementation. Provide concise evidence (test output is ideal).

3. **Decision Log** — Record every key design decision with its rationale and date. It should be unambiguously clear why any change to the specification was made.

4. **Outcomes & Retrospective** — Summarize outcomes, gaps, and lessons learned at major milestones or at completion. Compare the result against the original purpose.

### Formatting Rules

Write in plain prose. Prefer sentences over lists. Avoid checklists, tables, and long enumerations unless brevity would obscure meaning. Checklists are permitted only in the Progress section, where they are mandatory. Narrative sections must remain prose-first.

When writing an ExecPlan to a standalone Markdown file (where the file content _is_ the plan), write it as normal Markdown — no wrapping code fence needed. When embedding a plan inside a conversation or another document, wrap the entire plan in a single fenced code block labeled `md`. Do not nest additional triple-backtick code fences inside; use indented blocks instead for commands, transcripts, diffs, or code.

Use two newlines after every heading. Use `#`, `##`, etc. for headings and correct syntax for ordered and unordered lists.

### Skeleton

When creating a new ExecPlan, start from this skeleton and fill in every section:

```
# <Short, action-oriented description>

This ExecPlan is a living document. The sections Progress, Surprises & Discoveries,
Decision Log, and Outcomes & Retrospective must be kept up to date as work proceeds.

## Purpose / Big Picture

Explain in a few sentences what someone gains after this change and how they can see
it working. State the user-visible behavior you will enable.

## Progress

- [x] (YYYY-MM-DD HH:MMZ) Example completed step.
- [ ] Example incomplete step.
- [ ] Example partially completed step (completed: X; remaining: Y).

## Surprises & Discoveries

- Observation: …
  Evidence: …

## Decision Log

- Decision: …
  Rationale: …
  Date: …

## Outcomes & Retrospective

(To be filled at major milestones and at completion.)

## Context and Orientation

Describe the current state relevant to this task as if the reader knows nothing. Name
the key files and modules by full path. Define any non-obvious term you will use. Do
not refer to prior plans.

## Plan of Work

Describe, in prose, the sequence of edits and additions. For each edit, name the file
and location (function, module) and what to insert or change. Keep it concrete and
minimal.

## Concrete Steps

State the exact commands to run and where to run them (working directory). When a
command generates output, show a short expected transcript so the reader can compare.
This section must be updated as work proceeds.

## Validation and Acceptance

Describe how to start or exercise the system and what to observe. Phrase acceptance as
behavior, with specific inputs and outputs. If tests are involved, say "run <test
command> and expect <N> passed; the new test <name> fails before the change and passes
after."

## Idempotence and Recovery

If steps can be repeated safely, say so. If a step is risky, provide a safe retry or
rollback path. Keep the environment clean after completion.

## Artifacts and Notes

Include the most important transcripts, diffs, or snippets as indented examples. Keep
them concise and focused on what proves success.

## Interfaces and Dependencies

Be prescriptive. Name the libraries, modules, and services to use and why. Specify the
types, traits/interfaces, and function signatures that must exist at the end of the
milestone. Prefer stable names and paths. E.g.:

In src/planner.ts, define:

    export interface Planner {
      plan(observed: Observed): Action[];
    }
```

---

## Mode 2: Implementing an ExecPlan

When implementing an existing plan, follow these rules:

1. **Read the full plan first.** Before writing any code, read the entire ExecPlan from top to bottom. Understand the purpose, the milestones, the concrete steps, and the acceptance criteria.

2. **Proceed autonomously.** Do not prompt the user for "next steps"; simply proceed to the next milestone. Resolve ambiguities on your own and record your reasoning in the Decision Log.

3. **Keep the plan up to date.** At every stopping point, update the Progress section to affirmatively state what was accomplished and what comes next. Add or split entries as needed. If you discover something unexpected, record it in Surprises & Discoveries. If you make a design choice, record it in the Decision Log.

4. **Commit frequently.** Each logical unit of change should be its own commit. Follow the commit points called out in the plan. The system must be in a working state (tests pass) at every commit. Small, focused commits make rebasing and conflict resolution easier.

5. **Validate as you go.** After each milestone, run the validation steps described in the plan. Do not move to the next milestone until the current one passes its acceptance criteria.

6. **Maintain self-containment.** Every revision to the plan must remain fully self-contained. It should always be possible to restart from _only_ the ExecPlan and no other context.

7. **Write the retrospective.** At completion of a major task or the full plan, write an Outcomes & Retrospective entry summarizing what was achieved, what remains, and lessons learned.

---

## Mode 3: Discussing an ExecPlan

When discussing or refining an existing plan without implementing it:

1. **Record all decisions.** Every change to the plan and the thinking behind it must be captured in the Decision Log. It should be unambiguously clear why any change was made.

2. **Maintain the living document.** ExecPlans are living documents, and it should always be possible to restart from _only_ the plan and no other context.

3. **When you revise a plan**, ensure your changes are comprehensively reflected across all sections — including the living document sections — and write a note at the bottom of the plan describing the change and the reason why. ExecPlans must describe not just the _what_ but the _why_ for almost everything.

---

## Handling Ambiguity

If the source material is ambiguous or incomplete:

- Write the plan with your best interpretation.
- Mark the ambiguity with a `[CLARIFY]` tag and a note explaining what needs stakeholder input.
- Offer alternatives where the interpretation could go either way.

## The Bar

If you follow the guidance above, a single, stateless agent — or a human novice — can read the ExecPlan from top to bottom and produce a working, observable result. That is the bar: **self-contained, self-sufficient, novice-guiding, outcome-focused.**
