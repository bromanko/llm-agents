import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { stripDeniedContextFiles, verifyStripping } from "../lib/prompt.ts";

// Helper to build a synthetic system prompt matching pi's format
function buildPrompt(
  contextFiles: Array<{ path: string; content: string }>,
  options?: { noSkills?: boolean },
): string {
  let prompt = "You are an expert coding assistant.\n\n";

  if (contextFiles.length > 0) {
    prompt += "# Project Context\n\n";
    prompt += "Project-specific instructions and guidelines:\n\n";
    for (const { path, content } of contextFiles) {
      prompt += `## ${path}\n\n${content}\n\n`;
    }
  }

  if (!options?.noSkills) {
    prompt +=
      "The following skills provide specialized instructions for specific tasks.\n";
  }
  prompt += "Current date: 2026-04-06\n";
  prompt += "Current working directory: /some/dir\n";

  return prompt;
}

describe("stripDeniedContextFiles", () => {
  it("strips a single denied file", () => {
    const prompt = buildPrompt([
      { path: "/home/user/AGENTS.md", content: "Do something useful." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/home/user/AGENTS.md"]),
    );

    assert.ok(
      !result.includes("## /home/user/AGENTS.md"),
      "Should not contain the denied file heading",
    );
    assert.ok(
      !result.includes("Do something useful."),
      "Should not contain the denied file content",
    );
    assert.ok(
      !result.includes("# Project Context"),
      "Should remove empty Project Context section",
    );
    assert.ok(
      result.includes("Current date:"),
      "Should preserve date line",
    );
  });

  it("strips one of two files", () => {
    const prompt = buildPrompt([
      { path: "/path/first/AGENTS.md", content: "First content." },
      { path: "/path/second/AGENTS.md", content: "Second content." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/path/first/AGENTS.md"]),
    );

    assert.ok(
      !result.includes("## /path/first/AGENTS.md"),
      "Should remove first file heading",
    );
    assert.ok(
      !result.includes("First content."),
      "Should remove first file content",
    );
    assert.ok(
      result.includes("## /path/second/AGENTS.md"),
      "Should keep second file heading",
    );
    assert.ok(
      result.includes("Second content."),
      "Should keep second file content",
    );
    assert.ok(
      result.includes("# Project Context"),
      "Should keep Project Context heading",
    );
  });

  it("strips all files and cleans up empty section", () => {
    const prompt = buildPrompt([
      { path: "/path/a/AGENTS.md", content: "Content A." },
      { path: "/path/b/AGENTS.md", content: "Content B." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/path/a/AGENTS.md", "/path/b/AGENTS.md"]),
    );

    assert.ok(
      !result.includes("# Project Context"),
      "Should remove empty Project Context section",
    );
    assert.ok(
      !result.includes("Content A."),
      "Should remove content A",
    );
    assert.ok(
      !result.includes("Content B."),
      "Should remove content B",
    );
    assert.ok(
      result.includes("You are an expert coding assistant."),
      "Should preserve preamble",
    );
    assert.ok(
      result.includes("The following skills"),
      "Should preserve skills section",
    );
    assert.ok(
      result.includes("Current date:"),
      "Should preserve date line",
    );
  });

  it("no-op when no paths are denied", () => {
    const prompt = buildPrompt([
      { path: "/home/user/AGENTS.md", content: "Some content." },
    ]);
    const result = stripDeniedContextFiles(prompt, new Set());
    assert.equal(result, prompt);
  });

  it("no-op when denied path is not in prompt", () => {
    const prompt = buildPrompt([
      { path: "/home/user/AGENTS.md", content: "Some content." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/completely/different/AGENTS.md"]),
    );
    assert.equal(result, prompt);
  });

  it("handles prompt with no Project Context section", () => {
    const prompt = buildPrompt([]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/some/AGENTS.md"]),
    );
    assert.equal(result, prompt);
  });

  it("handles context file as last section before date", () => {
    const prompt = buildPrompt(
      [{ path: "/home/user/AGENTS.md", content: "Last section." }],
      { noSkills: true },
    );
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/home/user/AGENTS.md"]),
    );

    assert.ok(
      !result.includes("Last section."),
      "Should strip the content",
    );
    assert.ok(
      result.includes("Current date:"),
      "Should preserve date line",
    );
  });

  it("does not produce triple newlines after stripping", () => {
    const prompt = buildPrompt([
      { path: "/path/a/AGENTS.md", content: "Content A." },
      { path: "/path/b/AGENTS.md", content: "Content B." },
      { path: "/path/c/AGENTS.md", content: "Content C." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/path/b/AGENTS.md"]),
    );

    assert.ok(
      !result.includes("\n\n\n"),
      "Should not contain triple newlines",
    );
    assert.ok(
      result.includes("Content A."),
      "Should keep A",
    );
    assert.ok(
      result.includes("Content C."),
      "Should keep C",
    );
  });

  it("handles content containing ## inside fenced code blocks", () => {
    const content =
      "Instructions\n\n```markdown\n## This is not a heading\n```\n\nMore instructions.";
    const prompt = buildPrompt([
      { path: "/path/a/AGENTS.md", content },
      { path: "/path/b/AGENTS.md", content: "Keep this." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/path/a/AGENTS.md"]),
    );
    assert.ok(
      !result.includes("Instructions"),
      "Should strip all of denied file content",
    );
    assert.ok(
      result.includes("Keep this."),
      "Should preserve approved file",
    );
  });

  it("correctly distinguishes paths that share a prefix", () => {
    const prompt = buildPrompt([
      { path: "/home/user/project/AGENTS.md", content: "Parent." },
      { path: "/home/user/project/sub/AGENTS.md", content: "Child." },
    ]);
    const result = stripDeniedContextFiles(
      prompt,
      new Set(["/home/user/project/AGENTS.md"]),
    );
    assert.ok(!result.includes("Parent."), "Should strip parent content");
    assert.ok(result.includes("Child."), "Should preserve child content");
  });
});

describe("verifyStripping", () => {
  it("returns empty array when all denied paths are gone", () => {
    const prompt = buildPrompt([
      { path: "/home/user/AGENTS.md", content: "Some content." },
    ]);
    const stripped = stripDeniedContextFiles(
      prompt,
      new Set(["/home/user/AGENTS.md"]),
    );
    const failed = verifyStripping(
      stripped,
      new Set(["/home/user/AGENTS.md"]),
    );
    assert.deepEqual(failed, []);
  });

  it("returns failed paths when stripping missed", () => {
    const prompt = buildPrompt([
      { path: "/home/user/AGENTS.md", content: "Some content." },
    ]);
    // Pass unmodified prompt — stripping was "skipped"
    const failed = verifyStripping(
      prompt,
      new Set(["/home/user/AGENTS.md"]),
    );
    assert.deepEqual(failed, ["/home/user/AGENTS.md"]);
  });
});
