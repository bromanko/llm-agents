---
name: elm-test-review
description: This skill should be used when the user asks for "test review", "test coverage", "improve Elm tests", "review tests", "test quality", "testing audit", or wants analysis of Elm test suites for coverage gaps, edge cases, and testing best practices.
---

# Elm Test Review

**Action required:** Run `/review elm test` to start an interactive test review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Elm test code for coverage gaps, edge case handling, test quality, and testing best practices.

## Scope Determination

First, determine what to review:

1. **If the user specifies test files**: Review those paths
2. **If the user specifies source files**: Find corresponding tests and review coverage
3. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed files
   - Look at both changed source and test files

Test files are typically in `tests/` directory, mirroring the `src/` structure.

## Review Process

1. **Map source to tests**: Identify which source modules have test coverage
2. **Analyze test coverage**: Check if key functionality is tested
3. **Review test quality** using checklist below
4. **Identify missing edge cases**
5. **Output findings** in the standard format

## Test Review Checklist

### Coverage Gaps
- Public/exposed functions have corresponding tests
- `update` function branches tested for each `Msg` variant
- `view` output tested for key elements (`Test.Html`)
- JSON decoders tested with valid and invalid input
- Edge cases covered:
  - Empty collections (`[]`, `Dict.empty`)
  - Zero/negative numbers where applicable
  - Empty strings
  - Boundary conditions
  - `Nothing` cases for Maybe types
  - `Err` cases for Result types
- All custom type variants exercised in tests
- URL routing / parser tested for all routes

### Test Quality
- Tests are focused (one concept per test)
- Test names describe behavior, not implementation (`"displays error when email invalid"` not `"test email function"`)
- Assertions are specific (not just "returns Ok")
- Tests are deterministic (no randomness without seeding)
- `describe` blocks group related tests logically
- Tests run independently (no order dependencies)

### Skipped & Disabled Tests
- Flag any use of `Test.skip` or `skip` to disable tests — especially if recently added
- Look for tests with `Expect.pass` replacing what should be a real assertion (a sign the test was gutted to pass)
- Check for commented-out tests or test bodies that have been emptied
- Watch for `TODO`/`FIXME` comments suggesting the test was too hard to fix and was bypassed instead
- These patterns are **HIGH severity** when they appear to be workarounds (e.g., an LLM disabling a test it couldn't fix rather than addressing the underlying failure)

### Test Organization
- Test file structure mirrors source structure
- Related tests grouped with `describe`
- Helper functions extracted for common setup / test data
- Test data defined clearly and close to where it's used
- No duplicate test logic across test files
- Shared test utilities in a common test helper module

### Assertion Patterns
- `Expect.equal` for exact matches (expected value first)
- `Expect.true` / `Expect.false` for boolean checks with descriptive messages
- `Expect.err` for expected failures
- `Expect.all` for multiple assertions on the same value
- `Expect.within` for floating-point comparisons
- Avoid `Expect.pass` — prefer specific assertions

### View Testing (Test.Html)
- Key UI elements present (`Query.find`, `Query.findAll`)
- Event handlers fire correct messages (`Event.simulate`)
- Conditional rendering tested (elements shown/hidden based on Model)
- Attributes and text content verified
- List rendering tested with various item counts
- Accessibility attributes verified where applicable

### Edge Case Coverage
For each function, consider:
- What happens with empty input?
- What happens at boundaries (0, very large numbers)?
- What happens with invalid input?
- What happens with very large input?
- Are all custom type variants exercised?
- Are all `Maybe`/`Result` paths tested?
- What happens with Unicode / special characters in strings?

### Fuzz Testing
Identify functions that would benefit from fuzz tests:
- Pure functions with clear invariants
- JSON encode/decode roundtrips
- Mathematical operations (commutativity, associativity)
- String operations (length preservation, etc.)
- Idempotent operations (`f(f(x)) == f(x)`)
- Parsers (valid input always parses)

Suggest using `Fuzz` module from `elm-explorations/test`:
- `Fuzz.string`, `Fuzz.int`, `Fuzz.float` for primitives
- `Fuzz.list`, `Fuzz.pair` for composite types
- Custom fuzzers for domain types

### Test Isolation
- HTTP interactions tested via `elm-program-test` or by testing update/decoder separately
- Time-dependent logic tested with controlled time
- Random values use fixed seeds in tests
- Port interactions tested by verifying outgoing commands and simulating incoming subscriptions
- No reliance on external services in unit tests

### Error Scenario Testing
- Invalid JSON decoded gracefully
- HTTP error responses handled
- Missing/null fields in API responses handled
- Malformed URLs handled in routing
- Edge cases in user input (paste, special characters)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `tests/ModuleTest.elm:LINE` (or source file if missing tests)
**Category:** testing

**Issue:** Description of the testing gap or quality issue.

**Suggestion:** What to test or how to improve, with example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Critical untested paths, missing error handling tests, untested update branches
- MEDIUM: Missing edge cases, unclear test intent
- LOW: Test organization, minor improvements

## Summary

After all findings, provide:
- Total count by severity
- Coverage summary (modules with/without tests)
- Top testing priorities
- Fuzz testing candidates
- Overall test suite assessment (1-2 sentences)
