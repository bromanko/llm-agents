---
name: fsharp-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit F# security", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of F# code including input validation, .NET interop safety, and dependency concerns.
---

# F# Security Review

**Action required:** Run `/review fsharp security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of F# code, examining input validation, serialization boundaries, secrets handling, and potential vulnerabilities.

**Before starting the review, read the shared security review guidelines** at
[`../security-review-base/guidelines.md`](../security-review-base/guidelines.md)
for false-positive filtering rules, confidence scoring, and output format
requirements. Apply those rules throughout this review.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.fs` and `.fsx` files
   - If no changes, ask the user what to review

## Review Process

1. **Understand existing security posture**: Identify security frameworks,
   middleware, validation libraries, and established conventions already in the
   codebase before reviewing changes. Look for how the project currently handles
   auth, input validation, serialization, and secrets management.
2. **Map the attack surface**: Identify entry points (HTTP handlers, CLI args,
   file inputs, external service calls)
3. **Trace data flow**: Follow untrusted input through the codebase
4. **Check each security domain** below
5. **Review dependencies**: Check `.fsproj` and `paket.dependencies` /
   `nuget.config` for known issues
6. **Apply false-positive filtering** from the shared guidelines and the
   F#-specific rules below
7. **Output findings** in the format specified by the shared guidelines

## F#-Specific False-Positive Rules

In addition to the shared guidelines:

- Memory safety issues from pure F# code are extremely unlikely — **only flag
  unsafe interop via `NativePtr`, `NativeInterop`, P/Invoke, or `fixed`
  statements**
- F#'s type system and immutability-by-default prevent many classes of bugs —
  focus on boundaries where data enters or leaves the system (HTTP, DB,
  file I/O, deserialization, interop)
- `failwith` messages in internal code paths are not information disclosure
  unless the message is surfaced to end users via an API response
- Missing `[<Authorize>]` on internal/non-routable functions is not a
  vulnerability — only flag missing auth on actual HTTP endpoint handlers
- `obj` downcasting in internal code is a code quality issue, not a security
  issue, unless the `obj` originates from untrusted input

## Security Checklist

### Input Validation
- All external input validated at system boundaries
- String inputs checked for length limits
- Numeric inputs bounded appropriately
- File paths sanitized (no path traversal)
- URLs validated before use
- No assumption that input matches expected format
- Type providers used safely (data source trusted)

### Serialization & Deserialization
- JSON/XML deserialization uses safe settings (no type-name handling unless required)
- `System.Text.Json` / `Newtonsoft.Json` configured to prevent type confusion attacks
- Deserialized data validated after parsing
- No `BinaryFormatter` usage (inherently unsafe)
- Custom serializers handle malformed input gracefully

### SQL & Data Access
- Parameterized queries used (no string interpolation in SQL)
- Type providers (e.g., SqlProvider, Dapper.FSharp) used safely
- ORM queries don't expose raw SQL injection paths
- Connection strings not hardcoded
- Database permissions follow principle of least privilege

### Secrets Handling
- No hardcoded secrets, API keys, or credentials
- Environment variables or secret managers used for sensitive config
- Secrets not logged or included in error messages
- Config files with secrets not committed to repo
- `IConfiguration` / `User Secrets` used in development

### Dependency Security
- Check `.fsproj` / `paket.dependencies`:
  - Are packages from trusted sources (NuGet)?
  - Are there known vulnerabilities? (`dotnet list package --vulnerable`)
  - Are dependencies pinned to specific versions?
  - Any unnecessary dependencies that increase attack surface?

### External Service Calls
- HTTP requests use HTTPS
- `HttpClient` reused (not created per-request)
- API responses validated before use
- Timeouts configured for external calls
- Certificate validation not disabled
- No command injection in `Process.Start` calls

### Unsafe Code & Interop
- `NativePtr` / `NativeInterop` reviewed for memory safety
- P/Invoke signatures correct (buffer overflows possible with wrong sizes)
- `fixed` statements used correctly
- `Unchecked` module usage justified
- No `obj` downcasting on untrusted data
- `use` / `IDisposable` properly handled (no resource leaks)

### Authentication & Authorization
- Auth checks at appropriate boundaries
- No auth bypass through alternate code paths
- ASP.NET authorization attributes/policies applied correctly
- Session/token handling secure
- Privilege escalation paths reviewed
- CORS configured appropriately

### Error Handling & Information Disclosure
- Error messages don't leak internal details (stack traces, connection strings)
  to end users via API responses
- Logging doesn't contain PII or secrets
- Debug endpoints / `#if DEBUG` code not in production
- Exception filters don't silently swallow security-relevant errors

### Data Exposure
- Sensitive fields excluded from serialization (`[<JsonIgnore>]`, etc.)
- API responses filtered to authorized data only
- `ToString()` overrides don't expose sensitive fields
