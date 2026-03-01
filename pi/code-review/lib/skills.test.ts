import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  discoverReviewSkills,
  filterDiffByExtensions,
  filterSkills,
  getLanguageExtensions,
  getLanguages,
  getTypesForLanguage,
  type ReviewSkill,
} from "./skills.ts";

const sampleSkills: ReviewSkill[] = [
  {
    name: "gleam-code-review",
    language: "gleam",
    type: "code",
    path: path.join(os.tmpdir(), "gleam-code-review", "SKILL.md"),
  },
  {
    name: "gleam-security-review",
    language: "gleam",
    type: "security",
    path: path.join(os.tmpdir(), "gleam-security-review", "SKILL.md"),
  },
  {
    name: "fsharp-code-review",
    language: "fsharp",
    type: "code",
    path: path.join(os.tmpdir(), "fsharp-code-review", "SKILL.md"),
  },
];

test("getLanguages returns sorted, deduplicated languages", () => {
  const withDuplicate = [
    ...sampleSkills,
    {
      name: "gleam-test-review",
      language: "gleam",
      type: "test",
      path: "/tmp/gleam-test-review/SKILL.md",
    },
  ];

  assert.deepEqual(getLanguages(withDuplicate), ["fsharp", "gleam"]);
});

test("getTypesForLanguage returns sorted types for selected language", () => {
  assert.deepEqual(getTypesForLanguage(sampleSkills, "gleam"), [
    "code",
    "security",
  ]);
  assert.deepEqual(getTypesForLanguage(sampleSkills, "typescript"), []);
});

test("getLanguages returns empty array for empty input", () => {
  assert.deepEqual(getLanguages([]), []);
});

test("getTypesForLanguage returns empty array for empty input", () => {
  assert.deepEqual(getTypesForLanguage([], "gleam"), []);
});

test("filterSkills filters by language when no type filter is provided", () => {
  const filtered = filterSkills(sampleSkills, "gleam");
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((skill) => skill.language === "gleam"));
});

test("filterSkills filters by language and type list", () => {
  const filtered = filterSkills(sampleSkills, "gleam", ["code", "test"]);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.name, "gleam-code-review");
});

test("getLanguageExtensions returns known extension lists and undefined for unknown", () => {
  assert.deepEqual(getLanguageExtensions("typescript"), [
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
  ]);
  assert.deepEqual(getLanguageExtensions("gleam"), [".gleam"]);
  assert.equal(getLanguageExtensions("unknown-language"), undefined);
});

// ── Diff-fixture constants ────────────────────────────────────────────────
//
// Shared file-level diff sections reused across `filterDiffByExtensions`
// tests.  Each section ends with a trailing blank line so that multiple
// sections can be concatenated directly to form a valid unified diff.
// `filterDiffByExtensions` normalises its output to a single trailing newline
// via `trimEnd() + "\n"`, so the trailing blank line is transparent to
// callers that check the exact filtered result.

const GLEAM_DIFF_SECTION = `diff --git a/src/main.gleam b/src/main.gleam
index 0000000..1111111 100644
--- a/src/main.gleam
+++ b/src/main.gleam
@@ -1 +1 @@
-io.println("hello")
+io.println("hello, world")

`;

const README_DIFF_SECTION = `diff --git a/README.md b/README.md
index 0000000..1111111 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new

`;

const TS_A_DIFF_SECTION = `diff --git a/src/a.ts b/src/a.ts
index 0000000..1111111 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-export const a = 1
+export const a = 2

`;

const TS_B_DIFF_SECTION = `diff --git a/src/b.ts b/src/b.ts
index 0000000..1111111 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-export const b = 1
+export const b = 2

`;

/**
 * Build a minimal but structurally valid unified diff string containing one
 * section per supplied file path.  Each section has exactly the fields that
 * `filterDiffByExtensions` inspects (the `diff --git a/… b/…` header line),
 * so the helper avoids duplicating raw diff text across multiple test cases.
 */
function buildDiff(...filePaths: string[]): string {
  return filePaths
    .map(
      (p) =>
        `diff --git a/${p} b/${p}\n` +
        `index 0000000..1111111 100644\n` +
        `--- a/${p}\n` +
        `+++ b/${p}\n` +
        `@@ -1 +1 @@\n` +
        `-old\n` +
        `+new\n` +
        `\n`,
    )
    .join("");
}

test("filterDiffByExtensions keeps only matching file sections", () => {
  const diff = GLEAM_DIFF_SECTION + README_DIFF_SECTION;
  const filtered = filterDiffByExtensions(diff, [".gleam"]);

  assert.ok(filtered);
  assert.match(filtered!, /src\/main\.gleam/);
  assert.doesNotMatch(filtered!, /README\.md/);
});

test("filterDiffByExtensions returns null when no files match", () => {
  assert.equal(filterDiffByExtensions(README_DIFF_SECTION, [".ts"]), null);
});

test("filterDiffByExtensions returns full diff when all files match", () => {
  const diff = TS_A_DIFF_SECTION + TS_B_DIFF_SECTION;
  const filtered = filterDiffByExtensions(diff, [".ts"]);

  assert.equal(filtered, diff.trimEnd() + "\n");
});

test("filterDiffByExtensions keeps files matching any of several extensions", () => {
  const diff = buildDiff("src/a.ts", "src/b.gleam", "README.md");
  const filtered = filterDiffByExtensions(diff, [".ts", ".gleam"]);

  assert.ok(filtered, "expected a non-null result");
  assert.match(filtered!, /src\/a\.ts/);
  assert.match(filtered!, /src\/b\.gleam/);
  assert.doesNotMatch(filtered!, /README\.md/);
});

