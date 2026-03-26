---
name: python-security-review
description: This skill should be used when the user asks for "security review", "vulnerability scan", "audit Python security", "security audit", "find vulnerabilities", "check for security issues", or wants a deep security analysis of Python code including input validation, auth boundaries, and dependency risks.
---

# Python Security Review

**Action required:** Run `/review python security` to start an interactive security review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a comprehensive security audit of Python code, examining input validation, auth controls, data exposure, and dependency hygiene.

**Before starting the review, read the shared security review guidelines** at
[`../security-review-base/guidelines.md`](../security-review-base/guidelines.md)
for false-positive filtering rules, confidence scoring, and output format
requirements. Apply those rules throughout this review.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.py` and `.pyi` files
   - If no changes, ask the user what to review

## Review Process

1. **Understand existing security posture**: Identify security frameworks,
   middleware, validation libraries (Pydantic, marshmallow, cerberus, etc.),
   and established conventions already in the codebase before reviewing
   changes. Look for how the project currently handles auth, input validation,
   output encoding, and secrets management.
2. **Map attack surface**: API routes, views, CLI inputs, file handlers,
   webhooks, management commands
3. **Trace untrusted data flow** through validation, business logic, and
   storage/output
4. **Check each security domain** below
5. **Review dependency posture** (`requirements.txt`, `pyproject.toml`,
   `Pipfile`, lockfiles, build/runtime configs)
6. **Apply false-positive filtering** from the shared guidelines and the
   Python-specific rules below
7. **Output findings** in the format specified by the shared guidelines

## Python-Specific False-Positive Rules

In addition to the shared guidelines:

- **Django and Flask template engines are XSS-safe by default** — Django
  auto-escapes template variables, Jinja2 in Flask auto-escapes when
  configured. Only flag XSS via `|safe` filter, `mark_safe()`,
  `Markup()`, `{% autoescape false %}`, or rendering raw HTML strings
  directly. Do not report XSS in templates unless unsafe methods are used.
- `pickle` / `marshal` deserialization is only a security issue if it operates
  on **untrusted user input** — usage with trusted internal data (caches,
  internal queues with authenticated producers) is not a vulnerability
- `subprocess` calls are only injection risks if they use `shell=True` with
  **untrusted input** — calls with `shell=False` (the default) using list
  arguments are safe even with user-controlled values
- `eval()`, `exec()`, `compile()` are only security issues if they operate on
  **untrusted user input** — usage with trusted config or build-time values
  is not a vulnerability
- Missing type annotations or `# type: ignore` comments are type-safety issues,
  not security issues
- `assert` statements being stripped in optimized mode is only a concern if
  they are used for **security-critical validation** — do not flag asserts
  used for development invariants or test assertions
- Missing CSRF protection is only relevant for state-changing endpoints that
  use cookie-based authentication

## Security Checklist

### Input Validation & Parsing
- External input validated at system boundaries
- Uses schema validation (Pydantic, marshmallow, cerberus, or manual guards) before trust
- Length/range/format constraints enforced
- File paths and filenames sanitized (path traversal prevention via `pathlib` or `os.path.realpath`)
- No implicit trust in query params, headers, form data, or request bodies
- File uploads validated (type, size, content) and stored safely

### Authentication & Authorization
- Auth checks occur at every sensitive server-side boundary
- Authorization is resource-aware (not just role presence)
- No privilege escalation via alternate endpoints/flags
- Session/token validation robust (expiry, signature, audience/issuer as applicable)
- Sensitive operations require explicit permission checks
- Django: uses `@login_required`, `@permission_required`, or DRF permissions appropriately
- Flask: uses `@login_required` or equivalent middleware consistently

### Injection & Output Safety
- SQL queries use parameterized queries or ORM query builders (no string concatenation/f-strings in SQL)
- `subprocess` calls avoid `shell=True` with untrusted input; uses list arguments
- Template rendering prevents XSS (auto-escaping enabled, no `|safe` on user data)
- URL redirects validated (no open redirects from user-controlled values)
- SSRF risks mitigated for user-supplied URLs (host and protocol validated)
- LDAP, XML, YAML parsing uses safe loaders (`yaml.safe_load`, defusedxml)
- No `eval()` / `exec()` on untrusted input

### Secrets & Sensitive Data
- No hardcoded secrets, API keys, or credentials
- Secrets loaded via environment variables or secret manager
- Sensitive values excluded from logs and error payloads
- Stack traces/internal details not exposed to clients in production
- PII handling follows least-exposure principles
- Django `SECRET_KEY` and `DEBUG` settings appropriate for environment

### Dependency & Supply Chain
- Dependencies come from trusted registries (PyPI)
- Vulnerability scanning expected (`pip-audit`, `safety`, SCA tooling)
- Lockfile or pinned versions present and committed (`requirements.txt` with hashes, `poetry.lock`, `uv.lock`)
- Avoids unnecessary high-risk dependencies
- No use of `--trusted-host` or `--index-url` pointing to untrusted registries

### Transport & External Integrations
- External calls use HTTPS with certificate validation (`verify=True` in requests)
- Timeouts configured on all outbound HTTP/database connections
- Webhook signature verification implemented where relevant
- CORS configured restrictively (not wildcard with credentials)

### Unsafe Patterns & Hardening
- No `pickle.loads` / `marshal.loads` / `yaml.load` (unsafe loader) on untrusted data
- No `os.system()` or `subprocess` with `shell=True` on untrusted input
- Temporary files use `tempfile` module (not predictable paths in `/tmp`)
- `DEBUG = False` in production configurations
- Deserialization/parsing of complex objects guarded
- Uses `secrets` module for security-sensitive random values (not `random`)
