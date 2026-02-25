import test from "node:test";
import assert from "node:assert/strict";

import { formatCommitMessage } from "./message.ts";

test("formatCommitMessage: formats header-only commit message", () => {
  const message = formatCommitMessage("fix", null, "fixed crash on startup", []);
  assert.equal(message, "fix: fixed crash on startup");
});

test("formatCommitMessage: includes scope and trims detail bullets", () => {
  const message = formatCommitMessage("feat", "commit", "added pipeline", [
    { text: "  Added model fallback   ", userVisible: false },
    { text: "", userVisible: false },
    { text: "   ", userVisible: false },
    { text: "Added changelog integration", userVisible: false },
  ]);

  assert.equal(
    message,
    [
      "feat(commit): added pipeline",
      "",
      "- Added model fallback",
      "- Added changelog integration",
    ].join("\n"),
  );
});

test("formatCommitMessage: omits body when all detail lines are empty/whitespace", () => {
  const message = formatCommitMessage("chore", null, "updated files", [
    { text: "   ", userVisible: false },
    { text: "", userVisible: false },
  ]);

  assert.equal(message, "chore: updated files");
});
