---
name: python-code-review
description: This skill should be used when the user asks to "review Python code", "Python code quality", "Python idioms check", "review my Python", "check code quality", or wants feedback on Python patterns, typing strategy, and module organization.
---

# Python Code Review

**Action required:** Run `/review python code` to start an interactive code quality review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a thorough code quality review of Python code, focusing on type safety, idiomatic patterns, maintainability, and clear architecture.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.py` and `.pyi` files
   - If no changes, ask the user what to review

## Review Process

1. **Read the target files** using the Read tool
2. **Analyze against the checklist** below
3. **Output findings** in the standard format

## Review Checklist

### Type Safety & API Design
- Uses type annotations on public functions, methods, and module-level variables
- Avoids `Any` unless explicitly justified
- Uses `typing` / `collections.abc` types appropriately (`Sequence`, `Mapping`, `Iterable`, etc.)
- Function signatures are explicit and stable
- Public APIs use strong domain types instead of primitive-heavy signatures (e.g., `UserId` vs `str`)
- Optional fields and `None` returns handled intentionally
- Generic types use `TypeVar` / `ParamSpec` / `Generic` with meaningful constraints
- Uses `Protocol` for structural subtyping where appropriate

### Idiomatic Python Patterns
- Uses list/dict/set comprehensions over manual loops where clearer
- Prefers `pathlib.Path` over `os.path` string manipulation
- Uses context managers (`with`) for resource management
- Prefers `enum.Enum` / `StrEnum` for fixed value sets
- Uses `dataclasses` or `attrs` / Pydantic models instead of raw dicts for structured data
- Avoids mutable default arguments (`def f(x=[])`)
- Uses `itertools`, `functools`, and standard library utilities where appropriate
- Uses f-strings over `%` formatting or `.format()` for simple interpolation
- Prefers `isinstance()` checks with union types over chains of `or`
- Uses unpacking, `*args`, `**kwargs` appropriately

### Module Organization
- Public exports are intentional (uses `__all__` or clear naming conventions)
- Internal helpers use `_` prefix convention
- File/module names reflect responsibilities
- Avoids circular imports
- Package `__init__.py` re-exports are minimal and intentional
- Separates concerns: business logic, I/O, configuration, and data definitions

### Readability & Maintainability
- Functions/classes are focused (single responsibility)
- Complex logic has concise explanatory comments or docstrings
- Naming is descriptive without excessive verbosity
- No dead code, stale TODOs, or unused imports
- Consistent formatting expectations followed (PEP 8, Black/Ruff style)
- Docstrings on public functions/classes follow a consistent convention (Google, NumPy, or Sphinx style)

### Error Handling
- Errors include actionable context (not bare `raise` or generic `Exception`)
- Avoids bare `except:` or overly broad `except Exception`
- No silent failures (empty `except` blocks, swallowed errors)
- Uses custom exception classes for domain-specific errors
- Validates input at system boundaries (CLI args, env vars, file I/O, network)
- Uses `try`/`except`/`else`/`finally` correctly

### Async Code (if applicable)
- Uses `async/await` clearly with proper error boundaries
- Avoids mixing sync and async I/O in the same call chain
- Uses `asyncio.gather` / `TaskGroup` for concurrent work
- Cancellation and timeout behavior handled appropriately

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.py:LINE`
**Category:** quality

**Issue:** Description of what's wrong and why it matters.

**Suggestion:** How to fix, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Bugs, incorrect behavior, serious maintainability risks
- MEDIUM: Weak typing, non-idiomatic patterns, unclear structure
- LOW: Style issues, minor cleanup, optional improvements

## Summary

After all findings, provide:
- Total count by severity
- Top 2-3 priority items to address
- Overall code quality assessment (1-2 sentences)
