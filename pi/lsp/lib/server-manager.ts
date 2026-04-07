import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import type {
  LspServerDefinition,
  ResolvedLspConfig,
  LanguageStatus,
  ServerAvailability,
} from "./types.ts";
import { createLspClient, fileUri, type LspClient } from "./lsp-client.ts";

export function findNearestRootMarker(
  filePath: string,
  rootMarkers: string[],
  boundary: string,
): string | null {
  let dir = path.dirname(filePath);
  const boundaryNorm = path.resolve(boundary);

  while (true) {
    for (const marker of rootMarkers) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir || !dir.startsWith(boundaryNorm)) break;
    dir = parent;
  }

  return null;
}

export async function resolveServerBinary(
  command: string,
  projectRoot: string,
): Promise<{ found: boolean; path?: string }> {
  const localBin = path.join(projectRoot, "node_modules", ".bin", command);
  try {
    await fs.promises.access(localBin, fs.constants.X_OK);
    return { found: true, path: localBin };
  } catch {
    // Continue to PATH lookup.
  }

  return new Promise((resolve) => {
    execFile("which", [command], (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve({ found: false });
      } else {
        resolve({ found: true, path: stdout.trim() });
      }
    });
  });
}

interface ManagedDocumentState {
  version: number;
  text: string;
}

export interface ManagedServer {
  name: string;
  key: string;
  rootDir: string;
  rootUri: string;
  client: LspClient | null;
  lastActivity: number;
  documents: Map<string, ManagedDocumentState>;
}

interface SpawnedServerProcess {
  stdin: Writable | null;
  stdout: Readable | null;
}

export interface ServerManagerOptions {
  dryRun?: boolean;
  spawnProcess?: (command: string, args: string[], cwd: string) => Promise<SpawnedServerProcess> | SpawnedServerProcess;
  createClient?: (stdin: Writable, stdout: Readable) => LspClient;
}

export interface ServerManager {
  detectServers(): Promise<void>;
  resolveServerForFile(filePath: string): string | null;
  ensureServerForFile(filePath: string): Promise<ManagedServer | null>;
  listLanguagesStatus(): LanguageStatus[];
  shutdownIdleServers(now?: number): Promise<void>;
  shutdownAll(): Promise<void>;
  getRunningServerForFile(filePath: string): ManagedServer | undefined;
  getRunningServerByKey(key: string): ManagedServer | undefined;
  syncDocumentFromDisk(filePath: string): Promise<ManagedServer | null>;
  syncDocumentContent(filePath: string, content: string): Promise<ManagedServer | null>;
  saveDocument(server: ManagedServer, filePath: string): Promise<void>;
}

interface DetectedServer {
  definition: LspServerDefinition;
  binaryPath: string | undefined;
  availability: ServerAvailability;
}

interface ResolvedRuntimeTarget {
  serverName: string;
  definition: LspServerDefinition;
  binaryPath: string;
  rootDir: string;
  rootUri: string;
  key: string;
}

const EXT_TO_LANGUAGE_ID: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".rb": "ruby",
  ".java": "java",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".fs": "fsharp",
  ".elm": "elm",
  ".gleam": "gleam",
  ".lua": "lua",
  ".zig": "zig",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".sql": "sql",
};

function languageIdForFile(filePath: string): string {
  return EXT_TO_LANGUAGE_ID[path.extname(filePath)] ?? "plaintext";
}

function configurationForSection(settings: Record<string, unknown> | undefined, section: unknown): unknown {
  if (!settings) return null;
  if (typeof section !== "string" || !section) return settings;

  let current: unknown = settings;
  for (const part of section.split(".")) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current ?? null;
}

async function defaultSpawnProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<SpawnedServerProcess> {
  const { spawn } = await import("node:child_process");
  const proc = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
  };
}

