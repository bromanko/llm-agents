---
name: elm-code-review
description: This skill should be used when the user asks to "review Elm code", "Elm code quality", "Elm idioms check", "review my Elm", "check code quality", or wants feedback on Elm code patterns, idioms, Msg/Model design, or module organization.
---

# Elm Code Review

**Action required:** Run `/review elm code` to start an interactive code quality review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a thorough code quality review of Elm code, focusing on idiomatic patterns, The Elm Architecture, and clean module design.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.elm` files
   - If no changes, ask the user what to review

## Review Process

1. **Read the target files** using the Read tool
2. **Analyze against the checklist** below
3. **Output findings** in the standard format

## Review Checklist

### The Elm Architecture (TEA)
- `Model` represents the full application/component state clearly
- `Msg` type captures all possible user and system events
- `Msg` variants are specific (not catch-all like `NoOp` overuse)
- `update` function handles all `Msg` cases meaningfully
- `view` is a pure function of `Model`
- No business logic in `view` — only presentation
- `Cmd` and `Sub` used correctly for side effects
- `init` sets up reasonable default state

### Type Design
- Custom types model domain states explicitly (avoid stringly-typed code)
- Opaque types used to hide implementation details in exposed modules
- Type aliases used for records to improve readability
- Impossible states made impossible through type design
- Phantom types or extensible records used where appropriate
- Avoid overly generic types when specific types would be clearer

### Pattern Matching
- `case` expressions are exhaustive (compiler enforces this, but watch for lazy `_ ->` catch-alls)
- Pattern matching preferred over nested `if/then/else`
- Destructuring used effectively in function arguments and `let` bindings
- Complex patterns broken into helper functions for readability

### Pipeline & Composition
- Pipeline operator (`|>`) used for data transformations
- Function composition (`>>`) used where it aids clarity
- Pipelines read top-to-bottom as a clear sequence of operations
- Avoid excessively long pipelines (break into named intermediate values)

### Maybe/Result Handling
- No `Maybe.withDefault` that silently discards important `Nothing` cases
- `Result` used for operations that can fail with meaningful errors
- `Maybe.map` / `Result.map` chains used instead of nested `case` expressions
- `Maybe.andThen` / `Result.andThen` for chaining fallible operations
- Avoid `Maybe` when a custom type with explicit states would be clearer

### Module Organization
- Exposed functions form a clear, minimal API (`exposing` list is intentional)
- Related functionality grouped in same module
- Module names reflect their purpose
- `exposing (..)` avoided in imports (prefer explicit imports)
- Module boundaries align with domain concepts
- No circular dependencies

### Naming Conventions
- Functions use `camelCase`
- Types use `PascalCase`
- Module names use `PascalCase` with dot separators
- Names are descriptive but not overly verbose
- Boolean functions prefixed appropriately (e.g., `isValid`, `hasItems`)
- `Msg` variants use verb form (e.g., `ClickedButton`, `ReceivedResponse`)

### JSON Decoders/Encoders
- Decoders validate data at the boundary
- Decoder pipelines are clear and readable
- Error messages in decoders are helpful
- Encoders match expected API format
- Optional fields handled explicitly (`Decode.maybe` vs `Decode.field`)

### Code Clarity
- Functions are focused (single responsibility)
- Complex logic has explanatory comments
- No dead code or unused imports
- Consistent formatting (elm-format applied)
- `let` bindings used to name intermediate values for clarity

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/Module.elm:LINE`
**Category:** quality

**Issue:** Description of what's wrong and why it matters.

**Suggestion:** How to fix, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Bugs, incorrect behavior, serious maintainability issues
- MEDIUM: Non-idiomatic code, unclear patterns, missing error handling
- LOW: Style issues, minor improvements, optional enhancements

## Summary

After all findings, provide:
- Total count by severity
- Top 2-3 priority items to address
- Overall code quality assessment (1-2 sentences)
