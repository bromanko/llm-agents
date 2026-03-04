---
name: typescript-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit TypeScript security", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of TypeScript code including input validation, auth boundaries, and dependency risks.
---

# TypeScript Security Review

**Action required:** Run `/review typescript security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of TypeScript code, examining input validation, auth controls, data exposure, and dependency hygiene.

**Before starting the review, read the shared security review guidelines** at
[`../security-review-base/guidelines.md`](../security-review-base/guidelines.md)
for false-positive filtering rules, confidence scoring, and output format
requirements. Apply those rules throughout this review.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.ts`, `.tsx`, `.mts`, and `.cts` files
   - If no changes, ask the user what to review

## Review Process

1. **Understand existing security posture**: Identify security frameworks,
   middleware, validation libraries (Zod, io-ts, etc.), and established
   conventions already in the codebase before reviewing changes. Look for how
   the project currently handles auth, input validation, output encoding, and
   secrets management.
2. **Map attack surface**: API routes, controllers, web forms, CLI inputs, file
   handlers, webhooks
3. **Trace untrusted data flow** through validation, business logic, and
   storage/output
4. **Check each security domain** below
5. **Review dependency posture** (`package.json`, lockfiles, build/runtime
   configs)
6. **Apply false-positive filtering** from the shared guidelines and the
   TypeScript-specific rules below
7. **Output findings** in the format specified by the shared guidelines

## TypeScript-Specific False-Positive Rules

In addition to the shared guidelines:

- **React and Angular are XSS-safe by default** — these frameworks auto-escape
  rendered content. Only flag XSS via `dangerouslySetInnerHTML`,
  `bypassSecurityTrustHtml`, `[innerHTML]` bindings, or similar explicit
  bypass methods. Do not report XSS in `.tsx` or Angular component files
  unless unsafe methods are used.
- **Client-side JS/TS code does not need auth or permission checks** —
  client-side code is not trusted; the server is responsible for enforcing
  auth and validating inputs. Do not flag missing auth in browser-side code.
- Missing type narrowing or `as` casts in internal code are type-safety issues,
  not security issues, unless the cast is on untrusted external input that
  bypasses validation
- `eval`, `new Function`, and dynamic `import()` are only security issues if
  they operate on **untrusted user input** — usage with trusted config or
  build-time values is not a vulnerability
- Missing CSP headers or security headers are hardening concerns, not concrete
  vulnerabilities — do not report unless there is a specific exploit they would
  prevent in the reviewed code

## Security Checklist

### Input Validation & Parsing
- External input validated at system boundaries
- Uses schema validation (e.g., Zod/io-ts/Valibot/custom guards) before trust
- Length/range/format constraints enforced
- File paths and filenames sanitized (path traversal prevention)
- No implicit trust in query params, headers, or request bodies

### Authentication & Authorization
- Auth checks occur at every sensitive server-side boundary
- Authorization is resource-aware (not just role presence)
- No privilege escalation via alternate endpoints/flags
- Session/token validation robust (expiry, signature, audience/issuer as applicable)
- Sensitive operations require explicit permission checks

### Injection & Output Safety
- SQL/NoSQL queries parameterized (no string-concatenated queries)
- Command execution avoids shell interpolation of untrusted input
- Template rendering/UI output prevents XSS (escaping/sanitization)
- URL redirects validated (no open redirects)
- SSRF risks mitigated for user-supplied URLs (host and protocol validated)

### Secrets & Sensitive Data
- No hardcoded secrets, API keys, or credentials
- Secrets loaded via environment/secret manager
- Sensitive values excluded from logs and error payloads
- Stack traces/internal details not exposed to clients in production
- PII handling follows least-exposure principles

### Dependency & Supply Chain
- Dependencies come from trusted registries/sources
- Vulnerability scanning expected (`npm audit`, `pnpm audit`, SCA tooling)
- Lockfile present and committed
- Avoids unnecessary high-risk dependencies
- Build scripts and postinstall hooks reviewed for trust boundaries

### Transport & External Integrations
- External calls use HTTPS with certificate validation
- Timeouts and retry limits configured
- Webhook signature verification implemented where relevant
- CORS configured restrictively (not wildcard with credentials)

### Unsafe Patterns & Hardening
- No use of `eval`, `new Function`, or dynamic code execution on untrusted input
- Deserialization/parsing of complex objects guarded
- Dangerous defaults overridden in framework/security middleware
- Debug/dev-only paths not exposed in production deployments
