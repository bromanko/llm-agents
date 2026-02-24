---
name: exec-plan-review
description: >
  Review execution plans (ExecPlans) for completeness, clarity, and implementability.
  Use this skill when the user asks to "review a plan", "review this exec plan",
  "critique this plan", "is this plan good enough", "check this plan", "audit this
  plan", "review my PLAN.md", or wants feedback on whether an execution plan is
  ready for a developer or coding agent to implement. Also trigger when the user
  mentions "plan review", "plan quality", or asks if a plan is "implementable" or
  "self-contained enough".
---

# ExecPlan Review

Review an execution plan for completeness, clarity, and implementability. The goal is to determine whether a skilled developer — who has zero context about the codebase, toolchain, or problem domain — can pick up the plan and deliver working software without asking questions.

Read the exec-plan skill at `../exec-plan/SKILL.md` to understand the full authoring standard — particularly the "Who This Plan Is For" section, which defines the developer profile. This review skill evaluates plans against that standard plus the additional criteria below.


## Review Process

1. **Read the entire plan** from top to bottom before writing any feedback.
2. **Read the exec-plan skill** at `../exec-plan/SKILL.md` to refresh the authoring standard.
3. **Evaluate against each checklist section** below.
4. **Output findings** in the format specified at the end of this document.


## Review Checklist

### Self-Containment

The plan must be a standalone document. A developer with only the plan and the working tree must be able to succeed.

- Every term of art is defined in plain language where it first appears. No jargon is assumed understood.
- No references to "the architecture doc", "the wiki", "the prior plan", external blog posts, or anything outside the plan and the repository. If knowledge is required, it is embedded in the plan.
- The repository layout relevant to this work is described explicitly: which directories matter, what lives where, how the pieces connect.
- Build, test, and run commands are stated in full — the working directory, the exact command, and the expected output. Not "run the tests" but "from the repo root, run `npm test` and expect all 47 tests to pass."
- Environment assumptions (OS, language version, installed tools, environment variables) are stated or can be inferred from the repo.

### Task Granularity

Each step in the plan should be a single, unambiguous action that takes roughly 2–5 minutes. The developer should never wonder "what do I do next?" or "am I done with this step?"

- Steps follow the TDD cycle where applicable:
  1. Write the failing test — one step.
  2. Run the test to confirm it fails — one step.
  3. Write the minimal code to make the test pass — one step.
  4. Run the tests to confirm they pass — one step.
  5. Commit — one step.
- Each step names the exact file(s) to touch, with full repository-relative paths.
- Each step describes what to add, change, or remove — not vaguely ("update the handler") but concretely ("in `src/handlers/auth.ts`, add a new function `validateToken` that takes a `string` and returns a `Result<Claims, AuthError>`").
- Steps that produce output (running tests, starting a server, making a request) include the expected output so the developer can tell success from failure.
- No step requires the developer to make a design decision. If a decision is needed, the plan makes it and explains why.
- No step bundles multiple unrelated changes. "Add the type and write the test and update the config" is three steps, not one.

### Testing Guidance

Assume the developer will not invent good tests on their own. The plan must specify exactly what to test and how.

- Every new behavior has at least one test specified in the plan — not "write tests for this" but "write a test that calls `parse("")` and asserts it returns `Err(EmptyInput)`."
- Edge cases are called out explicitly. The developer should not have to think about what the edge cases are.
- Test file locations are named with full paths.
- The test runner command is stated, including how to run a single test or a subset.
- Expected test output (pass/fail counts, specific assertion messages) is described so the developer knows what "working" looks like.
- When a test should fail before implementation (red phase of TDD), the plan says so and describes what the failure looks like.
- Integration or end-to-end validation steps are included where appropriate — not just unit tests.

### Design Principles

The plan should guide the developer toward clean, maintainable code.

- **DRY**: The plan does not instruct the developer to duplicate logic. If two steps touch similar code, the plan explains where to extract the common part.
- **YAGNI**: The plan does not introduce abstractions, interfaces, or features that are not required by the current work. No "we might need this later."
- **Minimal scope**: Each milestone delivers the smallest useful increment. No milestone tries to do everything at once.
- **Additive changes**: Where possible, steps add new code before modifying or removing old code, keeping the system working at every commit point.

### Commit Discipline

The plan should produce a clean, readable commit history.

- Commit points are called out explicitly. The developer should never wonder when to commit.
- Each commit represents a logical, self-contained unit of progress — a passing test, a completed refactor step, a new function with its tests.
- Commit messages are suggested or the plan describes what the commit should contain clearly enough to write one.
- The system should be in a working state (tests pass) at every commit point. No "commit the broken intermediate state."

