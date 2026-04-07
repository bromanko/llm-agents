import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { loadResolvedConfig } from "../lib/config.ts";
import { createServerManager, type ManagedServer, type ServerManager } from "../lib/server-manager.ts";
import { createToolResultInterceptor, type ToolResultEvent } from "../lib/interceptor.ts";
import { createLspToolDefinition } from "../lib/lsp-tool.ts";
import { fileUri, type LspClient } from "../lib/lsp-client.ts";
import type { LspDiagnostic, LspTextEdit, ResolvedLspConfig } from "../lib/types.ts";

const PROMPT_HINT =
  'Write/edit results include automatic LSP diagnostics and formatting. Use the lsp tool for code intelligence (action "languages" to list supported languages).';

type DiagnosticsCache = Map<string, Map<string, LspDiagnostic[]>>;

interface SessionUi {
  notify?: (message: string, level?: string) => void;
}

interface SessionContext {
  cwd?: string;
  hasUI?: boolean;
  ui?: SessionUi;
}

interface BeforeAgentStartEvent {
  systemPrompt: string;
}

interface BeforeAgentStartResult {
  systemPrompt: string;
}

interface FormattingClient {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
}

export interface DiagnosticsRegistry {
  setDiagnostics(serverKey: string, uri: string, diagnostics: LspDiagnostic[]): void;
  getDiagnostics(serverKey: string, uri: string): LspDiagnostic[];
  attach(server: ManagedServer | null): ManagedServer | null;
  reset(): void;
}

export function createDiagnosticsRegistry(): DiagnosticsRegistry {
  let cache: DiagnosticsCache = new Map();
  let attachedClients = new WeakSet<LspClient>();

  function setDiagnostics(serverKey: string, uri: string, diagnostics: LspDiagnostic[]): void {
    let serverCache = cache.get(serverKey);
    if (!serverCache) {
      serverCache = new Map();
      cache.set(serverKey, serverCache);
    }
    serverCache.set(uri, diagnostics);
  }

  function getDiagnostics(serverKey: string, uri: string): LspDiagnostic[] {
    return cache.get(serverKey)?.get(uri) ?? [];
  }

  function attach(server: ManagedServer | null): ManagedServer | null {
    if (!server?.client) return server;
    if (attachedClients.has(server.client)) return server;

    server.client.onDiagnostics((uri, diagnostics) => {
      setDiagnostics(server.key, uri, diagnostics);
    });
    attachedClients.add(server.client);
    return server;
  }

  function reset(): void {
    cache = new Map();
    attachedClients = new WeakSet<LspClient>();
  }

  return {
    setDiagnostics,
    getDiagnostics,
    attach,
    reset,
  };
}

function compareReverseRange(a: LspTextEdit, b: LspTextEdit): number {
  const lineDiff = b.range.start.line - a.range.start.line;
  return lineDiff !== 0 ? lineDiff : b.range.start.character - a.range.start.character;
}

function buildLineOffsets(content: string): number[] {
  const lines = content.split("\n");
  const lineOffsets = new Array<number>(lines.length);
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    lineOffsets[i] = offset;
    offset += lines[i]!.length + 1;
  }

  return lineOffsets;
}

export function applyTextEdits(content: string, edits: LspTextEdit[]): string {
  const lineOffsets = buildLineOffsets(content);
  const sorted = [...edits].sort(compareReverseRange);

  for (const edit of sorted) {
    const startOffset = (lineOffsets[edit.range.start.line] ?? content.length) + edit.range.start.character;
    const endOffset = (lineOffsets[edit.range.end.line] ?? content.length) + edit.range.end.character;
    content = content.slice(0, startOffset) + edit.newText + content.slice(endOffset);
  }

  return content;
}

function asFormattingClient(client: LspClient): FormattingClient {
  return client;
}

