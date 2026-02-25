import test from "node:test";
import assert from "node:assert/strict";

import { parseFindings } from "./parser.ts";

test("parses strict heading format with issue and suggestion", () => {
  const text = `### [HIGH] Missing input validation
**Issue:** User-controlled input reaches parser without validation.
**Suggestion:** Validate input with a strict schema before parsing.`;

  const findings = parseFindings(text, "test-skill");

  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0], {
    severity: "HIGH",
    title: "Missing input validation",
    file: undefined,
    category: undefined,
    issue: "User-controlled input reaches parser without validation.",
    suggestion: "Validate input with a strict schema before parsing.",
    effort: undefined,
    skill: "test-skill",
  });
});

test("parses multiple findings and preserves severities", () => {
  const text = `### [HIGH] SQL injection
Issue: Query uses string interpolation.
Suggestion: Use parameterized queries.

### [MEDIUM] Missing timeout
Issue: Network request has no timeout.
Suggestion: Add a bounded timeout.

### [LOW] Minor readability issue
Issue: Variable names are unclear.
Suggestion: Rename for clarity.`;

  const findings = parseFindings(text, "multi");

  assert.equal(findings.length, 3);
  assert.deepEqual(
    findings.map((f) => f.severity),
    ["HIGH", "MEDIUM", "LOW"],
  );
});

test("parses flexible heading style", () => {
  const text = `## HIGH: Dangerous eval usage
Issue: eval executes untrusted input.
Suggestion: Use a parser instead of eval.`;

  const findings = parseFindings(text, "flex");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "HIGH");
  assert.equal(findings[0]?.title, "Dangerous eval usage");
});

test("parses bullet-style heading", () => {
  const text = `- [medium] Missing null check
Issue: Possible null dereference in branch.
Suggestion: Guard against null before access.`;

  const findings = parseFindings(text, "bullet");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "MEDIUM");
});

test("maps severity synonyms to canonical severities", () => {
  const cases = [
    {
      text: `### [CRITICAL] Auth bypass
Issue: Token verification is skipped.
Suggestion: Enforce verification.`,
      expected: "HIGH",
    },
    {
      text: `## WARNING: Missing rate limit
Issue: Endpoint can be abused.
Suggestion: Add request throttling.`,
      expected: "MEDIUM",
    },
    {
      text: `## INFO: Logging detail
Issue: Missing contextual fields in logs.
Suggestion: Include request id and user id.`,
      expected: "LOW",
    },
  ] as const;

  for (const c of cases) {
    const findings = parseFindings(c.text, "sev");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, c.expected);
  }
});

test("extracts file field", () => {
  const text = `### [MEDIUM] Incorrect parsing branch
**File:** src/main.ts:42
Issue: Branch condition is inverted.
Suggestion: Swap true/false branches.`;

  const findings = parseFindings(text, "file-test");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.file, "src/main.ts:42");
});

test("extracts category field", () => {
  const text = `### [LOW] Missing CSP header
Category: security
Issue: Responses do not set CSP.
Suggestion: Add a default CSP header.`;

  const findings = parseFindings(text, "category-test");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.category, "security");
});

test("normalizes recognized effort values and ignores unknown ones", () => {
  // Canonical lowercase values → exact Effort type.
  for (const effort of ["trivial", "small", "medium", "large"] as const) {
    const text = `### [LOW] ${effort} effort test
Effort: ${effort}
Issue: Example issue.
Suggestion: Example suggestion.`;
    const findings = parseFindings(text, "effort-test");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.effort, effort);
  }

  // Near-valid inputs: the normaliser accepts recognised values written in
  // non-canonical form (wrong case, trailing whitespace) because it applies
  // trim() + toLowerCase() before matching.  These tests document and guard
  // that tolerance boundary.
  const upperCase = parseFindings(
    `### [LOW] Upper-case effort
Effort: LARGE
Issue: Example issue.
Suggestion: Example suggestion.`,
    "effort-test",
  );
  assert.equal(upperCase.length, 1);
  assert.equal(upperCase[0]?.effort, "large");

  const trailingSpace = parseFindings(
    `### [LOW] Trailing-space effort
Effort: medium 
Issue: Example issue.
Suggestion: Example suggestion.`,
    "effort-test",
  );
  assert.equal(trailingSpace.length, 1);
  assert.equal(trailingSpace[0]?.effort, "medium");

  // Genuinely unknown values: anything outside the recognised set must
  // produce undefined regardless of how plausible the string looks.
  for (const unknown of ["huge", "", "extra-large"]) {
    const findings = parseFindings(
      `### [LOW] Unknown effort
Effort: ${unknown}
Issue: Example issue.
Suggestion: Example suggestion.`,
      "effort-test",
    );
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.effort, undefined);
  }
});

