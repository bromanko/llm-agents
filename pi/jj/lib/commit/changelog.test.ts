import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectChangelogBoundaries,
  parseUnreleasedSection,
  applyChangelogEntries,
} from "./changelog.ts";

// ---------------------------------------------------------------------------
// detectChangelogBoundaries
// ---------------------------------------------------------------------------

test("detectChangelogBoundaries: discovers existing CHANGELOG.md for changed files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-detect-"));
  try {
    fs.writeFileSync(
      path.join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n",
    );
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "main.ts"), "");

    const boundaries = await detectChangelogBoundaries(dir, ["src/main.ts"]);
    assert.equal(boundaries.length, 1);
    assert.equal(
      boundaries[0].changelogPath,
      path.resolve(dir, "CHANGELOG.md"),
    );
    assert.deepStrictEqual(boundaries[0].files, ["src/main.ts"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChangelogBoundaries: skips files with no CHANGELOG.md in path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-none-"));
  try {
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "main.ts"), "");

    const boundaries = await detectChangelogBoundaries(dir, ["src/main.ts"]);
    assert.equal(boundaries.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChangelogBoundaries: never creates new CHANGELOG.md", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-nocreate-"));
  try {
    fs.mkdirSync(path.join(dir, "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pkg", "lib.ts"), "");

    await detectChangelogBoundaries(dir, ["pkg/lib.ts"]);

    // Verify no CHANGELOG.md was created anywhere
    assert.ok(!fs.existsSync(path.join(dir, "CHANGELOG.md")));
    assert.ok(!fs.existsSync(path.join(dir, "pkg", "CHANGELOG.md")));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChangelogBoundaries: discovers nearest CHANGELOG.md per package", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-nested-"));
  try {
    // Root changelog
    fs.writeFileSync(
      path.join(dir, "CHANGELOG.md"),
      "# Root\n\n## [Unreleased]\n",
    );
    // Package changelog
    fs.mkdirSync(path.join(dir, "packages", "foo", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "packages", "foo", "CHANGELOG.md"),
      "# Foo\n\n## [Unreleased]\n",
    );
    fs.writeFileSync(path.join(dir, "packages", "foo", "src", "lib.ts"), "");
    // File outside packages
    fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(dir, "scripts", "build.sh"), "");

    const boundaries = await detectChangelogBoundaries(dir, [
      "packages/foo/src/lib.ts",
      "scripts/build.sh",
    ]);

    assert.equal(boundaries.length, 2);

    // The package file should map to the package changelog
    const fooBoundary = boundaries.find((b) =>
      b.changelogPath.includes("packages/foo"),
    );
    assert.ok(fooBoundary);
    assert.deepStrictEqual(fooBoundary.files, ["packages/foo/src/lib.ts"]);

    // The scripts file should map to the root changelog
    const rootBoundary = boundaries.find(
      (b) => !b.changelogPath.includes("packages"),
    );
    assert.ok(rootBoundary);
    assert.deepStrictEqual(rootBoundary.files, ["scripts/build.sh"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("detectChangelogBoundaries: skips changelog files themselves", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "changelog-self-"));
  try {
    fs.writeFileSync(
      path.join(dir, "CHANGELOG.md"),
      "# Changelog\n\n## [Unreleased]\n",
    );

    const boundaries = await detectChangelogBoundaries(dir, ["CHANGELOG.md", "src/main.ts"]);
    // CHANGELOG.md itself should not be in any boundary's files
    for (const b of boundaries) {
      assert.ok(!b.files.includes("CHANGELOG.md"));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// parseUnreleasedSection
// ---------------------------------------------------------------------------

test("parseUnreleasedSection: parses standard [Unreleased] section", () => {
  const content = `# Changelog

## [Unreleased]

### Added
- New feature A
- New feature B

### Fixed
- Bug fix C

## [1.0.0] - 2026-01-01

### Added
- Initial release
`;

  const result = parseUnreleasedSection(content);
  assert.ok(result.startLine >= 0);
  assert.ok(result.endLine > result.startLine);
  assert.deepStrictEqual(result.entries["Added"], ["New feature A", "New feature B"]);
  assert.deepStrictEqual(result.entries["Fixed"], ["Bug fix C"]);
});

test("parseUnreleasedSection: throws when no [Unreleased] section exists", () => {
  const content = `# Changelog

## [1.0.0] - 2026-01-01

### Added
- Initial release
`;

  assert.throws(() => parseUnreleasedSection(content), /No \[Unreleased\]/);
});

test("parseUnreleasedSection: handles empty [Unreleased] section", () => {
  const content = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01
`;

  const result = parseUnreleasedSection(content);
  assert.deepStrictEqual(result.entries, {});
});

// ---------------------------------------------------------------------------
// applyChangelogEntries
// ---------------------------------------------------------------------------

test("applyChangelogEntries: adds entries under [Unreleased]", () => {
  const content = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01

### Added
- Initial release
`;

  const unreleased = parseUnreleasedSection(content);
  const updated = applyChangelogEntries(content, unreleased, {
    Added: ["New commit pipeline"],
    Fixed: ["Resolved parsing bug"],
  });

  assert.ok(updated.includes("### Added"));
  assert.ok(updated.includes("- New commit pipeline"));
  assert.ok(updated.includes("### Fixed"));
  assert.ok(updated.includes("- Resolved parsing bug"));
  // Existing content should still be there
  assert.ok(updated.includes("## [1.0.0]"));
});

test("applyChangelogEntries: merges with existing entries without duplicates", () => {
  const content = `# Changelog

## [Unreleased]

### Added
- Existing feature

## [1.0.0] - 2026-01-01
`;

  const unreleased = parseUnreleasedSection(content);
  const updated = applyChangelogEntries(content, unreleased, {
    Added: ["Existing feature", "New feature"],
  });

  // "Existing feature" should appear only once
  const matches = updated.match(/- Existing feature/g);
  assert.equal(matches?.length, 1);
  // "New feature" should be added
  assert.ok(updated.includes("- New feature"));
});

test("applyChangelogEntries: preserves changelog structure", () => {
  const content = `# Changelog

All notable changes will be documented here.

## [Unreleased]

## [1.0.0] - 2026-01-01

### Added
- Initial release
`;

  const unreleased = parseUnreleasedSection(content);
  const updated = applyChangelogEntries(content, unreleased, {
    Changed: ["Updated API endpoint"],
  });

  // Header should be preserved
  assert.ok(updated.includes("# Changelog"));
  assert.ok(updated.includes("All notable changes"));
  // Existing version should be preserved
  assert.ok(updated.includes("## [1.0.0]"));
  assert.ok(updated.includes("- Initial release"));
  // New entry should be present
  assert.ok(updated.includes("### Changed"));
  assert.ok(updated.includes("- Updated API endpoint"));
});

test("parse/apply can reuse a pre-split lines array", () => {
  const content = `# Changelog

## [Unreleased]

## [1.0.0] - 2026-01-01
`;
  const lines = content.split("\n");

  const unreleased = parseUnreleasedSection(lines);
  const updated = applyChangelogEntries(lines, unreleased, {
    Added: ["Reused pre-split lines"],
  });

  assert.ok(updated.includes("### Added"));
  assert.ok(updated.includes("- Reused pre-split lines"));
});
