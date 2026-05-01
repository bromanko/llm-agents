---
name: rust-test-review
description: This skill should be used when the user asks for "test review", "test coverage", "improve Rust tests", "review tests", "test quality", "testing audit", or wants analysis of Rust test suites for coverage gaps, edge cases, property tests, fuzzing, and idiomatic cargo test practices.
---

# Rust Test Review

**Action required:** Run `/review rust test` to start an interactive test review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Rust test code for coverage gaps, edge case handling, test quality, and idiomatic Rust testing practices.

## Scope Determination

First, determine what to review:

1. **If the user specifies test files**: Review those paths
2. **If the user specifies source files**: Find corresponding tests and review coverage
3. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed files
   - Look at both changed source and test files

Rust tests may be inline `#[cfg(test)] mod tests`, integration tests under `tests/`, doc tests in documentation examples, benches under `benches/`, and fuzz targets under `fuzz/`.

## Review Process

1. **Map source to tests**: Identify public APIs, critical internal logic, and changed behavior lacking meaningful coverage
2. **Analyze scenario coverage**: happy path, failure path, boundary conditions, concurrency/cancellation, serialization/parsing, security-sensitive behavior
3. **Review test quality** using the checklist below
4. **Output findings** in the standard format

## Test Review Checklist

### Coverage Gaps
- Public APIs and critical business logic are tested
- Error paths are covered, including `Result` variants and contextual error behavior
- Boundary and edge cases are covered (empty inputs, zero values, max/min values, invalid UTF-8 where relevant, large inputs, malformed data)
- Authorization/security-sensitive logic has explicit tests
- Parsers/serializers/deserializers cover malformed and adversarial inputs
- Async/concurrency-sensitive code has cancellation, shutdown, timeout, and ordering tests
- Feature-flagged behavior is tested for important feature combinations

### Test Quality
- Tests verify behavior and invariants, not private implementation details
- Test names describe intent clearly; subtests/patterns make failures easy to diagnose
- Assertions are specific and meaningful (`assert_eq!`, `matches!`, `assert!(err.to_string().contains(...))` only when appropriate)
- Tests are deterministic and avoid timing/scheduler flakiness
- Setup and teardown are isolated (`tempfile`, `assert_fs`, test fixtures, RAII cleanup)
- No hidden inter-test dependencies or shared mutable global state
- Helpers keep test code readable without hiding the behavior under test
- Golden/snapshot tests have clear update workflow and avoid masking semantic regressions

### Skipped, Disabled & Hollow Tests
- Flag any use of `#[ignore]`, early `return`, disabled modules, or feature-gated tests that are not run in CI
- Look for tests with trivially passing assertions, empty bodies, or assertions that only check construction succeeds when behavior matters
- Check for commented-out tests or TODO/FIXME comments suggesting the test was bypassed
- These patterns are **HIGH severity** when they appear to be workarounds (e.g., an LLM disabling a test it couldn't fix rather than addressing the underlying failure)

### Unit, Integration & Doc Tests
- Inline unit tests cover module-level invariants and edge cases
- Integration tests under `tests/` cover public API behavior as consumers use it
- Doc examples compile and demonstrate important API usage
- CLI/binary behavior is tested with appropriate harnesses (`assert_cmd`, `predicates`, temp dirs)
- Filesystem/network/database boundaries use realistic fakes or test servers where appropriate

### Error & Panic Testing
- Expected error variants are asserted precisely (`matches!`, `thiserror` variants, domain error enums)
- Panic tests (`#[should_panic]`) are used sparingly and assert panic messages when valuable
- Tests cover invalid input without relying on panics for normal error handling
- `unwrap()` in tests is acceptable for setup, but failures should still produce actionable diagnostics (`expect` messages when helpful)

### Async & Concurrency Testing
- Async tests use the project's runtime conventions (`#[tokio::test]`, `async-std`, etc.) consistently
- Time-dependent tests use paused/fake time when possible (`tokio::time::pause`, test clocks)
- Tasks are awaited or explicitly cancelled; tests do not leak background tasks
- Channel and lock behavior is tested for close, cancellation, and backpressure semantics
- Race-prone code is exercised with concurrent scenarios where practical

### Property, Fuzz & Benchmark Opportunities
Identify logic that would benefit from broader input exploration:
- **Property tests** (`proptest`, `quickcheck`): parsers, validators, roundtrips, ordering, idempotence, invariants
- **Fuzz tests** (`cargo-fuzz`, `afl`): parsers, decoders, unsafe/FFI boundaries, protocol handling
- **Benchmarks** (`criterion`, `cargo bench`): hot paths, serialization, allocation-heavy code
- Roundtrip tests for serialization/deserialization and domain conversions

### Cargo/CI Integration
- `cargo test --all-targets --all-features` or an intentional feature matrix runs in CI
- `cargo clippy` / `cargo fmt --check` expectations are clear
- Slow or external integration tests are gated predictably and documented
- Coverage tooling (`cargo llvm-cov`, tarpaulin, or equivalent) is considered for critical crates
- Doctests are not accidentally disabled for public APIs

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.rs:LINE` (or source file if missing tests)
**Category:** testing

**Issue:** Description of the testing gap or quality issue.

**Suggestion:** What to test or how to improve, with example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Critical untested paths, missing failure/security tests, disabled/hollow tests, concurrency/cancellation risks uncovered
- MEDIUM: Important edge cases missing, weak assertions, incomplete integration/property coverage
- LOW: Organization improvements, additional doctests/benchmarks, incremental quality improvements

## Summary

After all findings, provide:
- Total count by severity
- Coverage summary (areas with/without adequate tests)
- Top testing priorities
- Overall test suite assessment (1-2 sentences)
