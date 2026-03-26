---
name: python-test-review
description: This skill should be used when the user asks for "test review", "test coverage", "improve Python tests", "review tests", "test quality", "testing audit", or wants analysis of Python test suites for coverage gaps, edge cases, and testing best practices.
---

# Python Test Review

**Action required:** Run `/review python test` to start an interactive test review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Python test code for coverage gaps, edge case handling, test quality, and framework-appropriate testing practices.

## Scope Determination

First, determine what to review:

1. **If the user specifies test files**: Review those paths
2. **If the user specifies source files**: Find corresponding tests and review coverage
3. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed files
   - Look at both changed source and test files

Test files are commonly `test_*.py`, `*_test.py`, or under `tests/` directories.

## Review Process

1. **Map source to tests**: Identify modules/features lacking meaningful coverage
2. **Analyze scenario coverage**: happy path, failure path, boundary conditions
3. **Review test quality** using checklist below
4. **Output findings** in the standard format

## Test Review Checklist

### Coverage Gaps
- Public behavior and critical business logic are tested
- Error and exception paths are covered
- Boundary and edge cases covered (empty, `None`, large inputs, invalid formats)
- Authorization/permission-sensitive logic has explicit tests
- Integration boundaries (DB/API/file/network) have representative tests

### Test Quality
- Tests verify behavior, not private implementation details
- Names describe intent clearly (`test_<behavior>_when_<condition>_expects_<outcome>`)
- Assertions are specific and meaningful
- Tests are deterministic (no timing/race flakiness)
- Setup and teardown are explicit and isolated
- No hidden inter-test dependencies or shared mutable state

### Skipped & Disabled Tests
- Flag any use of `@pytest.mark.skip`, `@unittest.skip`, `pytest.skip()`, or `@pytest.mark.xfail` — especially if recently added
- Look for tests with trivially passing assertions or empty bodies
- Check for commented-out tests or `assert True` placeholder assertions
- Watch for `TODO`/`FIXME` comments suggesting the test was too hard to fix and was bypassed instead
- These patterns are **HIGH severity** when they appear to be workarounds (e.g., an LLM disabling a test it couldn't fix rather than addressing the underlying failure)

### Type & Data Integrity
- Test fixtures use realistic data that matches actual types/schemas
- `# type: ignore` in tests minimized and justified
- Mocks/stubs preserve contract shape to avoid false confidence
- Pydantic models and validators tested with valid and invalid input
- Serialization/deserialization round-trips verified

### Framework Patterns (pytest/unittest)
- Uses pytest fixtures effectively (scoped appropriately, not over-shared)
- Avoids over-mocking that removes behavior under test
- Parametrized tests (`@pytest.mark.parametrize`) used for repetitive scenarios
- Async tests use `@pytest.mark.asyncio` or equivalent and assert rejection paths
- Uses `tmp_path` / `tmp_path_factory` for filesystem tests (not manual `/tmp` paths)
- Monkeypatching environment/config is scoped and restored
- Snapshot/golden file tests are focused and reviewed (not overly broad)

### Edge Cases & Robustness
- Empty collections/strings, `None`, malformed input
- Concurrency/race scenarios where relevant
- Retry/timeout/fallback behavior tested
- Idempotency and duplicate request handling tested where applicable
- Error mapping and user-visible failure responses validated
- Unicode, encoding edge cases, and locale-sensitive behavior tested where relevant

### Property-Based / Fuzz Opportunities
Identify logic that would benefit from generated input testing (e.g., Hypothesis):
- Parsers, validators, normalizers
- Serialization/deserialization roundtrip behavior
- Business invariants over wide input spaces
- Numeric/date/time edge cases

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/test_file.py:LINE` (or source file if missing tests)
**Category:** testing

**Issue:** Description of the testing gap or quality issue.

**Suggestion:** What to test or how to improve, with example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Critical untested paths, missing failure/security tests
- MEDIUM: Important edge cases missing, weak assertions
- LOW: Organization and incremental quality improvements

## Summary

After all findings, provide:
- Total count by severity
- Coverage summary (areas with/without adequate tests)
- Top testing priorities
- Overall test suite assessment (1-2 sentences)
