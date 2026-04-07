import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { PassThrough } from "node:stream";

import {
  createServerManager,
  findNearestRootMarker,
  resolveServerBinary,
} from "../lib/server-manager.ts";
import type { LspClient } from "../lib/lsp-client.ts";
import type { LspDiagnostic, ResolvedLspConfig } from "../lib/types.ts";

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

interface RecordedNotification {
  method: string;
  params: unknown;
}

interface MockClientHarness {
  client: LspClient;
  events: string[];
  notifications: RecordedNotification[];
  requestHandlers: Map<string, (params: unknown) => unknown | Promise<unknown>>;
}

function createMockClientHarness(): MockClientHarness {
  const events: string[] = [];
  const notifications: RecordedNotification[] = [];
  const requestHandlers = new Map<string, (params: unknown) => unknown | Promise<unknown>>();
  const notificationListeners = new Map<string, Array<(params: unknown) => void>>();
  const diagnosticsListeners: Array<(uri: string, diagnostics: LspDiagnostic[]) => void> = [];

  const client: LspClient = {
    async request(method: string, params: unknown): Promise<unknown> {
      events.push(`request:${method}`);
      if (method === "initialize") {
        return { capabilities: {} };
      }
      if (method === "shutdown") {
        return null;
      }
      return { method, params };
    },

    notify(method: string, params: unknown): void {
      events.push(`notify:${method}`);
      notifications.push({ method, params });
      for (const listener of notificationListeners.get(method) ?? []) {
        listener(params);
      }
    },

    onDiagnostics(cb: (uri: string, diagnostics: LspDiagnostic[]) => void): void {
      diagnosticsListeners.push(cb);
    },

    onNotification(method: string, cb: (params: unknown) => void): void {
      const listeners = notificationListeners.get(method) ?? [];
      listeners.push(cb);
      notificationListeners.set(method, listeners);
    },

    onRequest<TParams = unknown, TResult = unknown>(
      method: string,
      cb: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      events.push(`onRequest:${method}`);
      requestHandlers.set(method, cb as (params: unknown) => unknown | Promise<unknown>);
    },

    destroy(): void {
      events.push("destroy");
    },
  };

  void diagnosticsListeners;

  return {
    client,
    events,
    notifications,
    requestHandlers,
  };
}

function createManagerWithMockClient(
  config: ResolvedLspConfig,
  cwd: string,
  harness: MockClientHarness,
) {
  return createServerManager(config, cwd, {
    spawnProcess: async () => ({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    }),
    createClient: () => harness.client,
  });
}

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
    assert.equal(root, path.join(tmpDir, "packages", "app"));
  } finally {
    cleanup();
  }
});

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
    const binDir = path.join(tmpDir, "node_modules", ".bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fakeBin = path.join(binDir, "test-lsp-server");
    fs.writeFileSync(fakeBin, "#!/bin/sh\necho ok");
    fs.chmodSync(fakeBin, 0o755);

    const result = await resolveServerBinary("test-lsp-server", tmpDir);
    assert.equal(result.found, true);
    assert.ok(result.path?.includes("node_modules/.bin"));
  } finally {
    cleanup();
  }
});

test("lazy start: ensureServerForFile does not start if no matching server", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const manager = createServerManager(makeConfig(), tmpDir, { dryRun: true });
    await manager.detectServers();
    assert.equal(manager.resolveServerForFile(path.join(tmpDir, "file.py")), null);
  } finally {
    cleanup();
  }
});

test("extension match routing by file extension", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const manager = createServerManager(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: ["--stdio"],
          fileTypes: [".ts", ".tsx", ".js", ".jsx"],
          rootMarkers: ["package.json", "tsconfig.json"],
        },
      ],
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    assert.equal(manager.resolveServerForFile(path.join(tmpDir, "index.ts")), "typescript-language-server");
    assert.equal(manager.resolveServerForFile(path.join(tmpDir, "App.jsx")), "typescript-language-server");
  } finally {
    cleanup();
  }
});

