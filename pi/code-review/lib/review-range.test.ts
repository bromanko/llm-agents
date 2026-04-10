import test from "node:test";
import assert from "node:assert/strict";

import {
  gatherRangeDiff,
  parseReviewArgs,
  REVIEW_USAGE,
  sanitizeForDisplay,
  translateJjToGitRange,
  validateRange,
} from "./review-range.ts";

test("parseReviewArgs defaults range to @ when omitted", () => {
  const parsed = parseReviewArgs("gleam code security");

  assert.equal(parsed.error, undefined);
  assert.equal(parsed.language, "gleam");
  assert.deepEqual(parsed.types, ["code", "security"]);
  assert.equal(parsed.options.range, "@");
  assert.equal(parsed.options.fixLevel, undefined);
});

test("parseReviewArgs parses -r and --revisions", () => {
  const short = parseReviewArgs("gleam -r main..@");
  assert.equal(short.error, undefined);
  assert.equal(short.options.range, "main..@");

  const long = parseReviewArgs("gleam --revisions abc123 --fix high");
  assert.equal(long.error, undefined);
  assert.equal(long.options.range, "abc123");
  assert.equal(long.options.fixLevel, "high");
});

test("parseReviewArgs rejects missing range value", () => {
  const parsed = parseReviewArgs("gleam --revisions --fix high");

  assert.ok(parsed.error);
  assert.match(parsed.error!, /Missing value for --revisions/);
  assert.match(parsed.error!, new RegExp(REVIEW_USAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("parseReviewArgs parses --fix values", () => {
  for (const level of ["high", "medium", "low", "all"] as const) {
    const parsed = parseReviewArgs(`gleam --fix ${level}`);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.options.fixLevel, level);
  }
});

test("parseReviewArgs parses --report values", () => {
  for (const level of ["high", "medium", "low", "all"] as const) {
    const parsed = parseReviewArgs(`gleam --report ${level}`);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.options.reportLevel, level);
  }
});

test("parseReviewArgs rejects invalid --fix values", () => {
  const parsed = parseReviewArgs("gleam --fix urgent");

  assert.ok(parsed.error);
  assert.match(parsed.error!, /Invalid --fix level "urgent"/);
});

test("parseReviewArgs rejects invalid --report values", () => {
  const parsed = parseReviewArgs("gleam --report urgent");

  assert.ok(parsed.error);
  assert.match(parsed.error!, /Invalid --report level "urgent"/);
});

// --- Finding 15: unknown flags test ---

test("parseReviewArgs rejects unknown flags", () => {
  const parsed = parseReviewArgs("gleam --verbose");
  assert.ok(parsed.error);
  assert.match(parsed.error!, /Unknown flag: --verbose/);
});

// --- Finding 19: empty input returns undefined language ---

test("parseReviewArgs returns undefined language for empty input", () => {
  const parsed = parseReviewArgs("");
  assert.equal(parsed.language, undefined);
  assert.equal(parsed.error, undefined);
});

// --- Finding 2: validateRange tests ---

test("validateRange accepts valid revision ranges", () => {
  assert.equal(validateRange("@"), true);
  assert.equal(validateRange("main..@"), true);
  assert.equal(validateRange("abc123"), true);
  assert.equal(validateRange("main..HEAD"), true);
  assert.equal(validateRange("v1.0.0"), true);
  assert.equal(validateRange("HEAD~3"), true);
  assert.equal(validateRange("HEAD^"), true);
  assert.equal(validateRange("feature/branch"), true);
});

test("validateRange rejects dangerous strings", () => {
  assert.equal(validateRange("; rm -rf /"), false);
  assert.equal(validateRange("$(malicious)"), false);
  assert.equal(validateRange("--flag"), false);
  assert.equal(validateRange("-r"), false);
  assert.equal(validateRange("a b"), false);
  assert.equal(validateRange(""), false);
});

// --- Finding 11: sanitizeForDisplay tests ---

test("sanitizeForDisplay strips control characters and truncates", () => {
  assert.equal(sanitizeForDisplay("hello\x00world"), "helloworld");
  assert.equal(sanitizeForDisplay("a".repeat(200)), "a".repeat(100));
  assert.equal(sanitizeForDisplay("a".repeat(200), 50), "a".repeat(50));
  assert.equal(sanitizeForDisplay("normal text"), "normal text");
});

test("sanitizeForDisplay escapes HTML entities", () => {
  assert.equal(sanitizeForDisplay("<script>"), "&#60;script&#62;");
  assert.equal(sanitizeForDisplay('a&b"c\'d'), "a&#38;b&#34;c&#39;d");
  assert.equal(sanitizeForDisplay("<>"), "&#60;&#62;");
});

// --- translateJjToGitRange tests ---

test("translateJjToGitRange replaces standalone @ with HEAD", () => {
  assert.equal(translateJjToGitRange("@"), "HEAD");
});

test("translateJjToGitRange replaces @ in range start position", () => {
  assert.equal(translateJjToGitRange("@..main"), "HEAD..main");
});

test("translateJjToGitRange replaces @ in range end position", () => {
  assert.equal(translateJjToGitRange("main..@"), "main..HEAD");
});

test("translateJjToGitRange replaces @ in both positions", () => {
  assert.equal(translateJjToGitRange("@..@"), "HEAD..HEAD");
});

test("translateJjToGitRange leaves plain git ranges untouched", () => {
  assert.equal(translateJjToGitRange("main..HEAD"), "main..HEAD");
  assert.equal(translateJjToGitRange("abc123"), "abc123");
  assert.equal(translateJjToGitRange("HEAD~3"), "HEAD~3");
  assert.equal(translateJjToGitRange("v1.0.0"), "v1.0.0");
});

test("translateJjToGitRange does not replace @ embedded in other text", () => {
  // @ inside a longer token is not jj syntax
  assert.equal(translateJjToGitRange("user@branch"), "user@branch");
});

test("gatherRangeDiff prefers jj when jj command succeeds", async () => {
  const calls: Array<{ command: string; args: string[] | undefined }> = [];
  const pi = {
    async exec(command: string, args?: string[]) {
      calls.push({ command, args });
      if (command === "jj") {
        return {
          code: 0,
          stdout: "diff --git a/a.ts b/a.ts\n",
          stderr: "",
          killed: false,
        };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "should not run",
        killed: false,
      };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "main..@");

  assert.equal(result.source, "jj");
  assert.match(result.diff ?? "", /diff --git/);
  // Both jj and git run in parallel; jj result is preferred when it succeeds
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    command: "jj",
    args: ["diff", "-r", "main..@", "--git"],
  });
  // git receives translated range (@ → HEAD)
  assert.deepEqual(calls[1], {
    command: "git",
    args: ["diff", "main..HEAD"],
  });
});

test("gatherRangeDiff falls back to git when jj fails", async () => {
  const calls: Array<{ command: string; args: string[] | undefined }> = [];
  const pi = {
    async exec(command: string, args?: string[]) {
      calls.push({ command, args });
      if (command === "jj") {
        return { code: 1, stdout: "", stderr: "not a jj repo", killed: false };
      }
      return {
        code: 0,
        stdout: "diff --git a/b.ts b/b.ts\n",
        stderr: "",
        killed: false,
      };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "main..HEAD");

  assert.equal(result.source, "git");
  assert.match(result.diff ?? "", /diff --git/);
  assert.deepEqual(calls.map((c) => [c.command, c.args]), [
    ["jj", ["diff", "-r", "main..HEAD", "--git"]],
    ["git", ["diff", "main..HEAD"]],
  ]);
});

test("gatherRangeDiff uses git show for single revision ranges", async () => {
  const calls: Array<{ command: string; args: string[] | undefined }> = [];
  const pi = {
    async exec(command: string, args?: string[]) {
      calls.push({ command, args });
      if (command === "jj") {
        return { code: 1, stdout: "", stderr: "not jj", killed: false };
      }
      return { code: 0, stdout: "diff --git ...", stderr: "", killed: false };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "abc123");

  assert.equal(result.source, "git");
  assert.deepEqual(calls[1], {
    command: "git",
    args: ["show", "--format=", "--patch", "abc123"],
  });
});

test("gatherRangeDiff returns deterministic error when jj and git fail", async () => {
  const pi = {
    async exec(command: string) {
      if (command === "jj") {
        return {
          code: 1,
          stdout: "",
          stderr: "no jj repo",
          killed: false,
        };
      }
      return {
        code: 1,
        stdout: "",
        stderr: "bad revision",
        killed: false,
      };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "bad..range");

  assert.equal(result.diff, null);
  assert.equal(result.source, null);
  assert.ok(result.error);
  assert.match(result.error!, /Could not gather diff for range "bad..range"/);
  assert.match(result.error!, /jj diff -r bad..range --git/);
  assert.match(result.error!, /git diff bad..range/);
});

// --- Finding 2: gatherRangeDiff rejects invalid ranges ---

test("gatherRangeDiff rejects invalid range with disallowed characters", async () => {
  const pi = {
    async exec() {
      throw new Error("should not be called");
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "; rm -rf /");

  assert.equal(result.diff, null);
  assert.equal(result.source, null);
  assert.ok(result.error);
  assert.match(result.error!, /Invalid range/);
  assert.match(result.error!, /disallowed characters/);
});

// --- Finding 16: gatherRangeDiff with @ range via git fallback ---

test("gatherRangeDiff with @ range falls back to git diff HEAD", async () => {
  const calls: Array<{ command: string; args: string[] | undefined }> = [];
  const pi = {
    async exec(command: string, args?: string[]) {
      calls.push({ command, args });
      if (command === "jj") {
        return { code: 1, stdout: "", stderr: "not a jj repo", killed: false };
      }
      return {
        code: 0,
        stdout: "diff --git a/file.ts b/file.ts\n",
        stderr: "",
        killed: false,
      };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "@");

  assert.equal(result.source, "git");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    command: "git",
    args: ["diff", "HEAD"],
  });
});

test("gatherRangeDiff with main..@ translates to git diff main..HEAD", async () => {
  const calls: Array<{ command: string; args: string[] | undefined }> = [];
  const pi = {
    async exec(command: string, args?: string[]) {
      calls.push({ command, args });
      if (command === "jj") {
        return { code: 1, stdout: "", stderr: "not a jj repo", killed: false };
      }
      return {
        code: 0,
        stdout: "diff --git a/file.ts b/file.ts\n",
        stderr: "",
        killed: false,
      };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp/repo" }, "main..@");

  assert.equal(result.source, "git");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1], {
    command: "git",
    args: ["diff", "main..HEAD"],
  });
});

// --- Finding 17: gatherRangeDiff returns null diff when jj succeeds with empty output ---

test("gatherRangeDiff returns null diff when jj succeeds with empty output", async () => {
  const pi = {
    async exec() {
      return { code: 0, stdout: "  \n", stderr: "", killed: false };
    },
  };

  const result = await gatherRangeDiff(pi, { cwd: "/tmp" }, "@");

  assert.equal(result.diff, null);
  assert.equal(result.source, "jj");
  assert.equal(result.error, undefined);
});

// --- Finding 14: git fallback with empty output ---

test("gatherRangeDiff returns null diff when git succeeds with empty output", async () => {
  const pi = {
    async exec(command: string) {
      if (command === "jj") return { code: 1, stdout: "", stderr: "no jj", killed: false };
      return { code: 0, stdout: "  \n", stderr: "", killed: false };
    },
  };
  const result = await gatherRangeDiff(pi, { cwd: "/tmp" }, "@");
  assert.equal(result.diff, null);
  assert.equal(result.source, "git");
});

// --- Finding 15: --fix without a value ---

test("parseReviewArgs rejects --fix without a value", () => {
  const endOfInput = parseReviewArgs("gleam --fix");
  assert.ok(endOfInput.error);
  assert.match(endOfInput.error!, /Missing value for --fix/);

  const followedByFlag = parseReviewArgs("gleam --fix -r @");
  assert.ok(followedByFlag.error);
  assert.match(followedByFlag.error!, /Missing value for --fix/);
});

test("parseReviewArgs rejects --report without a value", () => {
  const endOfInput = parseReviewArgs("gleam --report");
  assert.ok(endOfInput.error);
  assert.match(endOfInput.error!, /Missing value for --report/);

  const followedByFlag = parseReviewArgs("gleam --report -r @");
  assert.ok(followedByFlag.error);
  assert.match(followedByFlag.error!, /Missing value for --report/);
});

test("parseReviewArgs rejects using --fix and --report together", () => {
  const parsed = parseReviewArgs("gleam --fix high --report all");

  assert.ok(parsed.error);
  assert.match(parsed.error!, /Cannot use --fix and --report together/);
});

// --- Finding 17: exec options (timeout and cwd) propagation ---

test("gatherRangeDiff passes timeout and cwd to exec", async () => {
  const calls: Array<{ command: string; args?: string[]; options?: unknown }> = [];
  const pi = {
    async exec(command: string, args?: string[], options?: unknown) {
      calls.push({ command, args, options });
      return { code: 0, stdout: "diff output", stderr: "", killed: false };
    },
  };
  await gatherRangeDiff(pi, { cwd: "/my/repo" }, "@");
  assert.deepEqual(calls[0]?.options, { timeout: 10000, cwd: "/my/repo" });
  assert.deepEqual(calls[1]?.options, { timeout: 10000, cwd: "/my/repo" });
});

// --- Finding 18: validateRange with path traversal sequences ---

test("validateRange allows double-dot ranges (documenting current behavior)", () => {
  // These pass because .. is valid in VCS range syntax
  assert.equal(validateRange("main..HEAD"), true);
  // Path traversal sequences also pass — this is a known limitation
  assert.equal(validateRange("../../etc/passwd"), true);
});

// --- Finding 19: killed process scenario ---

test("gatherRangeDiff treats killed process as failure", async () => {
  const pi = {
    async exec(command: string) {
      if (command === "jj") return { code: 1, stdout: "", stderr: "", killed: true };
      return { code: 1, stdout: "", stderr: "timeout", killed: true };
    },
  };
  const result = await gatherRangeDiff(pi, { cwd: "/tmp" }, "@");
  assert.equal(result.diff, null);
  assert.ok(result.error);
});
