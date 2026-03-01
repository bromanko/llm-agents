/**
 * Stdio JSON-RPC 2.0 client for LSP servers.
 *
 * Communicates over stdin/stdout using Content-Length framed messages
 * as specified by the LSP base protocol. Provides:
 * - Request/response correlation by auto-incrementing id
 * - Notification dispatch (e.g. publishDiagnostics)
 * - Request timeout and abort signal support
 * - Buffered frame parser that handles chunked/sticky messages
 */

import type { Writable, Readable } from "node:stream";
import { pathToFileURL } from "node:url";

// --- Types ---

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspClient {
  /** Send a JSON-RPC request and wait for the response. */
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params: unknown): void;
  /** Register a callback for publishDiagnostics notifications. */
  onDiagnostics(cb: (uri: string, diagnostics: unknown[]) => void): void;
  /** Register a callback for any notification by method name. */
  onNotification(method: string, cb: (params: unknown) => void): void;
  /** Tear down the client and clean up resources. */
  destroy(): void;
}

// --- Frame Parser ---

export interface FrameParser {
  feed(data: Buffer): void;
  onMessage(cb: (msg: unknown) => void): void;
}

/**
 * Create a Content-Length frame parser for LSP's base protocol.
 *
 * Handles chunked delivery (message split across multiple `feed` calls)
 * and sticky frames (multiple messages in one buffer).
 */
export function createFrameParser(): FrameParser {
  let buffer = Buffer.alloc(0);
  let messageCallback: ((msg: unknown) => void) | null = null;

  function tryParse(): void {
    while (true) {
      // Look for the header separator
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      // Extract Content-Length from header
      const header = buffer.subarray(0, headerEnd).toString("ascii");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Malformed header — skip past the separator and try again
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1]!, 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      // Do we have the full body yet?
      if (buffer.length < messageEnd) return;

      const bodyStr = buffer.subarray(messageStart, messageEnd).toString("utf-8");
      buffer = buffer.subarray(messageEnd);

      try {
        const parsed = JSON.parse(bodyStr);
        if (messageCallback) messageCallback(parsed);
      } catch {
        // Malformed JSON — skip this message, continue parsing
      }
    }
  }

  return {
    feed(data: Buffer) {
      buffer = Buffer.concat([buffer, data]);
      tryParse();
    },
    onMessage(cb) {
      messageCallback = cb;
    },
  };
}

// --- Position/URI helpers ---

/**
 * Convert 1-indexed (user-facing) line/column to 0-indexed LSP position.
 * Clamps to zero for invalid inputs.
 */
export function toLspPosition(line: number, column: number): LspPosition {
  return {
    line: Math.max(0, line - 1),
    character: Math.max(0, column - 1),
  };
}

/** Convert an absolute file path to a file:// URI. */
export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

// --- Client Factory ---

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Create an LSP client that communicates over the given stdio streams.
 *
 * @param stdin  - Writable stream connected to the server's stdin
 * @param stdout - Readable stream connected to the server's stdout
 */
export function createLspClient(stdin: Writable, stdout: Readable): LspClient {
  let nextId = 1;
  const pending = new Map<number, PendingRequest>();
  const notificationListeners = new Map<string, Array<(params: unknown) => void>>();
  const parser = createFrameParser();

  // Wire up the parser to the server's stdout
  const onData = (chunk: Buffer) => parser.feed(chunk);
  stdout.on("data", onData);

  parser.onMessage((msg: unknown) => {
    const m = msg as Record<string, unknown>;

    if ("id" in m && m.id !== undefined && m.id !== null) {
      // This is a response to a request
      const id = typeof m.id === "number" ? m.id : parseInt(String(m.id), 10);
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timer);
        if ("error" in m && m.error) {
          const err = m.error as { message?: string; code?: number };
          entry.reject(new Error(`LSP error ${err.code ?? ""}: ${err.message ?? "unknown"}`));
        } else {
          entry.resolve(m.result);
        }
      }
    } else if ("method" in m) {
      // This is a notification from the server
      const method = m.method as string;
      const params = m.params as unknown;
      const listeners = notificationListeners.get(method);
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(params);
          } catch {
            // Don't let listener errors crash the client
          }
        }
      }
    }
  });

  function sendMessage(msg: unknown): void {
    const json = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
    stdin.write(header + json);
  }

  function addNotificationListener(method: string, cb: (params: unknown) => void): void {
    const existing = notificationListeners.get(method) ?? [];
    existing.push(cb);
    notificationListeners.set(method, existing);
  }

  const client: LspClient = {
    request<T = unknown>(method: string, params: unknown, timeoutMs = 30000, signal?: AbortSignal): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Request aborted"));
          return;
        }

        const id = nextId++;
        const msg = { jsonrpc: "2.0", id, method, params };

        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`LSP request timeout: ${method} (id=${id}) after ${timeoutMs}ms`));
        }, timeoutMs);

        const entry: PendingRequest = {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        };

        // Handle abort signal
        if (signal) {
          const onAbort = () => {
            pending.delete(id);
            clearTimeout(timer);
            reject(new Error("Request aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          // Clean up listener when request completes
          const origResolve = entry.resolve;
          const origReject = entry.reject;
          entry.resolve = (value) => {
            signal.removeEventListener("abort", onAbort);
            origResolve(value);
          };
          entry.reject = (reason) => {
            signal.removeEventListener("abort", onAbort);
            origReject(reason);
          };
        }

        pending.set(id, entry);
        sendMessage(msg);
      });
    },

    notify(method: string, params: unknown): void {
      sendMessage({ jsonrpc: "2.0", method, params });
    },

    onDiagnostics(cb: (uri: string, diagnostics: unknown[]) => void): void {
      addNotificationListener("textDocument/publishDiagnostics", (params) => {
        const p = params as { uri: string; diagnostics: unknown[] };
        cb(p.uri, p.diagnostics ?? []);
      });
    },

    onNotification(method: string, cb: (params: unknown) => void): void {
      addNotificationListener(method, cb);
    },

    destroy(): void {
      stdout.removeListener("data", onData);
      for (const [id, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Client destroyed"));
        pending.delete(id);
      }
    },
  };

  return client;
}
