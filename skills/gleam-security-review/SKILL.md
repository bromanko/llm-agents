---
name: gleam-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit gleam security", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of Gleam code including FFI safety, input validation, and dependency concerns.
---

# Gleam Security Review

**Action required:** Run `/review gleam security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of Gleam code, examining input validation, FFI boundaries, secrets handling, and potential vulnerabilities.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.gleam` files
   - If no changes, ask the user what to review

## Review Process

1. **Map the attack surface**: Identify entry points (HTTP handlers, CLI args, file inputs, external service calls)
2. **Trace data flow**: Follow untrusted input through the codebase
3. **Check each security domain** below
4. **Review dependencies**: Check `gleam.toml` for known issues
5. **Output findings** in the standard format

## Security Checklist

### Input Validation
- All external input validated at system boundaries
- String inputs checked for length limits
- Numeric inputs bounded appropriately
- File paths sanitized (no path traversal)
- URLs validated before use
- No assumption that input matches expected format

### FFI Safety (Erlang/JavaScript Interop)
- External functions wrapped with proper error handling
- Erlang NIFs reviewed for memory safety
- JavaScript FFI inputs sanitized
- Return types from FFI properly validated
- No blind trust of external function results
- Crashes in FFI code handled gracefully

### Secrets Handling
- No hardcoded secrets, API keys, or credentials
- Environment variables used for sensitive config
- Secrets not logged or included in error messages
- Config files with secrets not committed to repo
- Database connection strings properly secured

### Dependency Security
- Check `gleam.toml` dependencies:
  - Are packages from trusted sources?
  - Are there known vulnerabilities? (check hex.pm advisories)
  - Are dependencies pinned to specific versions?
  - Any unnecessary dependencies that increase attack surface?

### External Service Calls
- HTTP requests use HTTPS
- API responses validated before use
- Timeouts configured for external calls
- Rate limiting considered
- No SQL/command injection in queries
- Proper escaping for any interpolated values

### Process Isolation (BEAM-specific)
- Sensitive operations isolated in separate processes
- Process crashes don't leak sensitive data
- Supervision trees handle failures gracefully
- No unbounded process spawning from user input
- Message passing doesn't expose internal state inappropriately

### Unsafe Patterns
- `panic` and `todo` not used in production paths
- No `assert` on untrusted input
- Error messages don't leak internal details
- Debug/development code not in production paths
- No commented-out security checks

### Authentication & Authorization
- Auth checks at appropriate boundaries
- No auth bypass through alternate code paths
- Session/token handling secure
- Privilege escalation paths reviewed
- Consistent auth enforcement

### Data Exposure
- Sensitive fields not serialized unintentionally
- Logs don't contain PII or secrets
- Error responses don't leak implementation details
- Debug endpoints disabled in production

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.gleam:LINE`
**Category:** security

**Issue:** Description of the vulnerability and potential impact.

**Suggestion:** How to remediate, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Exploitable vulnerabilities, data exposure, auth bypass
- MEDIUM: Defense-in-depth issues, missing validation, weak patterns
- LOW: Hardening opportunities, best practice deviations

## Summary

After all findings, provide:
- Total count by severity
- Critical items requiring immediate attention
- Attack surface summary (entry points identified)
- Dependency risk assessment
- Overall security posture (1-2 sentences)