test("multiple-match precedence uses merged config order", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const manager = createServerManager(makeConfig({
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
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    assert.equal(manager.resolveServerForFile(path.join(tmpDir, "index.ts")), "first-ts-server");
  } finally {
    cleanup();
  }
});

test("disabled server is excluded from detection", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const manager = createServerManager(makeConfig({
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
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    assert.equal(manager.resolveServerForFile(path.join(tmpDir, "index.ts")), null);
  } finally {
    cleanup();
  }
});

test("languages status payload includes available, missing, and disabled", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}" });
  try {
    const manager = createServerManager(makeConfig({
      servers: [
        {
          name: "available-server",
          command: "node",
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
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    const statuses = manager.listLanguagesStatus();
    assert.equal(statuses.find((s) => s.name === "available-server")?.status, "available");
    assert.equal(statuses.find((s) => s.name === "missing-server")?.status, "missing");
    assert.equal(statuses.find((s) => s.name === "disabled-server")?.status, "disabled");
  } finally {
    cleanup();
  }
});

test("ensureServerForFile creates distinct servers for different roots", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "packages/app-one/package.json": "{}",
    "packages/app-one/src/index.ts": "export const one = 1;",
    "packages/app-two/package.json": "{}",
    "packages/app-two/src/index.ts": "export const two = 2;",
  });

  try {
    const manager = createServerManager(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    const firstFile = path.join(tmpDir, "packages", "app-one", "src", "index.ts");
    const secondFile = path.join(tmpDir, "packages", "app-two", "src", "index.ts");

    const first = await manager.ensureServerForFile(firstFile);
    const second = await manager.ensureServerForFile(secondFile);

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first?.key, second?.key);
    assert.notEqual(first?.rootDir, second?.rootDir);
    assert.equal(first?.rootDir, path.join(tmpDir, "packages", "app-one"));
    assert.equal(second?.rootDir, path.join(tmpDir, "packages", "app-two"));
  } finally {
    cleanup();
  }
});

test("getRunningServerForFile returns the correct root-scoped server", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "packages/a/package.json": "{}",
    "packages/a/src/index.ts": "export const a = 1;",
    "packages/b/package.json": "{}",
    "packages/b/src/index.ts": "export const b = 2;",
  });

  try {
    const manager = createServerManager(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    const firstFile = path.join(tmpDir, "packages", "a", "src", "index.ts");
    const secondFile = path.join(tmpDir, "packages", "b", "src", "index.ts");

    const first = await manager.ensureServerForFile(firstFile);
    const second = await manager.ensureServerForFile(secondFile);

    assert.equal(manager.getRunningServerForFile(firstFile)?.key, first?.key);
    assert.equal(manager.getRunningServerForFile(secondFile)?.key, second?.key);
    assert.notEqual(manager.getRunningServerForFile(firstFile)?.key, manager.getRunningServerForFile(secondFile)?.key);
  } finally {
    cleanup();
  }
});

test("syncDocumentContent opens once and changes on subsequent updates", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "src/index.ts": "const value = 1;",
  });

  try {
    const manager = createServerManager(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    const filePath = path.join(tmpDir, "src", "index.ts");
    const server = await manager.syncDocumentContent(filePath, "const value = 1;");
    assert.ok(server);
    assert.equal(server?.documents.size, 1);

    const uri = new URL(`file://${filePath}`).href;
    assert.equal(server?.documents.get(uri)?.version, 1);

    await manager.syncDocumentContent(filePath, "const value = 2;");
    assert.equal(server?.documents.get(uri)?.version, 2);

    await manager.syncDocumentContent(filePath, "const value = 2;");
    assert.equal(server?.documents.get(uri)?.version, 2, "unchanged content should not bump version");
  } finally {
    cleanup();
  }
});

test("workspace/configuration handler is registered before initialize and returns nested sections", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "src/index.ts": "export const value = 1;",
  });

  try {
    const harness = createMockClientHarness();
    const manager = createManagerWithMockClient(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
          settings: {
            typescript: {
              inlayHints: {
                variableTypes: true,
              },
            },
          },
        },
      ],
    }), tmpDir, harness);
    await manager.detectServers();

    const filePath = path.join(tmpDir, "src", "index.ts");
    const server = await manager.ensureServerForFile(filePath);
    assert.ok(server);

    assert.deepEqual(harness.events.slice(0, 3), [
      "onRequest:workspace/configuration",
      "request:initialize",
      "notify:initialized",
    ]);

    const configurationHandler = harness.requestHandlers.get("workspace/configuration");
    assert.ok(configurationHandler, "workspace/configuration handler should be registered");

    const result = await configurationHandler?.({
      items: [
        { section: "typescript.inlayHints" },
        { section: "typescript.missingSection" },
      ],
    });

    assert.deepEqual(result, [
      { variableTypes: true },
      null,
    ]);
  } finally {
    cleanup();
  }
});

