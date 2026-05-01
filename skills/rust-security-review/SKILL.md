---
name: rust-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit Rust security", "rust security audit", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of Rust code including unsafe boundaries, input validation, auth controls, and dependency risks.
---

# Rust Security Review

**Action required:** Run `/review rust security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of Rust code, examining unsafe boundaries, input validation, authentication/authorization controls, data exposure, cryptography, and dependency hygiene.

**Before starting the review, read the shared security review guidelines** at
[`../security-review-base/guidelines.md`](../security-review-base/guidelines.md)
for false-positive filtering rules, confidence scoring, and output format
requirements. Apply those rules throughout this review.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.rs` files and relevant `Cargo.toml` / `Cargo.lock` changes
   - If no changes, ask the user what to review

## Review Process

1. **Understand existing security posture**: Identify web frameworks, auth middleware, validation libraries, crypto crates, FFI boundaries, unsafe modules, and established project conventions.
2. **Map attack surface**: HTTP/gRPC handlers, CLI inputs, file/archive processing, parsers, deserializers, webhooks, background jobs, FFI calls, plugin/proc-macro/build-script boundaries.
3. **Trace untrusted data flow** through validation, authorization, business logic, storage, logging, and output.
4. **Inspect unsafe and FFI boundaries** for soundness invariants and safe wrappers.
5. **Review dependency posture** (`Cargo.toml`, `Cargo.lock`, features, `build.rs`, proc macros, supply-chain risk).
6. **Apply false-positive filtering** from the shared guidelines and the Rust-specific rules below.
7. **Output findings** in the format specified by the shared guidelines.

## Rust-Specific False-Positive Rules

In addition to the shared guidelines:

- **Rust is memory-safe by default.** Do not report generic memory safety issues unless there is `unsafe`, FFI, unchecked indexing/pointer arithmetic, or a concrete soundness bug.
- `unwrap()` / `expect()` are reliability issues by default, not security vulnerabilities. Report them as security findings only when untrusted input can trigger a denial of service, bypass cleanup, expose sensitive data, or violate an auth/security boundary.
- `unsafe` is not automatically a vulnerability. Report it only when invariants are undocumented/unenforced or there is a plausible path to UB, memory corruption, data race, type confusion, or invalid aliasing.
- Integer overflow is checked in debug and wraps in release for primitive arithmetic. Report only when overflow has concrete security impact (size calculation, bounds/auth logic, crypto, quotas). Prefer checking for `checked_*`, `saturating_*`, or explicit bounds where relevant.
- Deserialization with `serde` is not inherently unsafe. Report only if untrusted data can cause resource exhaustion, type confusion through custom visitors, unsafe post-processing, or missing validation of semantic constraints.
- `Command::new` with separate `.arg()` values is not shell injection. Only flag command injection when a shell is invoked (`sh -c`, `cmd /C`, etc.) or untrusted input controls the executable/path in a dangerous context.
- Missing async cancellation, tracing, or `clippy` warnings are not security findings unless tied to a concrete exploit path.

## Security Checklist

### Input Validation & Parsing
- External input is validated at handler/service/CLI boundaries before trust
- Semantic constraints are enforced after deserialization (length, range, enum/domain invariants)
- Parsers bound input size, recursion depth, decompression ratio, and allocation growth
- File paths are normalized and constrained (`Path::components`, `canonicalize` with care, root-relative checks) to prevent traversal
- Archive extraction defends against zip/tar slip, symlinks, hardlinks, and absolute paths
- Regexes and parsers avoid ReDoS or unbounded backtracking where applicable
- User-controlled URLs are parsed and validated for protocol, host, and IP ranges where SSRF matters

### Authentication & Authorization
- Auth middleware applies consistently across routes/services
- Authorization checks are resource-aware and cannot be bypassed by alternate IDs, routes, or feature flags
- Session/token validation checks expiry, signature, issuer/audience, revocation where applicable
- Sensitive operations require explicit permission checks near the operation
- Constant-time comparison is used for secrets/tokens (`subtle`, framework-provided helpers, or equivalent)
- Client-side or UI-visible state is never trusted for server authorization

### Unsafe Code, FFI & Soundness
- Every `unsafe` block has a documented safety invariant and minimal scope
- Safe wrappers around unsafe code fully enforce preconditions before entering `unsafe`
- Raw pointers are checked for null, alignment, initialization, aliasing, and lifetime validity
- `MaybeUninit`, `ManuallyDrop`, `transmute`, `from_raw_parts`, `from_utf8_unchecked`, and unchecked indexing preserve invariants
- FFI validates ownership, allocation/deallocation pairing, string encoding, buffer lengths, and thread-safety contracts
- No unsound `Send` / `Sync` implementations
- No data races through atomics, mutable statics, `UnsafeCell`, or global state

### Injection & Output Safety
- SQL uses parameterized queries or query builders that bind values safely
- Shell execution avoids invoking shells with interpolated untrusted input
- HTML/template output is escaped by the framework/template engine; raw HTML insertion is justified and sanitized
- Redirect targets are validated to prevent open redirects
- Logs and error responses do not expose secrets or sensitive internals
- Header, path, and URL construction handles encoding correctly

### Secrets, Crypto & Randomness
- No hardcoded credentials, tokens, private keys, or test secrets in production paths
- Secrets are loaded from environment/secret managers and redacted in logs/errors/debug output
- Cryptographic randomness uses `rand::rngs::OsRng`, `getrandom`, or vetted crate APIs, not predictable PRNGs
- Password hashing uses Argon2/bcrypt/scrypt with appropriate parameters, not raw hashes
- TLS verification is not disabled in production clients
- Cryptographic algorithms, modes, and key sizes are modern and provided by vetted crates

### Dependencies & Supply Chain
- `Cargo.lock` is committed for applications/binaries and reviewed for unexpected changes
- Dependencies come from trusted crates and are maintained; unnecessary dependencies are avoided
- `cargo audit`, `cargo deny`, or equivalent vulnerability/license checks are expected in CI
- Feature flags do not enable insecure defaults or unnecessary attack surface
- `build.rs` scripts and proc macros are reviewed as code execution during build
- Git/path dependencies and `[patch]` overrides are intentional and trusted

### Transport & External Integrations
- HTTP clients and servers use timeouts and request size limits
- TLS minimum versions and certificate validation are appropriate
- Webhook signatures are verified before processing payloads
- CORS policies are restrictive and do not allow credentials with wildcard origins
- Outbound network calls from user-supplied destinations defend against SSRF

## Output Format

Use the shared security review output format, including confidence when requested by the shared guidelines. Findings must still begin with:

```markdown
### [SEVERITY] Issue Title
```

Use severity indicators:
- HIGH: Auth bypass, secret exposure, exploitable unsafe/FFI soundness bug, injection with concrete exploit path, critical dependency risk
- MEDIUM: Missing validation with plausible abuse, unsafe invariant gaps with realistic risk, sensitive data exposure in non-critical paths
- LOW: Defense-in-depth hardening, incomplete limits, dependency hygiene issues with low immediate exploitability

## Summary

After all findings, provide:
- Total count by severity
- Highest-risk attack paths
- Security posture assessment (1-2 sentences)
