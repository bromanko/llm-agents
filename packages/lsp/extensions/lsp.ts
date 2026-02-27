/**
 * Pi LSP Extension — universal LSP diagnostics and code intelligence.
 *
 * Provides:
 * - Automatic diagnostics appended to write/edit tool results
 * - Optional format-on-write
 * - A single `lsp` tool for code intelligence actions
 * - Static system prompt hint when servers are detected
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";

import { loadResolvedConfig } from "../lib/config.ts";
import { createServerManager, type ServerManager } from "../lib/server-manager.ts";
import { createToolResultInterceptor, formatDiagnosticsBlock, type InterceptorDeps } from "../lib/interceptor.ts";
import { createLspToolDefinition } from "../lib/lsp-tool.ts";
import { fileUri, type LspClient } from "../lib/lsp-client.ts";
import type { ResolvedLspConfig, LanguageStatus } from "../lib/types.ts";

/** The canonical static prompt hint. */
const PROMPT_HINT =
  'Write/edit results include automatic LSP diagnostics and formatting. Use the lsp tool for code intelligence (action "languages" to list supported languages).';

/** Per-server diagnostics cache: serverName → (uri → diagnostics[]) */
type DiagnosticsCache = Map<string, Map<string, any[]>>;

export default function registerLspExtension(pi: ExtensionAPI): void {
  let serverManager: ServerManager | null = null;
  let config: ResolvedLspConfig | null = null;
  let diagnosticsCache: DiagnosticsCache = new Map();
  let hasDetectedServers = false;
  let cwd = process.cwd();
  let sessionCtx: any = null;

  // --- Helper: get/set diagnostics from cache ---

  function setDiagnostics(serverName: string, uri: string, diagnostics: any[]): void {
    let serverCache = diagnosticsCache.get(serverName);
    if (!serverCache) {
      serverCache = new Map();
      diagnosticsCache.set(serverName, serverCache);
    }
    serverCache.set(uri, diagnostics);
  }

  function getDiagnostics(serverName: string, uri: string): any[] {
    return diagnosticsCache.get(serverName)?.get(uri) ?? [];
  }

  // --- Helper: request formatting from LSP server ---

  async function formatFile(filePath: string, serverName: string): Promise<string | null> {
    if (!serverManager) return null;
    const server = serverManager.getRunningServer(serverName);
    if (!server?.client) return null;

    try {
      const uri = fileUri(filePath);
      const edits = await server.client.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: 2, insertSpaces: true },
      }, 5000) as any[] | null;

      if (!edits || edits.length === 0) return null;

      // Apply edits to produce formatted text
      let content = fs.readFileSync(filePath, "utf-8");
      // Sort edits in reverse order to apply from bottom to top
      const sorted = [...edits].sort((a, b) => {
        const lineDiff = b.range.start.line - a.range.start.line;
        return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
      });

      const lines = content.split("\n");
      for (const edit of sorted) {
        const startLine = edit.range.start.line;
        const startChar = edit.range.start.character;
        const endLine = edit.range.end.line;
        const endChar = edit.range.end.character;

        // Convert line/char to string offset
        let startOffset = 0;
        for (let i = 0; i < startLine && i < lines.length; i++) {
          startOffset += lines[i]!.length + 1; // +1 for \n
        }
        startOffset += startChar;

        let endOffset = 0;
        for (let i = 0; i < endLine && i < lines.length; i++) {
          endOffset += lines[i]!.length + 1;
        }
        endOffset += endChar;

        content = content.substring(0, startOffset) + edit.newText + content.substring(endOffset);
      }

      return content;
    } catch {
      return null;
    }
  }

  // --- Session lifecycle ---

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    cwd = ctx?.cwd ?? process.cwd();
    sessionCtx = ctx;

    try {
      config = await loadResolvedConfig(cwd);
    } catch {
      // Config parse error — fall back to no LSP support this session.
      return;
    }

    serverManager = createServerManager(config, cwd);
    await serverManager.detectServers();

    const statuses = serverManager.listLanguagesStatus();
    hasDetectedServers = statuses.some(
      (s) => s.status === "available" || s.status === "running",
    );

    // Show startup info if UI is available
    if (ctx?.hasUI && ctx?.ui?.notify) {
      const available = statuses.filter((s) => s.status === "available");
      if (available.length > 0) {
        const lines = available.map((s) => `  ${s.name} (${s.fileTypes.join(", ")})`);
        const label = available.length === 1 ? "server" : "servers";
        ctx.ui.notify(`[LSP] ${available.length} ${label}\n${lines.join("\n")}\n`, "info");
      }
    }

    // Set up idle shutdown timer (unref so it doesn't keep process alive)
    if (config.idleTimeoutMinutes > 0) {
      const timer = setInterval(() => {
        serverManager?.shutdownIdleServers();
      }, 60_000); // check every minute
      timer.unref();
    }
  });

  pi.on("session_shutdown", async () => {
    if (serverManager) {
      await serverManager.shutdownAll();
    }
    diagnosticsCache.clear();
    sessionCtx = null;
  });

  // --- System prompt hint ---

  pi.on("before_agent_start", async (event: any, _ctx: any) => {
    if (hasDetectedServers) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + PROMPT_HINT,
      };
    }
    return undefined;
  });

  // --- Tool_result interceptor ---

  pi.on("tool_result", async (event: any, _ctx: any) => {
    if (!serverManager || !config) return undefined;

    const deps: InterceptorDeps = {
      resolveServerForFile: (fp) => serverManager!.resolveServerForFile(fp),
      getServerDiagnostics: (name, uri) => getDiagnostics(name, uri),
      getServerName: (name) => name,
      ensureServerForFile: async (fp) => {
        const server = await serverManager!.ensureServerForFile(fp);
        if (server?.client) {
          // Wire up diagnostics listener if not already done
          const cacheKey = `diag-listener-${server.name}`;
          if (!(diagnosticsCache as any)[cacheKey]) {
            server.client.onDiagnostics((uri, diagnostics) => {
              setDiagnostics(server.name, uri, diagnostics);
            });
            (diagnosticsCache as any)[cacheKey] = true;
          }
        }
        return server;
      },
      formatFile: async (fp, name) => formatFile(fp, name),
      formatOnWrite: config!.formatOnWrite,
      diagnosticsOnWrite: config!.diagnosticsOnWrite,
      autoCodeActions: config!.autoCodeActions,
      diagnosticsTimeoutMs: 3000,
    };

    const interceptor = createToolResultInterceptor(deps);
    return interceptor(event);
  });

  // --- Register lsp tool ---

  pi.registerTool(createLspToolDefinition({
    listLanguagesStatus: () => serverManager?.listLanguagesStatus() ?? [],
    resolveServerForFile: (fp) => serverManager?.resolveServerForFile(fp) ?? null,
    ensureServerForFile: async (fp) => {
      if (!serverManager) return null;
      const server = await serverManager.ensureServerForFile(fp);
      if (server?.client) {
        // Wire up diagnostics listener
        const cacheKey = `diag-listener-${server.name}`;
        if (!(diagnosticsCache as any)[cacheKey]) {
          server.client.onDiagnostics((uri, diagnostics) => {
            setDiagnostics(server.name, uri, diagnostics);
          });
          (diagnosticsCache as any)[cacheKey] = true;
        }
      }
      return server;
    },
    getServerDiagnostics: (name, uri) => getDiagnostics(name, uri),
    getServerName: (name) => name,
  }));
}
