import * as path from "node:path";

import { LSP_ACTIONS, type LspAction, type LspDiagnostic, type LspToolParams, type LanguageStatus } from "./types.ts";
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

interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

interface LspLocationLink {
  targetUri: string;
  targetSelectionRange?: LspLocation["range"];
  targetRange?: LspLocation["range"];
}

type LocationResult = LspLocation | LspLocation[] | LspLocationLink[] | null;

export interface LspToolDeps {
  listLanguagesStatus: () => LanguageStatus[];
  resolveServerForFile: (filePath: string) => string | null;
  ensureServerForFile: (filePath: string) => Promise<ManagedServer | null>;
  syncDocumentFromDisk: (filePath: string) => Promise<ManagedServer | null>;
  getServerDiagnostics: (serverKey: string, uri: string) => LspDiagnostic[];
  getServerName: (name: string) => string;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
}

const VALID_ACTIONS: ReadonlySet<LspAction> = new Set(LSP_ACTIONS);

const NON_POSITION_ACTIONS: ReadonlySet<LspAction> = new Set([
  "languages",
  "diagnostics",
  "symbols",
]);

const POSITION_ACTIONS: ReadonlySet<LspAction> = new Set(
  LSP_ACTIONS.filter((action) => !NON_POSITION_ACTIONS.has(action)),
);

const parameters = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...LSP_ACTIONS],
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

function textResult(text: string): ToolResult {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string): ToolResult {
  return textResult(`Error: ${text}`);
}

function isLocationLink(location: LspLocation | LspLocationLink): location is LspLocationLink {
  return "targetUri" in location;
}

function normalizeLocationResult(result: LocationResult): LspLocation | LspLocation[] | null {
  if (!result) return result;
  if (!Array.isArray(result)) return result;
  if (result.length === 0) return result;
  if (!isLocationLink(result[0])) return result;

  return result
    .map((link) => {
      const range = link.targetSelectionRange ?? link.targetRange;
      if (!range) return null;
      return { uri: link.targetUri, range };
    })
    .filter((location): location is LspLocation => location !== null);
}

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

      if (!VALID_ACTIONS.has(action)) {
        return errorResult(`Unsupported action: "${action}". Valid actions: ${Array.from(VALID_ACTIONS).join(", ")}`);
      }

      if (action === "languages") {
        return textResult(renderLanguages(deps.listLanguagesStatus()));
      }

      if (!params.file) {
        return errorResult(`Missing required parameter "file" for action "${action}".`);
      }
      const filePath = path.resolve(params.file);
      const uri = fileUri(filePath);

      if (POSITION_ACTIONS.has(action) && (params.line === undefined || params.column === undefined)) {
        return errorResult(`Missing required parameters "line" and "column" for action "${action}".`);
      }

      const serverName = deps.resolveServerForFile(filePath);
      if (!serverName) {
        return errorResult(`No language server available for ${filePath}`);
      }

      const syncedServer = await deps.syncDocumentFromDisk(filePath);
      if (!syncedServer) {
        return errorResult(`Failed to synchronize language server document for ${filePath}`);
      }

      if (action === "diagnostics") {
        const diagnostics = deps.getServerDiagnostics(syncedServer.key, uri);
        return textResult(renderDiagnostics(filePath, diagnostics));
      }

      if (!syncedServer.client) {
        return errorResult(`Language server "${serverName}" is not running.`);
      }

      const client: LspClient = syncedServer.client;
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

          case "implementation": {
            const result = await client.request<LocationResult>("textDocument/implementation", {
              textDocument: { uri },
              position,
            });
            return textResult(renderLocations(normalizeLocationResult(result)));
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
              const result = await client.request("workspace/symbol", {
                query: params.query,
              });
              return textResult(renderSymbols(result as any));
            }

            const result = await client.request("textDocument/documentSymbol", {
              textDocument: { uri },
            });
            return textResult(renderSymbols(result as any));
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
            return textResult(`Rename result: ${JSON.stringify(result, null, 2)}`);
          }

          case "code_actions": {
            const result = await client.request("textDocument/codeAction", {
              textDocument: { uri },
              range: { start: position, end: position },
              context: { diagnostics: deps.getServerDiagnostics(syncedServer.key, uri) },
            });
            return textResult(renderCodeActions(result as any));
          }

          case "incoming_calls": {
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
