/**
 * Unified `lsp` tool definition.
 *
 * Provides a single tool with an `action` enum that routes to the
 * appropriate LSP request. Uses plain JSON schema (no TypeBox).
 */

import * as path from "node:path";

import type { LspAction, LspToolParams, LanguageStatus } from "./types.ts";
import { toLspPosition, fileUri } from "./lsp-client.ts";
import type { ManagedServer } from "./server-manager.ts";
import type { LspClient } from "./lsp-client.ts";
import {
  renderLanguages,
  renderLocations,
  renderHover,
  renderSymbols,
  renderDiagnostics,
  renderCodeActions,
  renderCallItems,
} from "./render.ts";

// --- Types ---

interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
}

export interface LspToolDeps {
  listLanguagesStatus: () => LanguageStatus[];
  resolveServerForFile: (filePath: string) => string | null;
  ensureServerForFile: (filePath: string) => Promise<ManagedServer | null>;
  getServerDiagnostics: (serverName: string, uri: string) => LspDiagnostic[];
  getServerName: (serverName: string) => string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

// --- Action validation ---

const VALID_ACTIONS: Set<string> = new Set([
  "languages", "diagnostics", "definition", "references", "hover",
  "symbols", "rename", "code_actions", "incoming_calls", "outgoing_calls",
]);

const POSITION_ACTIONS: Set<string> = new Set([
  "definition", "references", "hover", "rename", "code_actions",
  "incoming_calls", "outgoing_calls",
]);

// --- Schema ---

const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [
        "languages", "diagnostics", "definition", "references", "hover",
        "symbols", "rename", "code_actions", "incoming_calls", "outgoing_calls",
      ],
      description: "The LSP action to perform.",
    },
    file: {
      type: "string",
      description: "Absolute or relative file path for the action.",
    },
    line: {
      type: "number",
      description: "1-indexed line number.",
    },
    column: {
      type: "number",
      description: "1-indexed column number.",
    },
    query: {
      type: "string",
      description: "Search query for workspace symbols.",
    },
    new_name: {
      type: "string",
      description: "New name for rename action.",
    },
    apply: {
      type: "boolean",
      description: "Whether to apply rename/code action edits.",
    },
  },
  required: ["action"],
  additionalProperties: false,
} as const;

// --- Helpers ---

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string): ToolResult {
  return textResult(`Error: ${text}`);
}

// --- Tool factory ---

export function createLspToolDefinition(deps: LspToolDeps) {
  return {
    name: "lsp",
    label: "LSP Code Intelligence",
    description:
      'Language Server Protocol code intelligence. Use action "languages" to list supported languages.',
    parameters,

    async execute(
      _toolCallId: string,
      params: LspToolParams,
      _signal?: AbortSignal,
    ): Promise<ToolResult> {
      const action = params.action;

      // Validate action
      if (!VALID_ACTIONS.has(action)) {
        return errorResult(`Unsupported action: "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`);
      }

      // Languages doesn't need a file
      if (action === "languages") {
        return textResult(renderLanguages(deps.listLanguagesStatus()));
      }

      // All other actions require a file
      if (!params.file) {
        return errorResult(`Missing required parameter "file" for action "${action}".`);
      }
      const filePath = path.resolve(params.file);
      const uri = fileUri(filePath);

      // Position-based actions require line and column
      if (POSITION_ACTIONS.has(action) && (params.line === undefined || params.column === undefined)) {
        return errorResult(`Missing required parameters "line" and "column" for action "${action}".`);
      }

      // Diagnostics action: return cached diagnostics
      if (action === "diagnostics") {
        const serverName = deps.resolveServerForFile(filePath);
        if (!serverName) {
          return errorResult(`No language server available for ${filePath}`);
        }
        const server = await deps.ensureServerForFile(filePath);
        if (!server) {
          return errorResult(`Failed to start language server for ${filePath}`);
        }
        const diagnostics = deps.getServerDiagnostics(serverName, uri);
        return textResult(renderDiagnostics(filePath, diagnostics));
      }

      // Ensure server is running
      const serverName = deps.resolveServerForFile(filePath);
      if (!serverName) {
        return errorResult(`No language server available for ${filePath}`);
      }
      const server = await deps.ensureServerForFile(filePath);
      if (!server || !server.client) {
        return errorResult(`Language server "${serverName}" is not running.`);
      }

      const client: LspClient = server.client;
      const position = params.line !== undefined && params.column !== undefined
        ? toLspPosition(params.line, params.column)
        : { line: 0, character: 0 };

      try {
        switch (action) {
          case "definition": {
            const result = await client.request("textDocument/definition", {
              textDocument: { uri },
              position,
            });
            return textResult(renderLocations(result as any));
          }

          case "references": {
            const result = await client.request("textDocument/references", {
              textDocument: { uri },
              position,
              context: { includeDeclaration: true },
            });
            return textResult(renderLocations(result as any));
          }

          case "hover": {
            const result = await client.request("textDocument/hover", {
              textDocument: { uri },
              position,
            });
            return textResult(renderHover(result as any));
          }

          case "symbols": {
            if (params.query) {
              // Workspace symbols
              const result = await client.request("workspace/symbol", {
                query: params.query,
              });
              return textResult(renderSymbols(result as any));
            } else {
              // Document symbols
              const result = await client.request("textDocument/documentSymbol", {
                textDocument: { uri },
              });
              return textResult(renderSymbols(result as any));
            }
          }

          case "rename": {
            if (!params.new_name) {
              return errorResult('Missing required parameter "new_name" for rename action.');
            }
            const result = await client.request("textDocument/rename", {
              textDocument: { uri },
              position,
              newName: params.new_name,
            });
            if (!result) return textResult("No rename edits returned.");
            // For now, just report what would change
            return textResult(`Rename result: ${JSON.stringify(result, null, 2)}`);
          }

          case "code_actions": {
            const result = await client.request("textDocument/codeAction", {
              textDocument: { uri },
              range: { start: position, end: position },
              context: { diagnostics: deps.getServerDiagnostics(serverName, uri) },
            });
            return textResult(renderCodeActions(result as any));
          }

          case "incoming_calls": {
            // Call hierarchy: first prepare, then incoming
            const prepared = await client.request("textDocument/prepareCallHierarchy", {
              textDocument: { uri },
              position,
            }) as any[];
            if (!prepared || prepared.length === 0) {
              return textResult("No call hierarchy item found at this position.");
            }
            const result = await client.request("callHierarchy/incomingCalls", {
              item: prepared[0],
            }) as any[];
            const items = result?.map((r: any) => r.from ?? r) ?? [];
            return textResult(renderCallItems(items));
          }

          case "outgoing_calls": {
            const prepared = await client.request("textDocument/prepareCallHierarchy", {
              textDocument: { uri },
              position,
            }) as any[];
            if (!prepared || prepared.length === 0) {
              return textResult("No call hierarchy item found at this position.");
            }
            const result = await client.request("callHierarchy/outgoingCalls", {
              item: prepared[0],
            }) as any[];
            const items = result?.map((r: any) => r.to ?? r) ?? [];
            return textResult(renderCallItems(items));
          }

          default:
            return errorResult(`Unsupported action: "${action}".`);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return errorResult(`LSP request failed: ${msg}`);
      }
    },
  };
}
