---
name: go-test-review
description: This skill should be used when the user asks for "test review", "test coverage", "improve Go tests", "review tests", "test quality", "testing audit", or wants analysis of Go test suites for coverage gaps, edge cases, and testing best practices.
---

# Go Test Review

**Action required:** Run `/review go test` to start an interactive test review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Go test code for coverage gaps, edge case handling, test quality, and idiomatic testing practices.

## Scope Determination

First, determine what to review:

1. **If the user specifies test files**: Review those paths
2. **If the user specifies source files**: Find corresponding tests and review coverage
3. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed files
   - Look at both changed source and test files

Test files in Go are `*_test.go` in the same package or `_test` package variant.

## Review Process

1. **Map source to tests**: Identify exported functions/methods/types lacking meaningful coverage
2. **Analyze scenario coverage**: happy path, failure path, boundary conditions
3. **Review test quality** using checklist below
4. **Output findings** in the standard format

## Test Review Checklist

### Coverage Gaps
- Exported functions and critical business logic are tested
- Error paths are covered (including wrapped error checks with `errors.Is`/`errors.As`)
- Boundary and edge cases covered (empty slices, nil inputs, zero values, large inputs, invalid formats)
- Authorization/permission-sensitive logic has explicit tests
- Integration boundaries (DB/API/file/network) have representative tests
- Concurrency-sensitive code has race-condition-aware tests

### Test Quality
- Tests verify behavior, not private implementation details
- Uses table-driven tests for multiple input/output scenarios
- Test names describe intent clearly (`Test<Function>_<scenario>` or descriptive subtests)
- Assertions are specific and meaningful (not just `err == nil`)
- Tests are deterministic (no timing flakiness, no reliance on goroutine scheduling)
- Setup and teardown are explicit and isolated (`t.Cleanup`, `defer`)
- No hidden inter-test dependencies or shared mutable state
- Uses `t.Helper()` on test helper functions for clean error reporting
- Uses `t.Parallel()` where safe to improve test suite speed

### Skipped & Disabled Tests
- Flag any use of `t.Skip()`, `t.Skipf()`, or build-tag-excluded tests — especially if recently added
- Look for tests with trivially passing assertions or empty bodies
- Check for commented-out tests or placeholder assertions
- Watch for `TODO`/`FIXME` comments suggesting the test was too hard to fix and was bypassed
- These patterns are **HIGH severity** when they appear to be workarounds (e.g., an LLM disabling a test it couldn't fix rather than addressing the underlying failure)

### Table-Driven Tests
- Uses subtests (`t.Run`) with descriptive names for each case
- Test cases cover positive, negative, and edge scenarios
- Test table struct fields are clear and well-named
- Shared setup/assertions not duplicated across cases
- Error cases specify expected error (sentinel or message substring), not just `err != nil`

### Mocking & Test Doubles
- Uses interfaces for dependency injection (not patching globals)
- Mocks/fakes preserve the contract of the interface they implement
- Avoids over-mocking that removes behavior under test
- Test doubles are minimal — only implement methods needed for the test
- Uses `httptest.Server` for HTTP integration tests
- Uses `httptest.ResponseRecorder` for handler unit tests

### Framework Patterns (stdlib testing / testify / gomock)
- Prefers stdlib `testing` patterns where sufficient
- If using testify: `assert` vs `require` used intentionally (require for fatal preconditions)
- If using gomock: expectations are specific, not overly permissive (`AnyTimes()` overuse)
- Uses `testing.Short()` to gate slow integration tests
- Uses `testdata/` directory for golden files and test fixtures
- Uses `t.TempDir()` for filesystem tests (not manual temp paths)
- `TestMain` used only when genuinely needed for setup/teardown

### Concurrency Testing
- Race-sensitive code tested with `-race` flag in CI
- Uses `t.Parallel()` to surface hidden shared-state issues
- Tests goroutine shutdown and cancellation behavior
- Channel-based code tested for deadlocks and proper close semantics
- Uses `sync.WaitGroup` or similar to avoid test goroutine leaks

### Edge Cases & Robustness
- Nil/zero-value inputs handled (nil slices, nil maps, nil interfaces, zero structs)
- Empty strings, empty collections
- Context cancellation and timeout behavior tested
- Retry/backoff/fallback behavior tested where applicable
- Error wrapping chain verified (`errors.Is`, `errors.As`)
- Large input / stress scenarios where relevant

### Benchmark & Fuzz Opportunities
Identify logic that would benefit from benchmarks or fuzz testing:
- **Benchmarks** (`func Benchmark...`): Hot-path functions, serialization, allocation-heavy code
- **Fuzz tests** (`func Fuzz...`): Parsers, validators, deserializers, encoders
- Serialization/deserialization roundtrip correctness
- Business invariants over wide input spaces

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file_test.go:LINE` (or source file if missing tests)
**Category:** testing

**Issue:** Description of the testing gap or quality issue.

**Suggestion:** What to test or how to improve, with example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Critical untested paths, missing failure/security tests, race conditions uncovered
- MEDIUM: Important edge cases missing, weak assertions, missing table-driven structure
- LOW: Organization and incremental quality improvements

## Summary

After all findings, provide:
- Total count by severity
- Coverage summary (areas with/without adequate tests)
- Top testing priorities
- Overall test suite assessment (1-2 sentences)
