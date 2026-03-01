# EARS Patterns Reference

Complete reference for all EARS patterns with examples across domains, anti-patterns,
verification mapping, and guidance for extracting requirements from code.

## Table of Contents

1. [Pattern Details](#pattern-details)
2. [Complex Pattern Combinations](#complex-pattern-combinations)
3. [Anti-Pattern Catalog](#anti-pattern-catalog)
4. [Verification Mapping Guide](#verification-mapping-guide)
5. [Extracting Requirements from Code](#extracting-requirements-from-code)
6. [Requirements Quality Checklist](#requirements-quality-checklist)
7. [When NOT to Use EARS](#when-not-to-use-ears)

---

## Pattern Details

### 1. Ubiquitous Requirements

**Template:** `The <system name> shall <system response>.`

**When to use:** The behavior is always active — no preconditions, triggers, or feature
gates. Typically covers fundamental properties, constraints, and non-functional
requirements.

**Examples:**

| Domain | Requirement |
|--------|-------------|
| Web API | The API gateway shall respond to all requests within 500 milliseconds at the 99th percentile. |
| CLI tool | The CLI shall return exit code 0 on success and a non-zero exit code on failure. |
| Mobile app | The app shall encrypt all data at rest using AES-256. |
| Embedded | The controller shall consume no more than 50mA in active mode. |

**Common mistakes:**
- Using ubiquitous when a trigger or state is implied ("The system shall display the
  dashboard" — when? on login? always?)
- Specifying implementation ("The system shall use Redis for caching") instead of the
  actual need

---

### 2. State-Driven Requirements (While)

**Template:** `While <precondition(s)>, the <system name> shall <system response>.`

**When to use:** The behavior is active only while a particular state or condition holds.
The system continuously exhibits this behavior for the duration of the state.

**Examples:**

| Domain | Requirement |
|--------|-------------|
| Web app | While the user session is authenticated, the application shall display the navigation bar with the user's name. |
| Network | While the primary database connection is unavailable, the service shall route read queries to the replica. |
| Embedded | While battery level is below 10%, the device shall disable non-essential background processes. |
| CLI | While running in verbose mode, the CLI shall log each HTTP request and response to stderr. |

**Tips:**
- The precondition describes a *state that persists*, not a momentary event.
- Multiple preconditions are joined with "and": `While A and B, the system shall...`
- Keep to 1–3 preconditions. More than 3 suggests the requirement needs decomposition.

---

### 3. Event-Driven Requirements (When)

**Template:** `When <trigger>, the <system name> shall <system response>.`

**When to use:** A discrete event causes the system to do something. The trigger is
momentary — it happens and then the system responds.

**Examples:**

| Domain | Requirement |
|--------|-------------|
| Web API | When a POST request is received at /api/users, the service shall validate the request body against the user schema. |
| Desktop | When the user presses Ctrl+S, the editor shall save the current document to disk. |
| CI/CD | When a pull request is merged to the main branch, the pipeline shall trigger a deployment to the staging environment. |
| Auth | When a user submits valid credentials, the authentication service shall issue a JWT with a 1-hour expiry. |

**Tips:**
- The trigger should be a specific, observable event — not a vague condition.
- "When the user clicks Submit" is better than "When the form is submitted" (clarifies
  who/what initiates).

---

### 4. Optional Feature Requirements (Where)

**Template:** `Where <feature is included>, the <system name> shall <system response>.`

**When to use:** The requirement only applies to configurations or variants that include
a specific optional feature. Common in product lines, plugin architectures, and
feature-flagged systems.

**Examples:**

| Domain | Requirement |
|--------|-------------|
| SaaS | Where the tenant has the analytics add-on enabled, the dashboard shall display usage charts. |
| Platform | Where the plugin system is installed, the application shall load plugins from the /plugins directory on startup. |
| Config | Where TLS is configured, the server shall reject connections using TLS versions below 1.2. |
| Hardware | Where GPS hardware is present, the device shall report location coordinates in the telemetry payload. |

**Tips:**
- The "Where" clause gates applicability, not behavior. The feature either exists or
  it doesn't.
- Don't confuse with state-driven: "Where" is about system configuration/variant, not
  runtime state.

---

### 5. Unwanted Behavior Requirements (If/Then)

**Template:** `If <trigger>, then the <system name> shall <system response>.`

**When to use:** Handling errors, faults, failures, invalid input, resource exhaustion,
timeouts, and other undesired situations. These are your defensive requirements.

**Examples:**

| Domain | Requirement |
|--------|-------------|
| Web API | If the request body fails schema validation, then the API shall return HTTP 400 with a JSON error describing the validation failures. |
| Auth | If the JWT signature verification fails, then the auth middleware shall reject the request with HTTP 401. |
| Network | If the upstream service does not respond within 5 seconds, then the gateway shall return HTTP 504 to the client. |
| Data | If a database write fails due to a constraint violation, then the service shall log the error and return a descriptive error to the caller. |
| File I/O | If the configuration file is missing or unreadable, then the application shall start with default configuration values and log a warning. |

**Tips:**
- "If/Then" is specifically for undesired/unexpected situations. For normal event-driven
  behavior, use "When".
- Distinguish: "When the user clicks Submit" (desired event) vs. "If the form submission
  times out, then..." (unwanted situation).
- Every "When" requirement should have corresponding "If/Then" requirements covering
  what happens when the expected flow fails.

---

### 6. Complex Requirements (While + When ± If/Then)

**Template:** `While <precondition(s)>, when <trigger>, the <system name> shall <system response>.`

**When to use:** The system response depends on both a persisting state and a triggering
event. Use sparingly — complex requirements should be the exception, not the norm.

**Examples:**

| Domain | Requirement |
|--------|-------------|
| Auth | While the user has admin privileges, when a delete request is received for a user account, the admin service shall mark the account as deactivated. |
| Network | While operating in degraded mode, when a new request arrives, the load balancer shall route only to healthy nodes. |
| CI/CD | While the deployment is in progress, when a new commit is pushed, the pipeline shall queue the commit for the next deployment cycle. |

**Complex + Unwanted behavior:**

`While <precondition>, if <unwanted trigger>, then the <system> shall <response>.`

Example: While the system is processing a batch job, if available memory drops below 100MB, then the batch processor shall pause processing and alert the operator.

---

## Complex Pattern Combinations

These are the valid EARS pattern combinations in order of increasing complexity:

| Combination | Template |
|---|---|
| While + system + shall | While \<pre\>, the \<sys\> shall \<resp\>. |
| When + system + shall | When \<trig\>, the \<sys\> shall \<resp\>. |
| Where + system + shall | Where \<feat\>, the \<sys\> shall \<resp\>. |
| If + then + system + shall | If \<trig\>, then the \<sys\> shall \<resp\>. |
| While + When + system + shall | While \<pre\>, when \<trig\>, the \<sys\> shall \<resp\>. |
| Where + When + system + shall | Where \<feat\>, when \<trig\>, the \<sys\> shall \<resp\>. |
| While + If/Then + system + shall | While \<pre\>, if \<trig\>, then the \<sys\> shall \<resp\>. |
| While + When + If/Then + system + shall | While \<pre\>, when \<trig\>, if \<fail\>, then the \<sys\> shall \<resp\>. |

---

## Anti-Pattern Catalog

### Structural anti-patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| **Compound requirement** | "The system shall X and Y" — two behaviors in one requirement | Split into separate requirements |
| **Missing trigger** | "The system shall display an error" — when? | Add When or If clause |
| **Vague response** | "shall handle gracefully", "shall support" | Specify the exact observable behavior |
| **Passive voice trigger** | "When the button is pressed" | Acceptable, but prefer active voice when the actor matters: "When the user presses the button" |
| **Nested conditions** | "If A, and if B, then if C..." | Restructure into separate requirements or use a decision table |

### Semantic anti-patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| **Implementation requirement** | "shall use PostgreSQL", "shall implement in Python" | Specify the need: "shall persist data with ACID guarantees" |
| **Weasel words** | "fast", "user-friendly", "robust", "efficient", "minimal" | Replace with measurable criteria |
| **Universal quantifiers** | "all users", "every request", "no exceptions" | Be specific unless you genuinely mean universal |
| **Negative requirements** | "shall not crash" | Rewrite positively: "shall remain operational" or specify the unwanted behavior with If/Then |
| **Wishful thinking** | "shall be secure", "shall be reliable" | Decompose into specific, testable behaviors |

### Scope anti-patterns

| Anti-pattern | Problem | Fix |
|---|---|---|
| **Goal masquerading as requirement** | "The system shall improve user satisfaction" | Goals inform requirements; they are not requirements themselves |
| **Design constraint as requirement** | "The API shall use REST" | Only include as a requirement if it's a genuine stakeholder constraint |
| **Test case as requirement** | "The system shall pass when 1000 concurrent users log in" | Abstract to the requirement: "shall support 1000 concurrent authenticated sessions" |

---

## Verification Mapping Guide

Each EARS requirement should map to at least one verification method:

### Test
Execute the system and observe the response. Most event-driven and unwanted behavior
requirements verify well through testing.

**Mapping pattern:**
- When/If-Then requirements → Provide the trigger, observe the response
- State-driven requirements → Enter the state, verify the behavior persists
- Complex requirements → Enter the state, provide the trigger, observe the response

**Example:**
```
Requirement: When a POST request is received at /api/users with valid data, 
             the service shall return HTTP 201 with the created user object.
Verification: Test — Send POST /api/users with valid payload; assert HTTP 201 
             and response body contains user ID.
```

### Inspection
Examine artifacts (code, configuration, documentation) to verify compliance. Best for
ubiquitous constraints and implementation-independent properties.

**Example:**
```
Requirement: The application shall encrypt all data at rest using AES-256.
Verification: Inspection — Review encryption configuration and storage layer code; 
             verify AES-256 is specified for all data stores.
```

### Analysis
Use calculation, simulation, or formal reasoning. Best for performance, safety, and
resource requirements.

**Example:**
```
Requirement: The API gateway shall respond within 500ms at the 99th percentile.
Verification: Analysis — Load test with production traffic profile; 
             compute p99 latency from results.
```

### Demonstration
Show the system performing the required behavior in a controlled setting. Best for
user-facing features and workflow requirements.

**Example:**
```
Requirement: When the user clicks "Export", the dashboard shall download a CSV 
             containing the currently filtered data.
Verification: Demonstration — With filters applied, click Export; 
             open CSV and verify contents match the displayed data.
```

---

## Extracting Requirements from Code

When deriving EARS requirements from an existing codebase, follow this systematic
approach:

### 1. Map the system boundary
- What are the external interfaces? (APIs, UIs, file I/O, hardware interfaces)
- What crosses the boundary? (requests, events, signals, data)
- These boundary interactions become your triggers and responses.

### 2. Identify behavioral categories

| Code pattern | Likely EARS pattern |
|---|---|
| Constants, config defaults, hardcoded limits | Ubiquitous |
| `if mode == X` / state machine transitions | State-driven |
| Event handlers, route handlers, signal handlers | Event-driven |
| Feature flags, `if feature_enabled` | Optional feature |
| try/catch, error returns, validation failures, retries | Unwanted behavior |
| Combinations of the above | Complex |

### 3. Abstract from implementation to behavior

**Don't write:** "When a POST to /users is received, the handler shall parse JSON, validate
fields, hash the password with bcrypt, insert a row into the users table, and return 201."

**Do write:** "When a POST request is received at /api/users with valid data, the service
shall create a new user account and return HTTP 201 with the created user object."

The implementation details (bcrypt, SQL insert) belong in design docs, not requirements.

### 4. Surface implicit requirements

Code often implements behaviors that were never formally specified:
- Timeout values hardcoded as constants
- Retry logic with specific backoff strategies
- Rate limiting thresholds
- Input sanitization and validation rules
- Logging and audit trail behaviors
- Graceful shutdown sequences

Surface these as explicit EARS requirements so they can be verified intentionally.

### 5. Identify gaps

Look for missing defensive code and flag these as recommended additions:
- Functions that don't handle errors
- Missing input validation
- No timeout on external calls
- Missing logging for security-relevant events
- No graceful degradation when dependencies fail

---

## Requirements Quality Checklist

Before finalizing, verify each requirement against:

- [ ] **Single behavior:** Does the requirement specify exactly one behavior?
- [ ] **Correct pattern:** Does the EARS pattern match the behavioral type?
- [ ] **"Shall" used:** Is the imperative "shall" used (not should/will/may)?
- [ ] **System named:** Is the system name explicit?
- [ ] **Specific response:** Is the system response concrete and observable?
- [ ] **No weasel words:** Are terms like "fast", "robust", "user-friendly" eliminated?
- [ ] **No implementation detail:** Does it specify *what*, not *how*?
- [ ] **Testable:** Can you describe a verification check?
- [ ] **Preconditions ≤ 3:** If more, decompose or use a decision table.
- [ ] **Unwanted behaviors covered:** For each When-requirement, are failure modes addressed with If/Then?

---

## When NOT to Use EARS

EARS is not always the best format:

- **Mathematical relationships** — Use formulas instead of contorting them into EARS syntax.
- **Complex decision logic** — When behavior depends on 4+ interacting conditions, use a
  decision table alongside a simplified EARS requirement for each outcome.
- **Data format specifications** — Use schemas (JSON Schema, protobuf, XML Schema).
- **Timing diagrams** — Use sequence diagrams or timing notation.
- **Visual/layout requirements** — Use wireframes or mockups.

In these cases, write a simple EARS requirement that references the supplementary artifact:
"The system shall implement the decision logic defined in Table 3."