test("discoverReviewSkills finds review skills in a temporary directory", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-discovery-"));

  try {
    const matching = ["gleam-code-review", "fsharp-security-review"];
    const ignored = ["not-a-review"];

    for (const dir of matching) {
      const full = path.join(tempRoot, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, "SKILL.md"), `# ${dir}\n`);
    }

    for (const dir of ignored) {
      const full = path.join(tempRoot, dir);
      fs.mkdirSync(full, { recursive: true });
      fs.writeFileSync(path.join(full, "SKILL.md"), `# ${dir}\n`);
    }

    const skills = discoverReviewSkills([tempRoot]);

    assert.equal(skills.length, 2);

    const byName = new Map(skills.map((s) => [s.name, s]));

    const gleam = byName.get("gleam-code-review");
    assert.ok(gleam);
    assert.equal(gleam.language, "gleam");
    assert.equal(gleam.type, "code");
    assert.equal(gleam.path, path.join(tempRoot, "gleam-code-review", "SKILL.md"));

    const fsharp = byName.get("fsharp-security-review");
    assert.ok(fsharp);
    assert.equal(fsharp.language, "fsharp");
    assert.equal(fsharp.type, "security");
    assert.equal(fsharp.path, path.join(tempRoot, "fsharp-security-review", "SKILL.md"));
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverReviewSkills ignores directories that lack SKILL.md", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skills-missing-skillmd-"));

  try {
    const incomplete = path.join(tempRoot, "elm-test-review");
    fs.mkdirSync(incomplete, { recursive: true });

    const skills = discoverReviewSkills([tempRoot]);
    assert.deepEqual(skills, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("discoverReviewSkills aggregates skills from multiple roots", () => {
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), "skills-multi-1-"));
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "skills-multi-2-"));

  try {
    const gleamDir = path.join(root1, "gleam-code-review");
    fs.mkdirSync(gleamDir, { recursive: true });
    fs.writeFileSync(path.join(gleamDir, "SKILL.md"), "# gleam-code-review\n");

    const fsharpDir = path.join(root2, "fsharp-test-review");
    fs.mkdirSync(fsharpDir, { recursive: true });
    fs.writeFileSync(path.join(fsharpDir, "SKILL.md"), "# fsharp-test-review\n");

    const skills = discoverReviewSkills([root1, root2]);

    assert.equal(skills.length, 2);

    const byName = new Map(skills.map((s) => [s.name, s]));
    assert.ok(byName.has("gleam-code-review"), "expected skill from root1");
    assert.equal(
      byName.get("gleam-code-review")?.path,
      path.join(root1, "gleam-code-review", "SKILL.md"),
    );
    assert.ok(byName.has("fsharp-test-review"), "expected skill from root2");
    assert.equal(
      byName.get("fsharp-test-review")?.path,
      path.join(root2, "fsharp-test-review", "SKILL.md"),
    );
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test("discoverReviewSkills returns skills from earlier roots before later roots", () => {
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), "skills-order-1-"));
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "skills-order-2-"));

  try {
    // root1 gets fsharp, root2 gets gleam.  The result must respect the root
    // array order rather than the alphabetical order of the skill names
    // ("fsharp" sorts before "gleam", so the root order and name order happen
    // to agree here, but the path assertions confirm which root contributed each
    // entry).
    const fsharpDir = path.join(root1, "fsharp-test-review");
    fs.mkdirSync(fsharpDir, { recursive: true });
    fs.writeFileSync(path.join(fsharpDir, "SKILL.md"), "# fsharp-test-review\n");

    const gleamDir = path.join(root2, "gleam-code-review");
    fs.mkdirSync(gleamDir, { recursive: true });
    fs.writeFileSync(path.join(gleamDir, "SKILL.md"), "# gleam-code-review\n");

    const skills = discoverReviewSkills([root1, root2]);

    assert.equal(skills.length, 2);
    // First entry must come from root1.
    assert.equal(skills[0]?.name, "fsharp-test-review");
    assert.equal(skills[0]?.path, path.join(root1, "fsharp-test-review", "SKILL.md"));
    // Second entry must come from root2.
    assert.equal(skills[1]?.name, "gleam-code-review");
    assert.equal(skills[1]?.path, path.join(root2, "gleam-code-review", "SKILL.md"));
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

test("discoverReviewSkills includes a skill from every root even when the name is the same", () => {
  // The implementation does not deduplicate by name across roots: a skill that
  // appears under two different roots produces two entries, each with its own
  // path.  This behaviour is documented here so that any future change to add
  // deduplication is a deliberate, tested decision rather than an accidental
  // side-effect.
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), "skills-dup-1-"));
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "skills-dup-2-"));

  try {
    for (const root of [root1, root2]) {
      const dir = path.join(root, "gleam-code-review");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "SKILL.md"), "# gleam-code-review\n");
    }

    const skills = discoverReviewSkills([root1, root2]);

    assert.equal(skills.length, 2, "both roots should contribute an entry");
    assert.ok(
      skills.every((s) => s.name === "gleam-code-review"),
      "both entries should share the same name",
    );
    // root1's entry must appear before root2's.
    assert.equal(skills[0]?.path, path.join(root1, "gleam-code-review", "SKILL.md"));
    assert.equal(skills[1]?.path, path.join(root2, "gleam-code-review", "SKILL.md"));
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});
