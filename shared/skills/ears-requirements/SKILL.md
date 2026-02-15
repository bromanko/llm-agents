---
name: ears-requirements
description: >
  Generate EARS (Easy Approach to Requirements Syntax) specifications from plan files,
  design documents, user stories, or existing codebases. Use this skill whenever the user
  wants to write software requirements, create specifications, extract requirements from
  code, convert informal requirements to structured format, prepare requirements for
  verification/testing, or mentions "EARS", "requirements syntax", "shall statements",
  "system requirements", or "specifications". Also trigger when the user asks to make
  requirements testable, reduce ambiguity in specs, or prepare verification criteria
  from a plan or codebase.
---

# EARS Requirements Specification Skill

Generate precise, testable, verification-ready requirements using the Easy Approach to
Requirements Syntax (EARS) — a lightweight notation developed at Rolls-Royce and adopted
by organizations including Airbus, Bosch, Intel, NASA, and Siemens.

## Why EARS matters for verification

Unconstrained natural language requirements suffer from eight common problems: ambiguity,
vagueness, complexity, omission, duplication, wordiness, inappropriate implementation
detail, and untestability. EARS eliminates or reduces all of these by constraining
requirements into patterns with temporal logic. Every EARS requirement maps directly to
one or more verification checks.

## The EARS Patterns

Read `references/patterns.md` for the complete pattern reference with extended examples,
anti-patterns, and verification mapping guidance. What follows is the quick reference.

### Generic syntax

Clauses always appear in this order:

```
While <optional precondition(s)>, when <optional trigger>, the <system name> shall <system response>
```

**Ruleset:** Zero or many preconditions. Zero or one trigger. One system name. One or many
system responses.

### Pattern summary

| Pattern | Keywords | Template | Use when... |
|---|---|---|---|
| Ubiquitous | *(none)* | The \<system\> shall \<response\> | Requirement is always active |
| State-driven | **While** | While \<precondition\>, the \<system\> shall \<response\> | Active during a state |
| Event-driven | **When** | When \<trigger\>, the \<system\> shall \<response\> | Response to a triggering event |
| Optional feature | **Where** | Where \<feature\>, the \<system\> shall \<response\> | Only applies if feature exists |
| Unwanted behavior | **If/Then** | If \<trigger\>, then the \<system\> shall \<response\> | Handling errors/faults/undesired situations |
| Complex | **While + When** (± If/Then) | While \<precondition\>, when \<trigger\>, the \<system\> shall \<response\> | Richer behavior with state + event |

## Workflow

### Step 1: Identify the system under specification

Determine the system name from the input. If working from a codebase, derive it from the
project/module name. If a plan file, extract it from the title or context. Ask the user to
confirm if ambiguous.

### Step 2: Extract behaviors from the source

**From a plan file or design document:**
- Identify stated goals, features, constraints, and acceptance criteria
- Look for implicit behaviors (error handling, edge cases, startup/shutdown)
- Note any conditional logic, state machines, or feature flags

**From an existing codebase:**
- Analyze entry points, public APIs, and exported functions
- Identify error handling paths (try/catch, error returns, fallbacks)
- Extract state machines, mode switches, and conditional branches
- Map configuration flags and optional features
- Examine boundary checks and validation logic
- Look at startup/initialization and shutdown/cleanup sequences

### Step 3: Classify each behavior into an EARS pattern

For each identified behavior, determine the correct EARS pattern:

1. Is it always true regardless of state or events? → **Ubiquitous**
2. Is it active only during a particular state/mode? → **State-driven**
3. Is it triggered by a specific event? → **Event-driven**
4. Does it only apply when an optional feature is present? → **Optional feature**
5. Does it handle an error, fault, or undesired situation? → **Unwanted behavior**
6. Does it combine state context with an event trigger? → **Complex**

### Step 4: Write the EARS requirements

Apply these quality rules when writing each requirement:

- **One requirement per sentence.** Never combine multiple behaviors.
- **Use "shall" for requirements.** Not "should", "will", "may", or "can".
- **Be specific and measurable.** Replace vague terms ("fast", "quickly", "user-friendly")
  with concrete values or observable behaviors.
- **Name the system consistently.** Use the same system name throughout.
- **Avoid implementation detail.** Specify *what*, not *how*.
- **Avoid negation where possible.** Positive statements are clearer and more testable.
- **Avoid universal quantifiers** ("all", "every", "any", "no") unless you genuinely mean
  them. Replace with specific entities when possible.
- **Keep preconditions to 0–3.** If you need more, break into multiple requirements or
  use a decision table.
- **Each requirement must be testable.** If you can't describe a verification check for it,
  rewrite it.

### Step 5: Add verification mapping

For each requirement, include a brief verification approach. This bridges the gap between
specification and test:

- **Test** — Exercise the system and observe the response
- **Inspection** — Examine code, design, or configuration directly
- **Analysis** — Use calculation, simulation, or modeling
- **Demonstration** — Show the system performing the required behavior

### Step 6: Organize and output

Group requirements by:
1. Feature area or module
2. EARS pattern type within each group
3. Assign unique requirement IDs using the format: `[PREFIX]-[NNN]`

## Output format

Produce a markdown document with this structure:

```markdown
# EARS Requirements Specification: <System Name>

**Source:** <description of input — plan file, codebase path, etc.>
**Date:** <date>
**System:** <system name>

## 1. <Feature Area / Module>

### Ubiquitous Requirements

| ID | Requirement | Verification |
|----|-------------|--------------|
| SYS-001 | The <system> shall <response>. | <method>: <brief description> |

### Event-Driven Requirements

| ID | Requirement | Verification |
|----|-------------|--------------|
| SYS-002 | When <trigger>, the <system> shall <response>. | <method>: <brief description> |

### State-Driven Requirements
...

### Unwanted Behavior Requirements
...

## 2. <Next Feature Area>
...

## Traceability Notes

<Any assumptions, open questions, or items needing stakeholder clarification>
```

## Working with codebases

When the input is a codebase rather than a plan file, take extra care:

1. **Don't just describe what the code does.** Requirements specify intended behavior, not
   implementation. Abstract upward from the code to the *purpose*.
2. **Capture implicit requirements.** Code often implements behaviors that were never
   formally specified — error handling, timeouts, retries, resource limits. Surface these
   as explicit EARS requirements.
3. **Flag potential gaps.** If the code lacks error handling, input validation, or edge case
   coverage, note these as "Recommended additions" in the traceability notes.
4. **Separate concerns.** One function may implement multiple requirements. One requirement
   may span multiple functions. Map behaviors, not code structure.

## Handling ambiguity

If the source material is ambiguous or incomplete:

- Write the requirement with your best interpretation
- Add a `[CLARIFY]` tag and a note explaining what needs stakeholder input
- Offer alternatives where the interpretation could go either way

Example:
```
| SYS-015 | When the user submits the form, the system shall save the data within 2 seconds. [CLARIFY: Is 2s the right SLA? Source says "quickly".] | Test: Measure response time under load |
```

## Anti-patterns to avoid

Consult `references/patterns.md` for a detailed anti-pattern catalog. Key ones:

- **Not a requirement:** "The system supports X" — what does "supports" mean? Rewrite as a specific behavior.
- **Implementation masquerading as requirement:** "The system shall use PostgreSQL" — specify the *need* (data persistence, ACID compliance), not the tool.
- **Compound requirement:** "The system shall log the event and notify the user" — split into two requirements.
- **Missing trigger:** "The system shall display an error message" — when? Under what conditions?
- **Vague response:** "The system shall handle the error gracefully" — what specific behavior constitutes "graceful"?
