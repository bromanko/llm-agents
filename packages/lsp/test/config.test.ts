import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { loadResolvedConfig } from "../lib/config.ts";
import type { ResolvedLspConfig, LspServerDefinition } from "../lib/types.ts";

/**
 * Creates a temporary directory structure for config tests.
 * Returns { tmpDir, cleanup } where tmpDir is the project root.
 */
function createTmpProject(): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-config-test-"));
  return {
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

test("loads defaults from defaults.json", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    const config = await loadResolvedConfig(tmpDir);
    // defaults.json defines typescript-language-server
    assert.ok(config.servers.length > 0, "should have at least one default server");
    const tsServer = config.servers.find((s) => s.name === "typescript-language-server");
    assert.ok(tsServer, "should include typescript-language-server");
    assert.ok(tsServer.fileTypes.includes(".ts"), "ts server should handle .ts");
    assert.ok(tsServer.fileTypes.includes(".tsx"), "ts server should handle .tsx");
    assert.ok(tsServer.fileTypes.includes(".js"), "ts server should handle .js");
    assert.ok(tsServer.fileTypes.includes(".jsx"), "ts server should handle .jsx");
    assert.ok(tsServer.rootMarkers.includes("package.json"), "should have package.json root marker");
    assert.ok(tsServer.rootMarkers.includes("tsconfig.json"), "should have tsconfig.json root marker");
  } finally {
    cleanup();
  }
});

test("merges user and project config with project winning", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    // Create a fake home dir with user config
    const fakeHome = path.join(tmpDir, "fakehome");
    fs.mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(
      path.join(fakeHome, ".pi", "agent", "lsp.json"),
      JSON.stringify({
        formatOnWrite: false,
        servers: {
          "typescript-language-server": { args: ["--user-flag"] },
        },
      }),
    );

    // Create project config that overrides formatOnWrite
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "lsp.json"),
      JSON.stringify({
        formatOnWrite: true,
        servers: {
          "typescript-language-server": { args: ["--project-flag"] },
        },
      }),
    );

    const config = await loadResolvedConfig(projectDir, fakeHome);
    // Project config wins over user config
    assert.equal(config.formatOnWrite, true);
    const tsServer = config.servers.find((s) => s.name === "typescript-language-server");
    assert.ok(tsServer);
    // Project args should win
    assert.deepEqual(tsServer.args, ["--project-flag"]);
  } finally {
    cleanup();
  }
});

test("disabled: true removes a default server", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "lsp.json"),
      JSON.stringify({
        servers: {
          "typescript-language-server": { disabled: true },
        },
      }),
    );

    const config = await loadResolvedConfig(projectDir);
    const tsServer = config.servers.find((s) => s.name === "typescript-language-server");
    assert.ok(!tsServer || tsServer.disabled === true, "ts server should be disabled or removed");
  } finally {
    cleanup();
  }
});

test("custom server entry is appended and routable by extension", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "lsp.json"),
      JSON.stringify({
        servers: {
          "custom-lsp": {
            command: "custom-lsp-server",
            args: ["--stdio"],
            fileTypes: [".custom"],
            rootMarkers: ["custom.config"],
          },
        },
      }),
    );

    const config = await loadResolvedConfig(projectDir);
    const customServer = config.servers.find((s) => s.name === "custom-lsp");
    assert.ok(customServer, "custom server should be present");
    assert.equal(customServer.command, "custom-lsp-server");
    assert.deepEqual(customServer.args, ["--stdio"]);
    assert.ok(customServer.fileTypes.includes(".custom"));
    assert.ok(customServer.rootMarkers.includes("custom.config"));
  } finally {
    cleanup();
  }
});

test("global defaults: formatOnWrite=true, diagnosticsOnWrite=true, autoCodeActions=false, idleTimeoutMinutes=10", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    const config = await loadResolvedConfig(tmpDir);
    assert.equal(config.formatOnWrite, true);
    assert.equal(config.diagnosticsOnWrite, true);
    assert.equal(config.autoCodeActions, false);
    assert.equal(config.idleTimeoutMinutes, 10);
  } finally {
    cleanup();
  }
});

test("server order is deterministic and preserved for match precedence", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "lsp.json"),
      JSON.stringify({
        servers: {
          "alpha-lsp": {
            command: "alpha-lsp",
            args: [],
            fileTypes: [".ts"],
            rootMarkers: [],
          },
          "beta-lsp": {
            command: "beta-lsp",
            args: [],
            fileTypes: [".ts"],
            rootMarkers: [],
          },
        },
      }),
    );

    const config = await loadResolvedConfig(projectDir);
    // The default ts server + two custom ones should preserve order
    const names = config.servers.map((s) => s.name);
    const alphaIdx = names.indexOf("alpha-lsp");
    const betaIdx = names.indexOf("beta-lsp");
    assert.ok(alphaIdx >= 0 && betaIdx >= 0, "both custom servers should exist");
    assert.ok(alphaIdx < betaIdx, "alpha-lsp should appear before beta-lsp (insertion order)");
  } finally {
    cleanup();
  }
});

test("invalid JSON returns deterministic parse error text", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(projectDir, ".pi", "lsp.json"), "{ invalid json }");

    await assert.rejects(
      () => loadResolvedConfig(projectDir),
      (err: Error) => {
        assert.ok(err.message.includes("lsp.json"), "error should mention the file");
        return true;
      },
    );
  } finally {
    cleanup();
  }
});

test("missing config files return defaults without throwing", async () => {
  const { tmpDir, cleanup } = createTmpProject();
  try {
    // Neither user nor project config exists — should fall back to defaults
    const config = await loadResolvedConfig(tmpDir, path.join(tmpDir, "nonexistent-home"));
    assert.ok(config.servers.length > 0, "should return default servers");
    assert.equal(config.formatOnWrite, true);
  } finally {
    cleanup();
  }
});
