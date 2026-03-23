import test from "node:test";
import assert from "node:assert/strict";

import {
  formatModelRef,
  nextAvailableSavePath,
  normalizeConfig,
  parseModelRef,
  slugifyTopic,
} from "../../pi/design-studio/extensions/config.ts";
import { composeFinalDesignDocument, parseCritique } from "../../pi/design-studio/extensions/debate-utils.ts";

test("parseModelRef supports provider/model:thinking shorthand", () => {
  const model = parseModelRef("anthropic/claude-sonnet-4-20250514:high");
  assert.deepEqual(model, {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    thinkingLevel: "high",
  });
  assert.equal(formatModelRef(model), "anthropic/claude-sonnet-4-20250514:high");
});

test("parseModelRef preserves model ids that already contain colons", () => {
  const model = parseModelRef("ollama/llama3.1:8b:low");
  assert.deepEqual(model, {
    provider: "ollama",
    model: "llama3.1:8b",
    thinkingLevel: "low",
  });
});

test("normalizeConfig defaults facilitator to architectA and clamps maxRounds", () => {
  const config = normalizeConfig({
    defaultProfile: "balanced",
    profiles: {
      balanced: {
        architectA: "anthropic/claude-sonnet-4-20250514:high",
        architectB: "openai/gpt-5:medium",
        maxRounds: 99,
      },
    },
  });

  assert.equal(config.defaultProfile, "balanced");
  assert.equal(config.profiles.balanced.maxRounds, 5);
  assert.deepEqual(config.profiles.balanced.facilitator, config.profiles.balanced.architectA);
});

test("slugifyTopic and nextAvailableSavePath produce stable design paths", async () => {
  const tmpDir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/design-studio-test-"));
  assert.equal(slugifyTopic("Notifications / Delivery System"), "notifications-delivery-system");
  const first = nextAvailableSavePath(tmpDir, "Notifications / Delivery System");
  assert.match(first, /notifications-delivery-system\.md$/);
  await import("node:fs/promises").then((fs) => fs.writeFile(first, "# test\n", "utf8"));
  const second = nextAvailableSavePath(tmpDir, "Notifications / Delivery System");
  assert.match(second, /notifications-delivery-system-2\.md$/);
});

test("slugifyTopic truncates long topics at word boundaries", () => {
  const longTopic = "build a comprehensive authentication system with OAuth2 SAML LDAP and custom JWT tokens that supports multi-tenancy and role-based access control with fine-grained permissions and detailed audit logging";
  const slug = slugifyTopic(longTopic);

  // Should be truncated to max 100 characters
  assert.ok(slug.length <= 100, `Slug length ${slug.length} exceeds 100 chars`);

  // Should end at a word boundary (not mid-word, so no trailing dash)
  assert.ok(!slug.endsWith("-"), "Slug should not end with a dash");

  // Should start with the beginning of the topic
  assert.ok(slug.startsWith("build-a-comprehensive-authentication"), "Slug should start with topic beginning");

  // Verify a very short topic doesn't get truncated
  assert.equal(slugifyTopic("short topic"), "short-topic");
});

test("parseCritique finds accept verdicts and composeFinalDesignDocument appends debate outcome", () => {
  const critique = parseCritique(`## Verdict: ACCEPT\n\n## Summary\nLooks good.`);
  assert.equal(critique.verdict, "ACCEPT");

  const doc = composeFinalDesignDocument({
    topic: "Notifications",
    briefMarkdown: "# Design Brief: Notifications",
    finalDraft: "# Design: Notifications\n\nCore draft",
    accepted: true,
    round: 2,
    maxRounds: 3,
    lastCritique: critique.raw,
    architectA: "anthropic/claude",
    architectB: "openai/gpt",
  });

  assert.match(doc, /## Debate Outcome/);
  assert.match(doc, /Consensus reached/);
  assert.match(doc, /Architect B accepted the design in round 2 of 3/);
  assert.match(doc, /## Design Brief Used For Debate/);
});
