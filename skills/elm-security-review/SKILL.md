---
name: elm-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit Elm security", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of Elm code including port safety, JSON decoder validation, and XSS prevention.
---

# Elm Security Review

**Action required:** Run `/review elm security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of Elm code, examining port boundaries, JSON decoder validation, HTML injection prevention, and potential vulnerabilities at the JavaScript interop layer.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.elm` files
   - If no changes, ask the user what to review

## Review Process

1. **Map the attack surface**: Identify ports, flags, HTTP endpoints, user input fields
2. **Trace data flow**: Follow untrusted input from ports/HTTP through the codebase
3. **Check each security domain** below
4. **Review dependencies**: Check `elm.json` for package concerns
5. **Output findings** in the standard format

## Security Checklist

### Port Safety (JavaScript Interop)
- All data received through ports is validated via JSON decoders
- Port subscriptions handle malformed data gracefully (decoder errors caught)
- No assumption that JavaScript side sends correct data types
- Outgoing port data doesn't leak sensitive information
- Port names don't reveal internal architecture
- `flags` validated at application startup

### JSON Decoder Validation
- Decoders enforce expected data shapes at the boundary
- String fields checked for length limits where appropriate
- Numeric fields bounded where appropriate
- `Decode.oneOf` fallbacks don't silently accept invalid data
- No `Decode.value` passed through without validation
- Decoder errors logged or displayed meaningfully (not silently swallowed)

### HTML & XSS Prevention
- Elm's virtual DOM prevents most XSS by default, but check:
  - `Html.Attributes.property` with raw JSON used safely
  - `Html.node` with dynamic tag names sanitized
  - Markdown rendering (via ports or packages) sanitizes HTML
  - User-generated content rendered through normal Elm HTML functions (not injected raw)
  - URLs in `href` and `src` validated (no `javascript:` protocol)
  - CSS values from user input sanitized (no CSS injection)

### URL & Navigation
- URL parsing handles malformed URLs gracefully
- Route parameters validated before use
- External URLs validated before navigation
- No open redirect vulnerabilities (user-controlled redirect targets)
- Fragment/query parameters treated as untrusted input
- `Browser.Navigation.load` targets validated

### HTTP & API Communication
- HTTPS used for all API calls
- API responses validated via JSON decoders (not trusted blindly)
- Authentication tokens not exposed in URLs (use headers)
- CSRF tokens included where required
- Sensitive data not sent in query parameters
- Error responses don't leak server internals to the UI

### Secrets & Sensitive Data
- No API keys, tokens, or secrets hardcoded in Elm source
- Flags used for configuration — ensure sensitive flags are appropriate for client-side
- Sensitive data not stored in Model longer than necessary
- Browser storage (via ports) doesn't hold sensitive data unencrypted
- No sensitive data in URL fragments or query strings

### Dependency Security
- Check `elm.json` dependencies:
  - Are packages from trusted authors?
  - Are there known issues? (check Elm package registry)
  - Are native/kernel code packages avoided? (Elm packages can't have native code, but verify)
  - Any packages that use ports in unexpected ways?

### Client-Side State
- Model doesn't accumulate unbounded data (potential memory exhaustion)
- Authentication state properly cleared on logout
- Session timeout handled client-side
- Sensitive form data cleared after submission
- Browser back/forward doesn't expose sensitive state

### Content Security
- External content (images, iframes) loaded from trusted sources only
- User-provided URLs sanitized before use in `src` / `href`
- SVG content from user input sanitized (SVG can contain scripts via ports)
- File uploads (via ports) validated on both client and server side

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/Module.elm:LINE`
**Category:** security

**Issue:** Description of the vulnerability and potential impact.

**Suggestion:** How to remediate, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Exploitable vulnerabilities, data exposure, XSS vectors
- MEDIUM: Defense-in-depth issues, missing validation, weak patterns
- LOW: Hardening opportunities, best practice deviations

## Summary

After all findings, provide:
- Total count by severity
- Critical items requiring immediate attention
- Attack surface summary (ports, HTTP endpoints, user inputs identified)
- Dependency risk assessment
- Overall security posture (1-2 sentences)
