import * as fs from "node:fs";
import * as path from "node:path";

import { fileUri } from "./lsp-client.ts";
import type { ManagedServer } from "./server-manager.ts";
import type { LspDiagnostic } from "./types.ts";

export interface ToolResultEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
  result: string;
}

export interface InterceptorDeps {
  resolveServerForFile: (filePath: string) => string | null;
  getServerDiagnostics: (serverKey: string, uri: string) => LspDiagnostic[];
  getServerName: (serverName: string) => string;
  syncDocumentContent: (filePath: string, content: string) => Promise<ManagedServer | null>;
  saveDocument: (server: ManagedServer, filePath: string) => Promise<void>;
  formatFile: (filePath: string, content: string) => Promise<string | null>;
  formatOnWrite: boolean;
  diagnosticsOnWrite: boolean;
  autoCodeActions: boolean;
  diagnosticsTimeoutMs: number;
}

export type ToolResultInterceptor = (
  event: ToolResultEvent,
) => Promise<{ result: string } | undefined>;

export function formatDiagnosticsBlock(
  serverName: string,
  filePath: string,
  diagnostics: LspDiagnostic[],
): string {
  if (diagnostics.length === 0) return "";

  const lines = [`[${serverName}] ${diagnostics.length} issue(s):`];
  for (const d of diagnostics) {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    lines.push(`  ${filePath}:${line}:${col} — ${d.message}`);
  }
  return lines.join("\n");
}

export function createToolResultInterceptor(deps: InterceptorDeps): ToolResultInterceptor {
  const activeGuard = new Set<string>();

  return async (event: ToolResultEvent): Promise<{ result: string } | undefined> => {
    if (event.toolName !== "write" && event.toolName !== "edit") {
      return undefined;
    }

    if (!deps.diagnosticsOnWrite && !deps.formatOnWrite) {
      return undefined;
    }

    const filePath = typeof event.input.path === "string"
      ? path.resolve(event.input.path)
      : null;
    if (!filePath) return undefined;

    const serverName = deps.resolveServerForFile(filePath);
    if (!serverName) return undefined;

    const guardKey = `${event.toolCallId}:${filePath}`;
    if (activeGuard.has(guardKey)) {
      return undefined;
    }
    activeGuard.add(guardKey);

    try {
      let content: string;
      try {
        content = fs.readFileSync(filePath, "utf-8");
      } catch {
        return undefined;
      }

      let server = await deps.syncDocumentContent(filePath, content);
      if (!server) return undefined;

      if (deps.formatOnWrite) {
        const formatted = await deps.formatFile(filePath, content);
        if (formatted !== null && formatted !== content) {
          fs.writeFileSync(filePath, formatted);
          content = formatted;
          server = await deps.syncDocumentContent(filePath, content);
          if (!server) return undefined;
        }
      }

      await deps.saveDocument(server, filePath);

      if (deps.diagnosticsOnWrite) {
        await new Promise((resolve) => setTimeout(resolve, deps.diagnosticsTimeoutMs));

        const diagnostics = deps.getServerDiagnostics(server.key, fileUri(filePath));
        const block = formatDiagnosticsBlock(
          deps.getServerName(server.name),
          filePath,
          diagnostics,
        );

        if (block) {
          return { result: event.result + "\n\n" + block };
        }
      }

      return undefined;
    } finally {
      setTimeout(() => activeGuard.delete(guardKey), 100);
    }
  };
}
