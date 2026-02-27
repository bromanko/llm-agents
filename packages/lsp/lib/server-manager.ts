/**
 * Server detection, routing, and lifecycle management for LSP servers.
 *
 * Responsibilities:
 * - Detect which configured servers have binaries available
 * - Route files to the correct server by extension
 * - Find project roots via root marker files
 * - Track running server instances (lazy start, idle shutdown)
 * - Provide language status for the `languages` action
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";

import type {
  LspServerDefinition,
  ResolvedLspConfig,
  LanguageStatus,
  ServerAvailability,
} from "./types.ts";
import { createLspClient, fileUri, type LspClient } from "./lsp-client.ts";

// --- Exported helpers ---

/**
 * Walk up from a file path looking for the nearest directory that contains
 * one of the given root marker files/dirs. Stops at `boundary` (inclusive).
 */
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

/**
 * Resolve a server binary, checking project-local node_modules/.bin first,
 * then PATH.
 */
export async function resolveServerBinary(
  command: string,
  projectRoot: string,
): Promise<{ found: boolean; path?: string }> {
  // 1. Check project-local bin
  const localBin = path.join(projectRoot, "node_modules", ".bin", command);
  try {
    await fs.promises.access(localBin, fs.constants.X_OK);
    return { found: true, path: localBin };
  } catch {
    // Not found locally, continue
  }

  // 2. Check PATH via `which`
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

// --- Server Manager ---

/** A managed server instance (real or dry-run placeholder). */
export interface ManagedServer {
  name: string;
  client: LspClient | null;
  rootUri: string;
  lastActivity: number;
}

export interface ServerManagerOptions {
  /** When true, skip actually spawning processes. Used for unit tests. */
  dryRun?: boolean;
}

export interface ServerManager {
  /** Detect which servers have available binaries. */
  detectServers(): Promise<void>;
  /** Find the server name that should handle a given file, or null. */
  resolveServerForFile(filePath: string): string | null;
  /** Ensure a server is running for the given file (lazy start). Returns null if no server matches. */
  ensureServerForFile(filePath: string): Promise<ManagedServer | null>;
  /** List language/server statuses. */
  listLanguagesStatus(): LanguageStatus[];
  /** Shut down servers idle longer than the configured timeout. */
  shutdownIdleServers(now?: number): Promise<void>;
  /** Shut down all running servers. */
  shutdownAll(): Promise<void>;
  /** Get a running managed server by name. */
  getRunningServer(name: string): ManagedServer | undefined;
}

interface DetectedServer {
  definition: LspServerDefinition;
  binaryPath: string | undefined;
  availability: ServerAvailability;
}

export function createServerManager(
  config: ResolvedLspConfig,
  cwd: string,
  options: ServerManagerOptions = {},
): ServerManager {
  const detected = new Map<string, DetectedServer>();
  const running = new Map<string, ManagedServer>();

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
      const serverName = manager.resolveServerForFile(filePath);
      if (!serverName) return null;

      // Check if already running
      const existingServer = running.get(serverName);
      if (existingServer) {
        existingServer.lastActivity = Date.now();
        return existingServer;
      }

      const server = detected.get(serverName);
      if (!server || !server.binaryPath) return null;

      if (options.dryRun) {
        // In dry-run mode, create a placeholder without spawning
        const managed: ManagedServer = {
          name: serverName,
          client: null,
          rootUri: fileUri(cwd),
          lastActivity: Date.now(),
        };
        running.set(serverName, managed);
        return managed;
      }

      // Spawn the real server
      const { spawn } = await import("node:child_process");
      const rootDir = findNearestRootMarker(filePath, server.definition.rootMarkers, cwd) ?? cwd;
      const proc = spawn(server.binaryPath, server.definition.args, {
        cwd: rootDir,
        stdio: ["pipe", "pipe", "pipe"],
      });

      if (!proc.stdin || !proc.stdout) {
        throw new Error(`Failed to spawn ${serverName}: no stdio`);
      }

      const client = createLspClient(proc.stdin, proc.stdout);
      const rootUri = fileUri(rootDir);

      // Initialize the LSP server
      await client.request("initialize", {
        processId: process.pid,
        rootUri,
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
        workspaceFolders: [{ uri: rootUri, name: path.basename(rootDir) }],
        ...(server.definition.initializationOptions
          ? { initializationOptions: server.definition.initializationOptions }
          : {}),
      });

      client.notify("initialized", {});

      // Send workspace settings if configured
      if (server.definition.settings) {
        client.notify("workspace/didChangeConfiguration", {
          settings: server.definition.settings,
        });
      }

      const managed: ManagedServer = {
        name: serverName,
        client,
        rootUri,
        lastActivity: Date.now(),
      };
      running.set(serverName, managed);
      return managed;
    },

    listLanguagesStatus(): LanguageStatus[] {
      const statuses: LanguageStatus[] = [];
      for (const [name, server] of detected) {
        let status: ServerAvailability = server.availability;
        // If the server is currently running, report that
        if (running.has(name) && status === "available") {
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

      for (const [name, server] of running) {
        if (currentTime - server.lastActivity >= timeoutMs) {
          if (server.client) {
            try {
              await server.client.request("shutdown", null, 5000);
              server.client.notify("exit", null);
            } catch {
              // Best effort
            }
            server.client.destroy();
          }
          running.delete(name);
        }
      }
    },

    async shutdownAll() {
      for (const [name, server] of running) {
        if (server.client) {
          try {
            await server.client.request("shutdown", null, 5000);
            server.client.notify("exit", null);
          } catch {
            // Best effort
          }
          server.client.destroy();
        }
        running.delete(name);
      }
    },

    getRunningServer(name: string): ManagedServer | undefined {
      return running.get(name);
    },
  };

  return manager;
}