export function createServerManager(
  config: ResolvedLspConfig,
  cwd: string,
  options: ServerManagerOptions = {},
): ServerManager {
  const detected = new Map<string, DetectedServer>();
  const running = new Map<string, ManagedServer>();
  const spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
  const createClient = options.createClient ?? createLspClient;

  function computeRootDir(filePath: string, definition: LspServerDefinition): string {
    return findNearestRootMarker(filePath, definition.rootMarkers, cwd) ?? cwd;
  }

  function runtimeKey(serverName: string, rootDir: string): string {
    return `${serverName}:${path.resolve(rootDir)}`;
  }

  function resolveRuntimeTarget(filePath: string): ResolvedRuntimeTarget | null {
    const resolvedPath = path.resolve(filePath);
    const serverName = manager.resolveServerForFile(resolvedPath);
    if (!serverName) return null;

    const server = detected.get(serverName);
    if (!server || !server.binaryPath) return null;

    const rootDir = computeRootDir(resolvedPath, server.definition);
    return {
      serverName,
      definition: server.definition,
      binaryPath: server.binaryPath,
      rootDir,
      rootUri: fileUri(rootDir),
      key: runtimeKey(serverName, rootDir),
    };
  }

  function touch(server: ManagedServer): ManagedServer {
    server.lastActivity = Date.now();
    return server;
  }

  function handleWorkspaceConfiguration(server: ManagedServer, definition: LspServerDefinition): void {
    if (!server.client) return;

    server.client.onRequest<{ items?: Array<{ section?: string }> }, unknown[]>(
      "workspace/configuration",
      async (params) => {
        const items = Array.isArray(params?.items) ? params.items : [];
        return items.map((item) => configurationForSection(definition.settings, item?.section));
      },
    );
  }

  async function shutdownServer(key: string, server: ManagedServer): Promise<void> {
    if (server.client) {
      try {
        await server.client.request("shutdown", null, 5000);
        server.client.notify("exit", null);
      } catch {
        // Best effort.
      }
      server.client.destroy();
    }
    running.delete(key);
  }

  async function syncDocument(server: ManagedServer, filePath: string, content: string): Promise<ManagedServer> {
    const resolvedPath = path.resolve(filePath);
    const uri = fileUri(resolvedPath);
    const previous = server.documents.get(uri);
    const nextVersion = (previous?.version ?? 0) + 1;

    if (!previous) {
      if (server.client) {
        server.client.notify("textDocument/didOpen", {
          textDocument: {
            uri,
            languageId: languageIdForFile(resolvedPath),
            version: nextVersion,
            text: content,
          },
        });
      }
      server.documents.set(uri, { version: nextVersion, text: content });
      return touch(server);
    }

    if (previous.text === content) {
      return touch(server);
    }

    if (server.client) {
      server.client.notify("textDocument/didChange", {
        textDocument: { uri, version: nextVersion },
        contentChanges: [{ text: content }],
      });
    }

    server.documents.set(uri, { version: nextVersion, text: content });
    return touch(server);
  }

  const manager: ServerManager = {
    async detectServers() {
      for (const serverDef of config.servers) {
        if (serverDef.disabled) {
          detected.set(serverDef.name, {
            definition: serverDef,
            binaryPath: undefined,
            availability: "disabled",
          });
          continue;
        }

        const resolution = await resolveServerBinary(serverDef.command, cwd);
        detected.set(serverDef.name, {
          definition: serverDef,
          binaryPath: resolution.path,
          availability: resolution.found ? "available" : "missing",
        });
      }
    },

    resolveServerForFile(filePath: string): string | null {
      const ext = path.extname(filePath);
      for (const [name, server] of detected) {
        if (server.availability === "disabled" || server.availability === "missing") continue;
        if (server.definition.fileTypes.includes(ext)) {
          return name;
        }
      }
      return null;
    },

    async ensureServerForFile(filePath: string): Promise<ManagedServer | null> {
      const target = resolveRuntimeTarget(filePath);
      if (!target) return null;

      const existing = running.get(target.key);
      if (existing) return touch(existing);

      if (options.dryRun) {
        const managed: ManagedServer = {
          name: target.serverName,
          key: target.key,
          rootDir: target.rootDir,
          rootUri: target.rootUri,
          client: null,
          lastActivity: Date.now(),
          documents: new Map(),
        };
        running.set(target.key, managed);
        return managed;
      }

      const proc = await spawnProcess(target.binaryPath, target.definition.args, target.rootDir);
      if (!proc.stdin || !proc.stdout) {
        throw new Error(`Failed to spawn ${target.serverName}: no stdio`);
      }

      const client = createClient(proc.stdin, proc.stdout);
      const managed: ManagedServer = {
        name: target.serverName,
        key: target.key,
        rootDir: target.rootDir,
        rootUri: target.rootUri,
        client,
        lastActivity: Date.now(),
        documents: new Map(),
      };

      handleWorkspaceConfiguration(managed, target.definition);

      await client.request("initialize", {
        processId: process.pid,
        rootUri: target.rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didSave: true },
            publishDiagnostics: { relatedInformation: true },
            formatting: {},
            codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: [] } } },
            hover: { contentFormat: ["plaintext", "markdown"] },
            definition: {},
            references: {},
            documentSymbol: {},
            rename: {},
            callHierarchy: {},
          },
          workspace: {
            workspaceFolders: true,
            symbol: {},
          },
        },
        workspaceFolders: [{ uri: target.rootUri, name: path.basename(target.rootDir) }],
        ...(target.definition.initializationOptions
          ? { initializationOptions: target.definition.initializationOptions }
          : {}),
      });

      client.notify("initialized", {});

      if (target.definition.settings) {
        client.notify("workspace/didChangeConfiguration", {
          settings: target.definition.settings,
        });
      }

      running.set(target.key, managed);
      return managed;
    },

    listLanguagesStatus(): LanguageStatus[] {
      const statuses: LanguageStatus[] = [];
      for (const [name, server] of detected) {
        let status: ServerAvailability = server.availability;
        if (
          status === "available" &&
          Array.from(running.values()).some((managed) => managed.name === name)
        ) {
          status = "running";
        }
        statuses.push({
          name,
          status,
          fileTypes: server.definition.fileTypes,
        });
      }
      return statuses;
    },

    async shutdownIdleServers(now?: number) {
      const currentTime = now ?? Date.now();
      const timeoutMs = config.idleTimeoutMinutes * 60 * 1000;

      for (const [key, server] of Array.from(running.entries())) {
        if (currentTime - server.lastActivity >= timeoutMs) {
          await shutdownServer(key, server);
        }
      }
    },

    async shutdownAll() {
      for (const [key, server] of Array.from(running.entries())) {
        await shutdownServer(key, server);
      }
    },

    getRunningServerForFile(filePath: string): ManagedServer | undefined {
      const target = resolveRuntimeTarget(filePath);
      if (!target) return undefined;
      return running.get(target.key);
    },

    getRunningServerByKey(key: string): ManagedServer | undefined {
      return running.get(key);
    },

    async syncDocumentFromDisk(filePath: string): Promise<ManagedServer | null> {
      let content: string;
      try {
        content = await fs.promises.readFile(path.resolve(filePath), "utf8");
      } catch {
        return null;
      }
      return manager.syncDocumentContent(filePath, content);
    },

    async syncDocumentContent(filePath: string, content: string): Promise<ManagedServer | null> {
      const server = await manager.ensureServerForFile(filePath);
      if (!server) return null;
      return syncDocument(server, filePath, content);
    },

    async saveDocument(server: ManagedServer, filePath: string): Promise<void> {
      const resolvedPath = path.resolve(filePath);
      const uri = fileUri(resolvedPath);
      if (server.documents.has(uri) && server.client) {
        server.client.notify("textDocument/didSave", {
          textDocument: { uri },
        });
        touch(server);
      }
    },
  };

  return manager;
}
