---
name: go-code-review
description: This skill should be used when the user asks to "review Go code", "Go code quality", "Go idioms check", "review my Go", "golang code review", "check code quality", or wants feedback on Go patterns, error handling, interface design, and package organization.
---

# Go Code Review

**Action required:** Run `/review go code` to start an interactive code quality review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a thorough code quality review of Go code, focusing on idiomatic patterns, error handling, interface design, concurrency correctness, and clear package structure.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.go` files
   - If no changes, ask the user what to review

## Review Process

1. **Read the target files** using the Read tool
2. **Analyze against the checklist** below
3. **Output findings** in the standard format

## Review Checklist

### Error Handling
- Errors are checked immediately after every fallible call — no ignored returns
- Errors are wrapped with context using `fmt.Errorf("...: %w", err)` or equivalent
- Error messages start lowercase and don't end with punctuation (Go convention)
- Sentinel errors use `errors.New` at package level and are compared with `errors.Is`
- Custom error types implement `error` and are checked with `errors.As`
- No bare `log.Fatal` / `os.Exit` deep in library code (only appropriate in `main`)
- Functions return `error` rather than panicking for recoverable failures
- `panic` used only for truly unrecoverable programmer errors or impossible states

### Idiomatic Go Patterns
- Uses short variable declarations (`:=`) where appropriate
- Prefers returning early over deep nesting (guard clauses)
- Uses `switch` (including type switches) over long `if/else` chains
- Zero values are meaningful and used intentionally
- Avoids `init()` functions unless truly necessary
- Uses `defer` for cleanup, with awareness of loop/closure gotchas
- Avoids named return values unless they genuinely aid readability or documentation
- Uses `ok` idiom for map lookups and type assertions
- Struct literals use field names (not positional)

### Interface Design
- Interfaces are small and focused (1-3 methods preferred)
- Interfaces defined where they are consumed, not where they are implemented
- Accepts interfaces, returns concrete types
- Avoids premature abstraction — interfaces introduced when there are real consumers
- Uses standard library interfaces (`io.Reader`, `io.Writer`, `fmt.Stringer`, `error`, `sort.Interface`) where applicable
- No "God interfaces" that bundle unrelated behavior

### Package Organization
- Package names are short, lowercase, singular nouns (no `util`, `common`, `misc`)
- Package boundaries reflect domain concepts, not implementation layers
- Exported identifiers are minimal and intentional
- Internal packages (`internal/`) used to restrict visibility where appropriate
- Avoids circular dependencies between packages
- `doc.go` or package-level comments present for non-trivial packages
- Test helpers are in `_test.go` files or a `testutil` / `internal/testutil` package

### Concurrency
- Goroutines have clear ownership and shutdown paths
- Channels have clear ownership (who closes, who reads, who writes)
- Uses `context.Context` for cancellation and timeouts
- No goroutine leaks — goroutines terminate when work is done or context cancelled
- Protects shared state with `sync.Mutex` or uses channels for communication
- Uses `sync.WaitGroup`, `errgroup.Group`, or structured concurrency to wait for goroutines
- No races between goroutine launch and resource cleanup
- Uses `sync.Once` for one-time initialization
- Avoids mixing mutexes and channels for the same shared state

### Readability & Maintainability
- Functions are focused (single responsibility)
- Complex logic has concise explanatory comments
- Naming follows Go conventions (MixedCaps, not underscores; short receiver names)
- No dead code, stale TODOs, or unused variables/imports
- Consistent formatting (`gofmt`/`goimports` applied)
- Godoc comments on exported identifiers follow conventions (start with the name)
- Struct fields ordered logically (grouped by purpose, hot fields together for cache friendliness)

### Resource Management
- File handles, database connections, HTTP response bodies are closed properly
- `defer resp.Body.Close()` pattern used after checking `err` (not before)
- HTTP clients have timeouts configured (no `http.DefaultClient` in production)
- Database connections use connection pooling and `context.Context`
- Temporary resources cleaned up on all exit paths (including error returns)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.go:LINE`
**Category:** quality

**Issue:** Description of what's wrong and why it matters.

**Suggestion:** How to fix, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Bugs, goroutine leaks, ignored errors, data races, resource leaks
- MEDIUM: Non-idiomatic patterns, weak error context, interface bloat
- LOW: Style issues, minor cleanup, optional improvements

## Summary

After all findings, provide:
- Total count by severity
- Top 2-3 priority items to address
- Overall code quality assessment (1-2 sentences)
