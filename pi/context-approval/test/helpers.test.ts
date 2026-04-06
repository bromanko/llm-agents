import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  discoverContextFiles,
  isUserOwnedConfig,
  loadApprovals,
  saveApprovals,
  sha256,
  shortenPath,
} from "../lib/helpers.ts";

describe("sha256", () => {
  it("produces consistent hex digest", () => {
    assert.equal(
      sha256("hello"),
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("changes when content changes", () => {
    assert.notEqual(sha256("a"), sha256("b"));
  });

  it("handles empty string", () => {
    assert.equal(
      sha256(""),
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("handles unicode content", () => {
    const hash = sha256("こんにちは 🎉");
    assert.equal(typeof hash, "string");
    assert.equal(hash.length, 64);
  });
});

describe("shortenPath", () => {
  it("returns relative path when under cwd", () => {
    assert.equal(
      shortenPath("/home/user/project/AGENTS.md", "/home/user/project"),
      "AGENTS.md",
    );
  });

  it("returns tilde path when under home", () => {
    const result = shortenPath(
      join(homedir(), "Code/repo/AGENTS.md"),
      "/tmp/other",
    );
    assert.ok(
      result.startsWith("~/Code"),
      `Expected tilde path starting with ~/Code, got: ${result}`,
    );
  });

  it("returns absolute path otherwise", () => {
    assert.equal(shortenPath("/etc/AGENTS.md", "/home/user"), "/etc/AGENTS.md");
  });
});

describe("isUserOwnedConfig", () => {
  let previousDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "agent-dir-")));
    previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("returns true for files in agent dir", () => {
    writeFileSync(join(tempDir, "AGENTS.md"), "test");
    assert.equal(isUserOwnedConfig(join(tempDir, "AGENTS.md")), true);
  });

  it("returns false for files outside agent dir", () => {
    assert.equal(isUserOwnedConfig("/tmp/other/AGENTS.md"), false);
  });
});

describe("discoverContextFiles", () => {
  let previousDir: string | undefined;
  let globalDir: string;

  beforeEach(() => {
    globalDir = realpathSync(mkdtempSync(join(tmpdir(), "global-agent-")));
    previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = globalDir;
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("finds AGENTS.md walking up from cwd", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "discover-")));
    const sub = join(root, "sub");
    mkdirSync(sub);
    writeFileSync(join(root, "AGENTS.md"), "root content");
    writeFileSync(join(sub, "AGENTS.md"), "sub content");

    const files = await discoverContextFiles(sub);
    const paths = files.map((f) => f.path);

    assert.ok(
      paths.includes(join(root, "AGENTS.md")),
      "Should find root AGENTS.md",
    );
    assert.ok(
      paths.includes(join(sub, "AGENTS.md")),
      "Should find sub AGENTS.md",
    );

    // Root comes before sub (ancestors in root-first order)
    const rootIdx = paths.indexOf(join(root, "AGENTS.md"));
    const subIdx = paths.indexOf(join(sub, "AGENTS.md"));
    assert.ok(rootIdx < subIdx, "Root file should come before sub file");
  });

  it("includes global dir file first", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "discover-global-")));
    writeFileSync(join(globalDir, "AGENTS.md"), "global");
    writeFileSync(join(root, "AGENTS.md"), "root");

    const files = await discoverContextFiles(root);
    assert.ok(files.length >= 2, `Expected >=2 files, got ${files.length}`);
    assert.equal(files[0].path, join(globalDir, "AGENTS.md"));
    assert.equal(files[0].content, "global");
  });

  it("prefers AGENTS.md over CLAUDE.md", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "discover-prefer-")));
    writeFileSync(join(root, "AGENTS.md"), "agents");
    writeFileSync(join(root, "CLAUDE.md"), "claude");

    const files = await discoverContextFiles(root);
    const rootFiles = files.filter((f) => f.path.startsWith(root));
    assert.equal(rootFiles.length, 1);
    assert.equal(rootFiles[0].path, join(root, "AGENTS.md"));
  });

  it("finds CLAUDE.md when AGENTS.md absent", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "discover-claude-")),
    );
    writeFileSync(join(root, "CLAUDE.md"), "claude only");

    const files = await discoverContextFiles(root);
    const rootFiles = files.filter((f) => f.path.startsWith(root));
    assert.equal(rootFiles.length, 1);
    assert.equal(rootFiles[0].path, join(root, "CLAUDE.md"));
    assert.equal(rootFiles[0].content, "claude only");
  });

  it("returns empty array when no context files exist", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "discover-empty-")));
    const files = await discoverContextFiles(root);
    // Filter out global dir results (global dir has no files in this test)
    const nonGlobal = files.filter((f) => !f.path.startsWith(globalDir));
    assert.equal(nonGlobal.length, 0);
  });
});

describe("loadApprovals / saveApprovals", () => {
  let previousDir: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), "approvals-")));
    previousDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tempDir;
  });

  afterEach(() => {
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });

  it("returns empty object when file missing", async () => {
    assert.deepEqual(await loadApprovals(), {});
  });

  it("round-trips correctly", async () => {
    const store = {
      "/tmp/test": { hash: "abc", approvedAt: "2026-01-01" },
    };
    await saveApprovals(store);
    assert.deepEqual(await loadApprovals(), store);
  });

  it("returns empty object on corrupt JSON", async () => {
    writeFileSync(join(tempDir, "context-approvals.json"), "NOT JSON{{{");
    assert.deepEqual(await loadApprovals(), {});
  });

  it("returns empty object on invalid shape (array)", async () => {
    writeFileSync(
      join(tempDir, "context-approvals.json"),
      JSON.stringify([1, 2, 3]),
    );
    assert.deepEqual(await loadApprovals(), {});
  });

  it("skips malformed records and keeps valid ones", async () => {
    const raw = {
      "/valid": { hash: "abc", approvedAt: "2026-01-01" },
      "/bad-hash": { hash: 123, approvedAt: "2026-01-01" },
      "/missing-fields": { foo: "bar" },
    };
    writeFileSync(
      join(tempDir, "context-approvals.json"),
      JSON.stringify(raw),
    );
    const loaded = await loadApprovals();
    assert.deepEqual(loaded, {
      "/valid": { hash: "abc", approvedAt: "2026-01-01" },
    });
  });

  it("creates directory structure when it does not exist", async () => {
    const nested = join(tempDir, "deep", "nested", "dir");
    process.env.PI_CODING_AGENT_DIR = nested;
    const store = { "/tmp/test": { hash: "abc", approvedAt: "2026-01-01" } };
    await saveApprovals(store);
    assert.deepEqual(await loadApprovals(), store);
  });
});
