/**
 * Core types for the pi LSP extension.
 *
 * These types define the configuration schema, runtime state,
 * and tool parameter shapes used throughout the extension.
 */

/** Actions supported by the unified `lsp` tool. */
export type LspAction =
  | "languages"
  | "diagnostics"
  | "definition"
  | "references"
  | "hover"
  | "symbols"
  | "rename"
  | "code_actions"
  | "incoming_calls"
  | "outgoing_calls";

/**
 * Definition of a single LSP server in the defaults or config files.
 *
 * Each server maps to a single language-server binary that handles
 * one or more file extensions and is discovered via root markers.
 */
export interface LspServerDefinition {
  /** Human-readable name, also used as the config key. */
  name: string;
  /** Binary command to launch (e.g. "typescript-language-server"). */
  command: string;
  /** Command-line arguments (e.g. ["--stdio"]). */
  args: string[];
  /** File extensions this server handles (e.g. [".ts", ".tsx"]). */
  fileTypes: string[];
  /** Files/dirs whose presence marks a project root (e.g. ["package.json"]). */
  rootMarkers: string[];
  /** Extra options passed in the LSP initialize request. */
  initializationOptions?: Record<string, unknown>;
  /** Workspace settings sent after initialization. */
  settings?: Record<string, unknown>;
  /** When true, this server is excluded from detection. */
  disabled?: boolean;
}

/**
 * User/project config file shape (partial, merged with defaults).
 *
 * The `servers` map is keyed by server name. Each value is a partial
 * override — only the fields present are merged on top of the default.
 */
export interface LspRuntimeConfig {
  formatOnWrite?: boolean;
  diagnosticsOnWrite?: boolean;
  autoCodeActions?: boolean;
  idleTimeoutMinutes?: number;
  servers?: Record<string, Partial<LspServerDefinition> & { binary?: string }>;
}

/**
 * Fully resolved config after merging defaults + user + project layers.
 * All fields are required; servers is a flat ordered array.
 */
export interface ResolvedLspConfig {
  formatOnWrite: boolean;
  diagnosticsOnWrite: boolean;
  autoCodeActions: boolean;
  idleTimeoutMinutes: number;
  servers: LspServerDefinition[];
}

/** Parameters accepted by the unified `lsp` tool. */
export interface LspToolParams {
  action: LspAction;
  file?: string;
  line?: number;
  column?: number;
  query?: string;
  new_name?: string;
  apply?: boolean;
}

/** Status of a detected language server. */
export type ServerAvailability = "available" | "running" | "missing" | "disabled";

/** Status entry returned by the `languages` action. */
export interface LanguageStatus {
  name: string;
  status: ServerAvailability;
  fileTypes: string[];
}
