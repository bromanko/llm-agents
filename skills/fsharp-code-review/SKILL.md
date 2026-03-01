---
name: fsharp-code-review
description: This skill should be used when the user asks to "review F# code", "fsharp code quality", "F# idioms check", "review my F#", "check code quality", or wants feedback on F# code patterns, idioms, Result handling, or module organization.
---

# F# Code Review

**Action required:** Run `/review fsharp code` to start an interactive code quality review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a thorough code quality review of F# code, focusing on idiomatic patterns, proper error handling, and clean architecture.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.fs` and `.fsx` files
   - If no changes, ask the user what to review

## Review Process

1. **Read the target files** using the Read tool
2. **Analyze against the checklist** below
3. **Output findings** in the standard format

## Review Checklist

### Idiomatic Patterns
- Uses pipeline operator (`|>`) for data transformations
- Pattern matching is exhaustive (no catch-all `_` when specific cases should be handled)
- Prefers pattern matching over nested `if/else` chains
- Uses `match` expressions clearly, with guards where appropriate
- Uses computation expressions (`async`, `task`, `result`, custom CEs) idiomatically
- Avoids deeply nested expressions
- Prefers immutable data by default
- Uses `let` bindings over mutable variables unless mutation is clearly justified

### Result/Option Handling
- No silent error swallowing (e.g., `Option.get` or `Result.defaultValue` without good reason)
- Errors propagate with meaningful context
- Uses `Result.bind` / `Result.map` or computation expressions for chaining fallible operations
- `Option` used for optional values, `Result` for operations that can fail with meaningful errors
- Avoids `Option.Value` / `.Value` property access (throws on None)
- `try/with` reserved for truly exceptional situations, not control flow

### Discriminated Unions & Type Design
- Discriminated unions model domain states explicitly (avoid stringly-typed code)
- Single-case DUs used for type safety on primitive wrappers (e.g., `type EmailAddress = EmailAddress of string`)
- Record types preferred over tuples for domain concepts
- Anonymous records used sparingly and only for ephemeral data
- Units of measure used where applicable
- Type abbreviations used meaningfully, not to obscure

### Module Organization
- Public functions form a clear, minimal API
- `[<AutoOpen>]` used sparingly (only for truly ubiquitous utilities)
- Related functionality grouped in same module
- Module names reflect their purpose
- Avoids circular dependencies between files (F# requires ordered compilation)
- File ordering in `.fsproj` reflects dependency order

### Naming Conventions
- Functions use `camelCase`
- Types and modules use `PascalCase`
- Discriminated union cases use `PascalCase`
- Names are descriptive but not overly verbose
- Boolean functions/properties prefixed appropriately (e.g., `isValid`, `hasItems`)
- Parameters use `camelCase`

### Active Patterns
- Used to simplify complex pattern matching
- Partial active patterns return `Option` correctly
- Not overused where simple pattern matching suffices
- Parameterized active patterns used when appropriate

### Code Clarity
- Functions are focused (single responsibility)
- Complex logic has explanatory comments
- No dead code or unused `open` declarations
- Consistent formatting
- Appropriate use of `inline` (only when needed for SRTP or performance)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/File.fs:LINE`
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
