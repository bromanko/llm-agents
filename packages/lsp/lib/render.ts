/**
 * Compact renderers for LSP tool results.
 *
 * Converts raw LSP response objects into concise, human-readable text
 * suitable for tool result content blocks.
 */

import * as path from "node:path";
import type { LanguageStatus } from "./types.ts";

/** LSP Location shape. */
interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** LSP Hover shape. */
interface LspHover {
  contents: string | { kind?: string; value: string } | Array<string | { kind?: string; value: string }>;
  range?: LspLocation["range"];
}

/** LSP SymbolInformation / DocumentSymbol shape. */
interface LspSymbol {
  name: string;
  kind: number;
  location?: LspLocation;
  range?: LspLocation["range"];
  children?: LspSymbol[];
}

/** LSP Diagnostic shape for rendering. */
interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
}

/** Map of LSP symbol kind numbers to names. */
const SYMBOL_KIND_NAMES: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class",
  6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum",
  11: "Interface", 12: "Function", 13: "Variable", 14: "Constant",
  15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object",
  20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    return decodeURIComponent(uri.replace("file://", ""));
  }
  return uri;
}

/** Render a list of language statuses. */
export function renderLanguages(statuses: LanguageStatus[]): string {
  if (statuses.length === 0) return "No language servers configured.";
  return statuses.map((s) => {
    const types = s.fileTypes.join(", ");
    return `- ${s.name}: ${s.status} (${types})`;
  }).join("\n");
}

/** Render LSP locations (definition, references). */
export function renderLocations(locations: LspLocation[] | LspLocation | null): string {
  if (!locations) return "No results.";
  const locs = Array.isArray(locations) ? locations : [locations];
  if (locs.length === 0) return "No results.";

  return locs.map((loc) => {
    const file = uriToPath(loc.uri);
    const line = loc.range.start.line + 1;
    const col = loc.range.start.character + 1;
    return `${file}:${line}:${col}`;
  }).join("\n");
}

/** Render hover result. */
export function renderHover(hover: LspHover | null): string {
  if (!hover) return "No hover information available.";

  const contents = hover.contents;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((c) => (typeof c === "string" ? c : c.value)).join("\n\n");
  }
  if (typeof contents === "object" && "value" in contents) return contents.value;

  return "No hover information available.";
}

/** Render symbols (document or workspace). */
export function renderSymbols(symbols: LspSymbol[] | null, indent = 0): string {
  if (!symbols || symbols.length === 0) return "No symbols found.";

  const prefix = "  ".repeat(indent);
  return symbols.map((s) => {
    const kind = SYMBOL_KIND_NAMES[s.kind] ?? `kind:${s.kind}`;
    let loc = "";
    if (s.location) {
      const line = s.location.range.start.line + 1;
      loc = ` (${uriToPath(s.location.uri)}:${line})`;
    } else if (s.range) {
      const line = s.range.start.line + 1;
      loc = ` (line ${line})`;
    }
    let result = `${prefix}- ${s.name} [${kind}]${loc}`;
    if (s.children && s.children.length > 0) {
      result += "\n" + renderSymbols(s.children, indent + 1);
    }
    return result;
  }).join("\n");
}

/** Render diagnostics for the diagnostics action. */
export function renderDiagnostics(filePath: string, diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) return `No diagnostics for ${filePath}`;

  const lines = [`${diagnostics.length} issue(s) in ${filePath}:`];
  for (const d of diagnostics) {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const severity = d.severity === 1 ? "error" : d.severity === 2 ? "warning" : d.severity === 3 ? "info" : "hint";
    lines.push(`  ${filePath}:${line}:${col} [${severity}] ${d.message}`);
  }
  return lines.join("\n");
}

/** Render code actions. */
export function renderCodeActions(actions: Array<{ title: string; kind?: string }> | null): string {
  if (!actions || actions.length === 0) return "No code actions available.";
  return actions.map((a, i) => `${i + 1}. ${a.title}${a.kind ? ` (${a.kind})` : ""}`).join("\n");
}

/** Render call hierarchy items. */
export function renderCallItems(items: Array<{ name: string; uri?: string; range?: LspLocation["range"] }> | null): string {
  if (!items || items.length === 0) return "No calls found.";
  return items.map((item) => {
    let loc = "";
    if (item.uri) {
      const file = uriToPath(item.uri);
      const line = item.range ? item.range.start.line + 1 : 0;
      loc = line ? ` (${file}:${line})` : ` (${file})`;
    }
    return `- ${item.name}${loc}`;
  }).join("\n");
}
