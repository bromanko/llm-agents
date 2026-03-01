---
name: fsharp-test-review
description: This skill should be used when the user asks for "test review", "test coverage", "improve F# tests", "review tests", "test quality", "testing audit", or wants analysis of F# test suites for coverage gaps, edge cases, and testing best practices.
---

# F# Test Review

**Action required:** Run `/review fsharp test` to start an interactive test review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze F# test code for coverage gaps, edge case handling, test quality, and testing best practices.

## Scope Determination

First, determine what to review:

1. **If the user specifies test files**: Review those paths
2. **If the user specifies source files**: Find corresponding tests and review coverage
3. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed files
   - Look at both changed source and test files

Test files are typically in a separate test project (e.g., `MyProject.Tests/`) with `Tests.fs` suffix or in files containing `[<Tests>]` / `[<Fact>]` / `[<Test>]` attributes.

## Review Process

1. **Map source to tests**: Identify which source modules have test coverage
2. **Analyze test coverage**: Check if key functionality is tested
3. **Review test quality** using checklist below
4. **Identify missing edge cases**
5. **Output findings** in the standard format

## Test Review Checklist

### Coverage Gaps
- Public functions have corresponding tests
- Error paths tested (`Result.Error` cases, exception handling)
- Edge cases covered:
  - Empty collections (`[]`, `Map.empty`, `Array.empty`)
  - Zero/negative numbers where applicable
  - Empty strings, null strings (for interop boundaries)
  - Boundary conditions
  - `None` cases for Option types
- Integration points tested (module interactions)
- Discriminated union — all cases exercised in tests

### Test Quality
- Tests are focused (one concept per test)
- Test names describe behavior, not implementation
- Assertions are specific (not just "returns Ok")
- Tests are deterministic (no flaky tests)
- Setup/teardown handled appropriately
- Tests run independently (no order dependencies)
- Arrange-Act-Assert pattern followed

### Skipped & Disabled Tests
- Flag any use of skip markers: `[<Fact(Skip="...")>]` (xUnit), `[<Ignore("...")>]` (NUnit), `ptest`/`ptestCase`/`ptestList` (Expecto) — especially if recently added
- Look for tests with trivially passing assertions replacing what should be real checks (a sign the test was gutted to pass)
- Check for commented-out tests or test bodies that have been emptied
- Watch for `TODO`/`FIXME` comments suggesting the test was too hard to fix and was bypassed instead
- These patterns are **HIGH severity** when they appear to be workarounds (e.g., an LLM disabling a test it couldn't fix rather than addressing the underlying failure)

### Test Organization
- Test projects mirror source structure
- Related tests grouped logically (module or `testList` grouping)
- Helper functions extracted for common setup
- Test data defined clearly (test fixtures or inline)
- No duplicate test logic
- `testList` / `testCase` hierarchy clear (Expecto) or class grouping clear (xUnit/NUnit)

### Assertion Patterns (Framework-Specific)

#### Expecto
- `Expect.equal` for exact matches
- `Expect.isTrue` / `Expect.isFalse` for booleans
- `Expect.isOk` / `Expect.isError` for Results
- `Expect.throws` for expected exceptions
- `Expect.containsAll` for collection membership

#### xUnit
- `Assert.Equal` for exact matches
- `Assert.True` / `Assert.False` for booleans
- Custom assertions for domain types
- `Assert.Throws<T>` for expected exceptions

#### FsUnit
- `should equal` for exact matches
- `should be ofCase` for DU case matching
- `should throw typeof<T>` for expected exceptions

### Edge Case Coverage
For each function, consider:
- What happens with empty input?
- What happens at boundaries (0, `Int32.MaxValue`, etc.)?
- What happens with invalid input?
- What happens with very large input?
- Are all discriminated union cases exercised?
- Are computation expression edge cases tested (early return, exceptions)?

### Property-Based Testing (FsCheck)
Identify functions that would benefit from property tests:
- Pure functions with clear invariants
- Serialization/deserialization (roundtrip property)
- Mathematical operations (commutativity, associativity)
- Collection operations (length preservation, etc.)
- Parsers (valid input always parses)
- Custom generators for domain types

Suggest using FsCheck integration with the project's test framework.

### Test Isolation
- External services mocked/stubbed (use interfaces or function parameters)
- File system interactions isolated
- Time-dependent tests use controlled time (`DateTimeOffset` injection)
- Random values seeded for reproducibility
- No shared mutable state between tests
- Database tests use transactions or test containers

### Error Scenario Testing
- Invalid input handled gracefully
- External failures handled (network, file, etc.)
- Concurrent access scenarios (if applicable)
- Resource exhaustion considered
- Timeout behavior tested
- Cancellation token behavior tested for async operations

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/FileTests.fs:LINE` (or source file if missing tests)
**Category:** testing

**Issue:** Description of the testing gap or quality issue.

**Suggestion:** What to test or how to improve, with example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Critical untested paths, missing error handling tests
- MEDIUM: Missing edge cases, unclear test intent
- LOW: Test organization, minor improvements

## Summary

After all findings, provide:
- Total count by severity
- Coverage summary (modules with/without tests)
- Top testing priorities
- Property testing candidates
- Overall test suite assessment (1-2 sentences)
