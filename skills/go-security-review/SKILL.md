---
name: go-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit Go security", "golang security audit", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of Go code including input validation, auth boundaries, and dependency risks.
---

# Go Security Review

**Action required:** Run `/review go security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of Go code, examining input validation, auth controls, data exposure, and dependency hygiene.

**Before starting the review, read the shared security review guidelines** at
[`../security-review-base/guidelines.md`](../security-review-base/guidelines.md)
for false-positive filtering rules, confidence scoring, and output format
requirements. Apply those rules throughout this review.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.go` files
   - If no changes, ask the user what to review

## Review Process

1. **Understand existing security posture**: Identify security frameworks,
   middleware, validation libraries, and established conventions already in the
   codebase before reviewing changes. Look for how the project currently
   handles auth, input validation, output encoding, and secrets management.
2. **Map attack surface**: HTTP handlers, gRPC services, CLI inputs, file
   handlers, webhooks, cron jobs
3. **Trace untrusted data flow** through validation, business logic, and
   storage/output
4. **Check each security domain** below
5. **Review dependency posture** (`go.mod`, `go.sum`, build/runtime configs)
6. **Apply false-positive filtering** from the shared guidelines and the
   Go-specific rules below
7. **Output findings** in the format specified by the shared guidelines

## Go-Specific False-Positive Rules

In addition to the shared guidelines:

- **Go's `html/template` package is XSS-safe by default** — it contextually
  escapes output. Only flag XSS via `template.HTML()`, `template.JS()`,
  `template.URL()` type conversions on untrusted data, or use of
  `text/template` for HTML rendering. Do not report XSS in `html/template`
  usage unless unsafe type conversions are present.
- `os/exec.Command` with separate arguments (not through a shell) is safe even
  with user-controlled values — only flag command injection when commands are
  passed through `sh -c` or `bash -c` with string concatenation/interpolation
  of untrusted input
- `unsafe.Pointer` usage is a correctness concern, not a security vulnerability,
  unless it directly enables memory corruption exploitable by an external
  attacker
- Integer overflow in Go is well-defined (wraps) — only flag it when it has
  concrete security implications (e.g., buffer size calculation leading to
  undersized allocation with untrusted input controlling the size)
- Missing `context.Context` propagation is a reliability concern, not a security
  issue
- Race conditions detected by `go vet` / `-race` are correctness issues — only
  report as security findings if they have a concrete exploit path (e.g., TOCTOU
  on auth checks)

## Security Checklist

### Input Validation & Parsing
- External input validated at handler/service boundaries
- Uses struct validation tags or explicit validation before trust
- Length/range/format constraints enforced
- File paths sanitized (`filepath.Clean`, `filepath.Rel`, preventing traversal outside root)
- No implicit trust in query params, headers, path parameters, or request bodies
- File uploads validated (type, size, content) and stored safely
- JSON/XML/YAML parsing uses appropriate size limits (`http.MaxBytesReader`, decoder limits)

### Authentication & Authorization
- Auth checks occur at every sensitive endpoint/handler
- Middleware applies auth consistently (not bypassed by route ordering)
- Authorization is resource-aware (not just role presence)
- No privilege escalation via alternate endpoints or parameter manipulation
- Session/token validation robust (expiry, signature, audience/issuer)
- Sensitive operations require explicit permission checks
- API keys and tokens compared using `subtle.ConstantTimeCompare`

### Injection & Output Safety
- SQL queries use parameterized queries (`db.Query(sql, args...)`) — no string concatenation
- Commands avoid shell execution with untrusted input (no `sh -c` + user data)
- HTML template rendering uses `html/template` (not `text/template`) for web output
- URL redirects validated (no open redirects from user-controlled values)
- SSRF risks mitigated for user-supplied URLs (host and protocol validated)
- LDAP/XML parsing uses safe configurations (entity expansion limits)

### Secrets & Sensitive Data
- No hardcoded secrets, API keys, or credentials
- Secrets loaded via environment variables or secret manager
- Sensitive values excluded from logs and error responses
- Error messages to clients are generic (no stack traces or internal details)
- PII handling follows least-exposure principles
- Crypto keys generated with `crypto/rand` (not `math/rand`)

### Dependency & Supply Chain
- Dependencies come from trusted sources
- `go.sum` committed and verified
- Vulnerability scanning expected (`govulncheck`, SCA tooling)
- Avoids unnecessary CGo dependencies (increases attack surface)
- Replace directives in `go.mod` reviewed for trust
- Build tags and conditional compilation reviewed for security implications

### Transport & External Integrations
- External calls use HTTPS with proper TLS configuration
- TLS `MinVersion` set to `tls.VersionTLS12` or higher
- No `InsecureSkipVerify: true` in production TLS configs
- Timeouts configured on all HTTP servers and clients (`ReadTimeout`, `WriteTimeout`, `IdleTimeout`)
- Webhook signature verification implemented where relevant
- CORS configured restrictively (not wildcard with credentials)

### Unsafe Patterns & Hardening
- No `unsafe` package usage operating on untrusted input
- Deserialization size limits enforced (`io.LimitReader`, `http.MaxBytesReader`)
- HTTP server timeouts prevent slowloris and resource exhaustion
- `net/http` handlers don't leak goroutines on client disconnect (respect `context.Done()`)
- Uses `crypto/rand` for all security-sensitive random values
- Race-free access to security-critical shared state
- Embedded files (`//go:embed`) don't include sensitive data