test("saveDocument emits didSave for synchronized documents with the correct uri", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "src/index.ts": "export const value = 1;",
  });

  try {
    const harness = createMockClientHarness();
    const manager = createManagerWithMockClient(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, harness);
    await manager.detectServers();

    const filePath = path.join(tmpDir, "src", "index.ts");
    const server = await manager.syncDocumentContent(filePath, "export const value = 1;");
    assert.ok(server);

    await manager.saveDocument(server!, filePath);

    const didSave = harness.notifications.find((entry) => entry.method === "textDocument/didSave");
    assert.deepEqual(didSave, {
      method: "textDocument/didSave",
      params: {
        textDocument: {
          uri: fileURL(filePath),
        },
      },
    });
  } finally {
    cleanup();
  }
});

test("saveDocument does nothing for unsynchronized files", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "src/index.ts": "export const value = 1;",
  });

  try {
    const harness = createMockClientHarness();
    const manager = createManagerWithMockClient(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, harness);
    await manager.detectServers();

    const filePath = path.join(tmpDir, "src", "index.ts");
    const server = await manager.ensureServerForFile(filePath);
    assert.ok(server);

    await manager.saveDocument(server!, filePath);

    assert.equal(harness.notifications.some((entry) => entry.method === "textDocument/didSave"), false);
  } finally {
    cleanup();
  }
});

test("saveDocument after re-sync still targets the same document entry", async () => {
  const { tmpDir, cleanup } = createTmpProject({
    "package.json": "{}",
    "src/index.ts": "export const value = 1;",
  });

  try {
    const harness = createMockClientHarness();
    const manager = createManagerWithMockClient(makeConfig({
      servers: [
        {
          name: "typescript-language-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, harness);
    await manager.detectServers();

    const filePath = path.join(tmpDir, "src", "index.ts");
    const server = await manager.syncDocumentContent(filePath, "export const value = 1;");
    assert.ok(server);

    await manager.syncDocumentContent(filePath, "export const value = 2;");
    await manager.saveDocument(server!, filePath);

    const uri = fileURL(filePath);
    assert.equal(server?.documents.get(uri)?.version, 2);
    assert.equal(
      harness.notifications.filter((entry) => entry.method === "textDocument/didSave").length,
      1,
    );
    assert.deepEqual(harness.notifications.at(-1), {
      method: "textDocument/didSave",
      params: { textDocument: { uri } },
    });
  } finally {
    cleanup();
  }
});

test("idle shutdown clears servers and routing still works afterward", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}", "index.ts": "" });
  try {
    const manager = createServerManager(makeConfig({
      idleTimeoutMinutes: 0,
      servers: [
        {
          name: "node-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, { dryRun: true });
    await manager.detectServers();

    const filePath = path.join(tmpDir, "index.ts");
    const server = await manager.ensureServerForFile(filePath);
    assert.ok(server);
    await manager.shutdownIdleServers(Date.now());
    assert.equal(manager.getRunningServerForFile(filePath), undefined);
    assert.equal(manager.resolveServerForFile(filePath), "node-server");
  } finally {
    cleanup();
  }
});

test("full session shutdown cleans all running servers", async () => {
  const { tmpDir, cleanup } = createTmpProject({ "package.json": "{}", "index.ts": "" });
  try {
    const manager = createServerManager(makeConfig({
      servers: [
        {
          name: "node-server",
          command: "node",
          args: [],
          fileTypes: [".ts"],
          rootMarkers: ["package.json"],
        },
      ],
    }), tmpDir, { dryRun: true });
    await manager.detectServers();
    await manager.ensureServerForFile(path.join(tmpDir, "index.ts"));

    await assert.doesNotReject(() => manager.shutdownAll());
    assert.equal(manager.getRunningServerForFile(path.join(tmpDir, "index.ts")), undefined);
  } finally {
    cleanup();
  }
});

function fileURL(filePath: string): string {
  return new URL(`file://${filePath}`).href;
}