export default function registerLspExtension(pi: ExtensionAPI): void {
  let serverManager: ServerManager | null = null;
  let config: ResolvedLspConfig | null = null;
  const diagnosticsRegistry = createDiagnosticsRegistry();
  let hasDetectedServers = false;
  let cwd = process.cwd();
  let interceptor: ReturnType<typeof createToolResultInterceptor> | null = null;

  async function ensureServerWithListeners(filePath: string): Promise<ManagedServer | null> {
    if (!serverManager) return null;
    return diagnosticsRegistry.attach(await serverManager.ensureServerForFile(filePath));
  }

  async function syncDocumentFromDiskWithListeners(filePath: string): Promise<ManagedServer | null> {
    if (!serverManager) return null;

    const server = await ensureServerWithListeners(filePath);
    if (!server) return null;

    return diagnosticsRegistry.attach(await serverManager.syncDocumentFromDisk(filePath));
  }

  async function syncDocumentContentWithListeners(filePath: string, content: string): Promise<ManagedServer | null> {
    if (!serverManager) return null;

    const server = await ensureServerWithListeners(filePath);
    if (!server) return null;

    return diagnosticsRegistry.attach(await serverManager.syncDocumentContent(filePath, content));
  }

  async function formatFile(filePath: string, content: string): Promise<string | null> {
    if (!serverManager) return null;
    const server = serverManager.getRunningServerForFile(filePath);
    if (!server?.client) return null;

    try {
      const uri = fileUri(filePath);
      const formattingClient = asFormattingClient(server.client);
      const edits = await formattingClient.request<LspTextEdit[] | null>(
        "textDocument/formatting",
        {
          textDocument: { uri },
          options: { tabSize: 2, insertSpaces: true },
        },
        5000,
      );

      if (!edits || edits.length === 0) return null;
      return applyTextEdits(content, edits);
    } catch {
      return null;
    }
  }

  pi.on("session_start", async (_event: unknown, ctx: SessionContext) => {
    cwd = ctx?.cwd ?? process.cwd();

    try {
      config = await loadResolvedConfig(cwd);
    } catch {
      return;
    }

    serverManager = createServerManager(config, cwd);
    await serverManager.detectServers();

    const statuses = serverManager.listLanguagesStatus();
    hasDetectedServers = statuses.some(
      (s) => s.status === "available" || s.status === "running",
    );

    if (ctx?.hasUI && ctx.ui?.notify) {
      const available = statuses.filter((s) => s.status === "available");
      if (available.length > 0) {
        const lines = available.map((s) => `  ${s.name} (${s.fileTypes.join(", ")})`);
        const label = available.length === 1 ? "server" : "servers";
        ctx.ui.notify(`[LSP] ${available.length} ${label}\n${lines.join("\n")}\n`, "info");
      }
    }

    if (config.idleTimeoutMinutes > 0) {
      const timer = setInterval(() => {
        serverManager?.shutdownIdleServers();
      }, 60_000);
      timer.unref();
    }

    interceptor = createToolResultInterceptor({
      resolveServerForFile: (fp) => serverManager!.resolveServerForFile(fp),
      getServerDiagnostics: (key, uri) => diagnosticsRegistry.getDiagnostics(key, uri),
      getServerName: (name) => name,
      syncDocumentContent: (fp, content) => syncDocumentContentWithListeners(fp, content),
      saveDocument: (server, fp) => serverManager?.saveDocument(server, fp) ?? Promise.resolve(),
      formatFile: (fp, content) => formatFile(fp, content),
      formatOnWrite: config.formatOnWrite,
      diagnosticsOnWrite: config.diagnosticsOnWrite,
      autoCodeActions: config.autoCodeActions,
      diagnosticsTimeoutMs: 3000,
    });
  });

  pi.on("session_shutdown", async () => {
    if (serverManager) {
      await serverManager.shutdownAll();
    }
    serverManager = null;
    config = null;
    diagnosticsRegistry.reset();
    hasDetectedServers = false;
    interceptor = null;
  });

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, _ctx: SessionContext): Promise<BeforeAgentStartResult | undefined> => {
    if (hasDetectedServers) {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + PROMPT_HINT,
      };
    }
    return undefined;
  });

  pi.on("tool_result", async (event: ToolResultEvent, _ctx: SessionContext) => {
    if (!interceptor) return undefined;
    return interceptor(event);
  });

  pi.registerTool(createLspToolDefinition({
    listLanguagesStatus: () => serverManager?.listLanguagesStatus() ?? [],
    resolveServerForFile: (fp) => serverManager?.resolveServerForFile(fp) ?? null,
    ensureServerForFile: (fp) => ensureServerWithListeners(fp),
    syncDocumentFromDisk: (fp) => syncDocumentFromDiskWithListeners(fp),
    getServerDiagnostics: (key, uri) => diagnosticsRegistry.getDiagnostics(key, uri),
    getServerName: (name) => name,
  }));
}