### Milestones and Validation

- Each milestone has a clear, observable outcome — not "the auth module is done" but "running `curl -X POST localhost:8080/login -d '{"user":"test","pass":"test"}'` returns a 200 with a JSON body containing a `token` field."
- Milestones are independently verifiable. You can confirm a milestone is complete without reference to future milestones.
- Milestones build incrementally. Each milestone works on its own, and later milestones extend — not replace — earlier ones.
- Validation steps are concrete: the exact command, the expected output, and what to do if it does not match.

### Living Document Sections

The exec-plan standard requires four mandatory sections. Check that all are present and properly structured:

- **Progress** — A checklist of granular steps with timestamps. Must reflect actual state.
- **Surprises & Discoveries** — Space to record unexpected findings during implementation.
- **Decision Log** — Space to record design decisions with rationale and dates.
- **Outcomes & Retrospective** — Space to capture lessons learned at milestones and completion.

### Files, Paths, and Code References

- Every file mentioned uses a full repository-relative path (e.g., `src/auth/handler.ts`, not "the handler file" or "handler.ts").
- New files state where they should be created.
- When referencing existing code, the plan names the function, type, or module — not "the function that does X" but "`validateToken` in `src/auth/token.ts`."
- When code must be written, the plan includes enough detail (signatures, types, behavior) that the developer does not need to invent the API. Pseudocode or actual code snippets are included where helpful.
- Dependencies (libraries, packages) are named with versions where it matters.

### Clarity and Readability

- The plan reads as a narrative, not a wall of bullet points. Prose explains the why; steps explain the what.
- The purpose section makes clear what the user gains — not what the code does, but what someone can do after the change that they could not do before.
- Sections flow logically. The reader does not need to jump around to understand the work.
- Ambiguities are resolved in the plan, not left for the developer. Where genuine ambiguity remains, it is marked with `[CLARIFY]` and alternatives are offered.


## Output Format

Present findings grouped by checklist section. Use severity levels to prioritize:

- **BLOCKING**: The plan cannot be implemented as written. A developer would get stuck, make a wrong decision, or produce broken software. The plan must be revised before implementation.
- **GAP**: Something important is missing or underspecified. A skilled developer might figure it out, but a novice or agent would struggle. Should be addressed.
- **SUGGESTION**: An improvement that would make the plan clearer, more robust, or easier to follow. Nice to have.

```markdown
## Plan Review: <plan title or filename>

### Summary

<2-3 sentence overall assessment: Is this plan ready for implementation? What are the biggest risks?>

### Self-Containment

<findings or "No issues found.">

### Task Granularity

<findings or "No issues found.">

### Testing Guidance

<findings or "No issues found.">

### Design Principles

<findings or "No issues found.">

### Commit Discipline

<findings or "No issues found.">

### Milestones and Validation

<findings or "No issues found.">

### Living Document Sections

<findings or "No issues found.">

### Files, Paths, and Code References

<findings or "No issues found.">

### Clarity and Readability

<findings or "No issues found.">

### Verdict

**READY** | **REVISE** | **REWRITE**

- **READY**: The plan can be handed to a developer or agent as-is.
- **REVISE**: The plan has gaps but the structure is sound. Address the BLOCKING and GAP items.
- **REWRITE**: The plan has fundamental problems — missing sections, wrong level of detail, or assumptions that make it unusable. Start over with the exec-plan skill.

### Priority Fixes

<Numbered list of the top 3-5 changes that would most improve the plan, starting with BLOCKING items.>
```

Within each section, format individual findings as:

```markdown
**[SEVERITY] Finding title**
<Description of the issue — what's missing, what's wrong, why it matters.>
<Concrete suggestion for how to fix it, with examples where helpful.>
```


## Handling Edge Cases

- **Plan is not an ExecPlan**: If the document does not follow the ExecPlan format at all (no milestones, no progress section, no concrete steps), note this upfront and evaluate it against the spirit of the standard. Recommend converting to ExecPlan format.
- **Plan is partially implemented**: Review the remaining work. Check that the Progress section accurately reflects what is done and what remains. Verify that completed milestones still make sense in context.
- **Plan references prior plans**: Flag this as a self-containment issue. The relevant context from prior plans must be incorporated.
- **Plan is very short**: Short is fine if the task is small. But even a small task needs file paths, test commands, expected outputs, and commit points. Brevity is not an excuse for vagueness.
