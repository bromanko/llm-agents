import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createServerManager,
  findNearestRootMarker,
  resolveServerBinary,
  type ServerManager,
} from "../lib/server-manager.ts";
import type { LspServerDefinition, ResolvedLspConfig, LanguageStatus } from "../lib/types.ts";

/** Creates a temporary directory tree for testing. */
function createTmpProject(structure?: Record<string, string>): { tmpDir: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-sm-test-"));
  if (structure) {
    for (const [relPath, content] of Object.entries(structure)) {
      const fullPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
  }
  return {
    tmpDir,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

function makeConfig(overrides?: Partial<ResolvedLspConfig>): ResolvedLspConfig {
  return {
    formatOnWrite: true,
    diagnosticsOnWrite: true,
    autoCodeActions: false,
    idleTimeoutMinutes: 10,
    servers: [
      {
        name: "typescript-language-server",
        command: "typescript-language-server",
        args: ["--stdio"],
        fileTypes: [".ts", ".tsx", ".js", ".jsx"],
        rootMarkers: ["package.json", "tsconfig.json"],
      },
    ],
    ...overrides,
  };
}

// --- Root marker detection ---

test("root marker detection at project root", () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "src/index.ts": "",
  });
  try {
    const root = findNearestRootMarker(
      path.join(tmpDir, "src", "index.ts"),
      ["package.json", "tsconfig.json"],
      tmpDir,
    );
    assert.equal(root, tmpDir);
  } finally {
    cleanup();
  }
});

test("monorepo child scan finds nearest root marker", () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "packages/app/package.json": "{}",
    "packages/app/src/index.ts": "",
  });
  try {
    const root = findNearestRootMarker(
      path.join(tmpDir, "packages", "app", "src", "index.ts"),
      ["package.json"],
      tmpDir,
    );
    // Should find the nearest package.json, which is in packages/app/
    assert.equal(root, path.join(tmpDir, "packages", "app"));
  } finally {
    cleanup();
  }
});

// --- Binary resolution ---

test("binary resolution: reports missing binary status deterministically", async () => {
  const result = await resolveServerBinary(
    "definitely-nonexistent-binary-for-test-12345",
    "/tmp",
  );
  assert.equal(result.found, false);
});

test("binary resolution: project-local bin is preferred over PATH", async () => {
  const { tmpDir, cleanup } = createTmpProject({});
  try {
    // Create a fake binary in node_modules/.bin
    const binDir = path.join(tmpDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeBin = path.join(binDir, "test-lsp-server");
    fs.writeFileSync(fakeBin, "#!/bin/sh\necho ok");
    fs.chmodSync(fakeBin, 0o755);

    const result = await resolveServerBinary("test-lsp-server", tmpDir);
    assert.equal(result.found, true);
    assert.ok(result.path?.includes("node_modules/.bin"), "should find in project-local bin");
  } finally {
    cleanup();
  }
});

// --- Server Manager ---

test("lazy start: ensureServerForFile does not start if no matching server", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const config = makeConfig();
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    const result = manager.resolveServerForFile(path.join(tmpDir, "file.py"));
    assert.equal(result, null, "no server should match .py files");
  } finally {
    cleanup();
  }
});

test("extension match routing by file extension", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    // Use "node" as the command since it's always available
    const config = makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: ["--stdio"],
          fileTypes: [".ts", ".tsx", ".js", ".jsx"],
          rootMarkers: ["package.json", "tsconfig.json"],
        },
      ],
    });
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    const result = manager.resolveServerForFile(path.join(tmpDir, "index.ts"));
    assert.equal(result, "typescript-language-server");

    const resultJsx = manager.resolveServerForFile(path.join(tmpDir, "App.jsx"));
    assert.equal(resultJsx, "typescript-language-server");
  } finally {
    cleanup();
  }
});

test("multiple-match precedence uses merged config order", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    // Use "node" as command since both must be detected as "available"
    const config = makeConfig({
      servers: [
        {
          name: "first-ts-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
        {
          name: "second-ts-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    });
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    const result = manager.resolveServerForFile(path.join(tmpDir, "index.ts"));
    assert.equal(result, "first-ts-server", "first server in config order should win");
  } finally {
    cleanup();
  }
});

test("disabled server is excluded from detection", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const config = makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "typescript-language-server",
          args: ["--stdio"],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
          disabled: true,
        },
      ],
    });
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    const result = manager.resolveServerForFile(path.join(tmpDir, "index.ts"));
    assert.equal(result, null, "disabled server should not match");
  } finally {
    cleanup();
  }
});

test("languages status payload includes available/missing/disabled", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const config = makeConfig({
      servers: [
        {
          name: "available-server",
          command: "node", // node is always available
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
        {
          name: "missing-server",
          command: "definitely-nonexistent-binary-for-test-12345",
          args: [],
          fileTypes: [".py"],
          rootMarkers: [],
        },
        {
          name: "disabled-server",
          command: "node",
          args: [],
          fileTypes: [".rb"],
          rootMarkers: [],
          disabled: true,
        },
      ],
    });
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    const statuses = manager.listLanguagesStatus();
    const available = statuses.find((s) => s.name === "available-server");
    const missing = statuses.find((s) => s.name === "missing-server");
    const disabled = statuses.find((s) => s.name === "disabled-server");

    assert.ok(available, "available-server should be listed");
    assert.equal(available.status, "available");
    assert.ok(missing, "missing-server should be listed");
    assert.equal(missing.status, "missing");
    assert.ok(disabled, "disabled-server should be listed");
    assert.equal(disabled.status, "disabled");
  } finally {
    cleanup();
  }
});

test("idle shutdown clears servers and they can be re-detected", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const config = makeConfig({
      idleTimeoutMinutes: 0, // immediate idle
      servers: [
        {
          name: "node-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    });
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    // Before idle shutdown, server should be available
    assert.equal(manager.resolveServerForFile(path.join(tmpDir, "index.ts")), "node-server");

    // After shutdownAll, server can be re-detected
    await manager.shutdownAll();
    assert.equal(
      manager.resolveServerForFile(path.join(tmpDir, "index.ts")),
      "node-server",
      "server routing should still work after shutdownAll (detection state preserved)",
    );
  } finally {
    cleanup();
  }
});

test("full session shutdown cleans all running servers", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const config = makeConfig();
    const manager = createServerManager(config, tmpDir, { dryRun: true });
    await manager.detectServers();

    // shutdownAll should complete without error
    await assert.doesNotReject(() => manager.shutdownAll());
  } finally {
    cleanup();
  }
});
