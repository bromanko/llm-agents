/**
 * Write/edit tool_result interceptor for LSP diagnostics and formatting.
 *
 * After a write or edit tool completes, this interceptor:
 * 1. Sends didOpen/didChange to the relevant LSP server
 * 2. Waits for diagnostics (up to a timeout)
 * 3. Optionally applies formatting and rewrites the file
 * 4. Appends a deterministic diagnostics block to the tool result
 *
 * A recursion guard prevents infinite loops when formatting triggers
 * another tool_result event.
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { fileUri } from "./lsp-client.ts";
import type { ManagedServer } from "./server-manager.ts";

// --- Types ---

/** Minimal diagnostic shape from LSP. */
interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
}

/** Tool result event shape from pi's tool_result event. */
export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  result: string;
}

/** Dependencies injected into the interceptor factory. */
export interface InterceptorDeps {
  resolveServerForFile: (filePath: string) => string | null;
  getServerDiagnostics: (serverName: string, uri: string) => LspDiagnostic[];
  getServerName: (serverName: string) => string;
  ensureServerForFile: (filePath: string) => Promise<ManagedServer | null>;
  formatFile: (filePath: string, serverName: string) => Promise<string | null>;
  formatOnWrite: boolean;
  diagnosticsOnWrite: boolean;
  autoCodeActions: boolean;
  diagnosticsTimeoutMs: number;
}

/** Type for the interceptor function. */
export type ToolResultInterceptor = (
  event: ToolResultEvent,
) => Promise<{ result: string } | undefined>;

// --- Diagnostics formatter ---

/**
 * Format a diagnostics block for appending to tool results.
 *
 * Format:
 *   [server-name] N issue(s):
 *     path:line:column — message
 *
 * Returns empty string when there are no diagnostics.
 */
export function formatDiagnosticsBlock(
  serverName: string,
  filePath: string,
  diagnostics: LspDiagnostic[],
): string {
  if (diagnostics.length === 0) return "";

  const lines = [`[${serverName}] ${diagnostics.length} issue(s):`];
  for (const d of diagnostics) {
    // LSP positions are 0-indexed; display as 1-indexed
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    lines.push(`  ${filePath}:${line}:${col} — ${d.message}`);
  }
  return lines.join("\n");
}

// --- Language ID mapping ---

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

// --- Interceptor factory ---

/**
 * Create a tool_result interceptor that adds LSP diagnostics and formatting
 * to write/edit results.
 */
export function createToolResultInterceptor(deps: InterceptorDeps): ToolResultInterceptor {
  // Recursion guard: track {toolCallId, path} combinations currently being processed
  const activeGuard = new Set<string>();
  // Track document versions per file URI for incremental sync
  const documentVersions = new Map<string, number>();

  return async (event: ToolResultEvent): Promise<{ result: string } | undefined> => {
    // Only intercept write and edit
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    // Skip if both diagnostics and formatting are disabled
    if (!deps.diagnosticsOnWrite && !deps.formatOnWrite) {
      return undefined;
    }

    // Extract file path from input
    const filePath = typeof event.input.path === "string"
      ? path.resolve(event.input.path)
      : null;
    if (!filePath) return undefined;

    // Check if a server handles this file type
    const serverName = deps.resolveServerForFile(filePath);
    if (!serverName) return undefined;

    // Recursion guard
    const guardKey = `${event.toolCallId}:${filePath}`;
    if (activeGuard.has(guardKey)) {
      return undefined;
    }
    activeGuard.add(guardKey);

    try {
      // Ensure server is running
      const server = await deps.ensureServerForFile(filePath);
      if (!server) return undefined;

      const uri = fileUri(filePath);
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        return undefined;
      }

      // Send didOpen or didChange
      if (server.client) {
        const version = (documentVersions.get(uri) ?? 0) + 1;
        documentVersions.set(uri, version);

        if (version === 1) {
          server.client.notify("textDocument/didOpen", {
            textDocument: {
              uri,
              languageId: languageIdForFile(filePath),
              version,
              text: content,
            },
          });
        } else {
          server.client.notify("textDocument/didChange", {
            textDocument: { uri, version },
            contentChanges: [{ text: content }],
          });
        }
      }

      // Apply formatting if enabled
      if (deps.formatOnWrite) {
        const formatted = await deps.formatFile(filePath, serverName);
        if (formatted !== null && formatted !== content) {
          fs.writeFileSync(filePath, formatted);
          content = formatted;

          // Notify server of the change
          if (server.client) {
            const version = (documentVersions.get(uri) ?? 0) + 1;
            documentVersions.set(uri, version);
            server.client.notify("textDocument/didChange", {
              textDocument: { uri, version },
              contentChanges: [{ text: content }],
            });
          }
        }
      }

      // Wait for diagnostics
      if (deps.diagnosticsOnWrite) {
        // Give the server a moment to process and return diagnostics
        await new Promise((resolve) => setTimeout(resolve, deps.diagnosticsTimeoutMs));

        const diagnostics = deps.getServerDiagnostics(serverName, uri);
        const block = formatDiagnosticsBlock(
          deps.getServerName(serverName),
          filePath,
          diagnostics,
        );

        if (block) {
          return { result: event.result + "\n\n" + block };
        }
      }

      return undefined;
    } finally {
      // Clean up guard after a short delay to handle immediate re-entry
      setTimeout(() => activeGuard.delete(guardKey), 100);
    }
  };
}