test("captures multi-line issue and suggestion fields", () => {
  const text = `### [MEDIUM] Race condition under load
Issue:
- Concurrent writes can overwrite state.
- Retry loop has no jitter.
Suggestion:
- Add a compare-and-swap update.
- Add exponential backoff with jitter.`;

  const findings = parseFindings(text, "multiline");

  assert.equal(findings.length, 1);
  assert.equal(
    findings[0]?.issue,
    "Concurrent writes can overwrite state.\nRetry loop has no jitter.",
  );
  assert.equal(
    findings[0]?.suggestion,
    "Add a compare-and-swap update.\nAdd exponential backoff with jitter.",
  );
});

test("strips * bullet prefixes from multi-line fields the same as - bullets", () => {
  // LLMs frequently use * instead of - for bullet points.  The parser must
  // strip both markers so the resulting text is clean plain text.
  const text = `### [MEDIUM] Locking bug
Issue:
* Concurrent writes can overwrite state.
* Retry loop has no jitter.
Suggestion:
* Add a compare-and-swap update.
* Add exponential backoff with jitter.`;

  const findings = parseFindings(text, "multiline-star");

  assert.equal(findings.length, 1);
  assert.equal(
    findings[0]?.issue,
    "Concurrent writes can overwrite state.\nRetry loop has no jitter.",
  );
  assert.equal(
    findings[0]?.suggestion,
    "Add a compare-and-swap update.\nAdd exponential backoff with jitter.",
  );
});

test("strips numbered-list prefixes from multi-line fields", () => {
  // LLMs also produce ordered lists (1. 2. …).  The parser must strip the
  // digit-dot prefix just as it strips - and * bullets.
  const text = `### [HIGH] Connection exhaustion
Issue:
1. Connection pool is unbounded.
2. Idle connections are never reaped.
Suggestion:
1. Cap the pool size with a configurable limit.
2. Add an idle-timeout eviction policy.`;

  const findings = parseFindings(text, "multiline-numbered");

  assert.equal(findings.length, 1);
  assert.equal(
    findings[0]?.issue,
    "Connection pool is unbounded.\nIdle connections are never reaped.",
  );
  assert.equal(
    findings[0]?.suggestion,
    "Cap the pool size with a configurable limit.\nAdd an idle-timeout eviction policy.",
  );
});

test("parses structured input without headings", () => {
  const text = `Potential SQL injection risk
Issue: Query uses string interpolation.
Suggestion: Use parameterized queries.`;

  const findings = parseFindings(text, "fallback");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "MEDIUM");
  assert.equal(findings[0]?.title, "Potential SQL injection risk");
});

test("fallback: returns empty array when issue and suggestion content are both absent", () => {
  // The text passes the fallback admission check (contains "Issue:" and
  // "Suggestion:") but neither field has any extractable content.  The guard
  // `!issue && !suggestion && !file` should fire and produce no findings.
  const text = `Some finding title
Issue:
Suggestion:`;

  const findings = parseFindings(text, "fallback-empty");

  assert.deepEqual(findings, []);
});

test("fallback: severity stays MEDIUM when title line contains a severity word but has no heading marker", () => {
  // A plain first line like "HIGH: …" lacks a heading marker (##, -, *), so
  // `findHeadingStarts` does not recognise it as a heading and the fallback
  // path is taken with `heading === undefined`.  The severity word embedded in
  // the title must NOT be extracted from the title — severity should default
  // to "MEDIUM", not "HIGH".
  const text = `HIGH: Potential timing attack
Issue: Comparison is not constant-time.
Suggestion: Use a constant-time comparison function.`;

  const findings = parseFindings(text, "fallback-sev");

  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.severity, "MEDIUM");
  assert.match(findings[0]?.title ?? "", /timing attack/i);
});

test("returns empty array for unstructured/garbage input", () => {
  const findings = parseFindings("No issues found.", "skill");
  assert.deepEqual(findings, []);
});

test("skips findings that have no issue, suggestion, or file", () => {
  const text = `### [HIGH] Header only finding\nThis section has no structured content.`;
  const findings = parseFindings(text, "skill");
  assert.deepEqual(findings, []);
});

test("supports field name synonyms", () => {
  const text = `### [HIGH] Unsafe deserialization
Problem: Untrusted payload is deserialized directly.
Recommendation: Validate and whitelist allowed fields.`;

  const findings = parseFindings(text, "synonyms");

  assert.equal(findings.length, 1);
  assert.equal(
    findings[0]?.issue,
    "Untrusted payload is deserialized directly.",
  );
  assert.equal(
    findings[0]?.suggestion,
    "Validate and whitelist allowed fields.",
  );
});

test("propagates the skill name to every parsed finding", () => {
  const text = `### [LOW] Finding one
Issue: One.
Suggestion: Fix one.

### [MEDIUM] Finding two
Issue: Two.
Suggestion: Fix two.`;

  const findings = parseFindings(text, "skill-propagation");

  assert.equal(findings.length, 2);
  assert.ok(findings.every((f) => f.skill === "skill-propagation"));
});
