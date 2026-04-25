import type { Writable, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type Disposable,
  type MessageConnection,
} from "vscode-jsonrpc/node.js";

import type { LspDiagnostic } from "./types.ts";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspClient {
  request<T = unknown>(method: string, params: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<T>;
  notify(method: string, params: unknown): void;
  onDiagnostics(cb: (uri: string, diagnostics: LspDiagnostic[]) => void): void;
  onNotification(method: string, cb: (params: unknown) => void): void;
  onRequest<TParams = unknown, TResult = unknown>(
    method: string,
    cb: (params: TParams) => TResult | Promise<TResult>,
  ): void;
  isClosed?(): boolean;
  destroy(): void;
}

export function toLspPosition(line: number, column: number): LspPosition {
  return {
    line: Math.max(0, line - 1),
    character: Math.max(0, column - 1),
  };
}

export function fileUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

interface PendingRequest {
  reject: (reason: Error) => void;
  cleanup: () => void;
}

export function createLspClient(stdin: Writable, stdout: Readable): LspClient {
  const reader = new StreamMessageReader(stdout);
  const writer = new StreamMessageWriter(stdin);
  const connection: MessageConnection = createMessageConnection(reader, writer);
  const disposables = new Set<Disposable>();
  const pending = new Set<PendingRequest>();
  let destroyed = false;
  let closed = false;

  function normalizeError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  function isConnectionClosedError(error: Error): boolean {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
    const text = `${error.message} ${code}`;
    return /connection is closed|connection is disposed|connection got disposed|client destroyed|write after end|epipe|err_stream_destroyed/i.test(text);
  }

  function destroyPending(reason: Error): void {
    for (const entry of Array.from(pending)) {
      entry.cleanup();
      entry.reject(reason);
    }
  }

  function markClosed(reason = new Error("Connection closed")): void {
    if (closed) return;
    closed = true;
    destroyPending(reason);
  }

  function unavailableError(): Error | null {
    if (destroyed) return new Error("Client destroyed");
    if (closed) return new Error("Connection closed");
    return null;
  }

  function handleConnectionError(error: unknown): Error {
    const normalized = normalizeError(error);
    if (isConnectionClosedError(normalized)) {
      markClosed(normalized);
    }
    return normalized;
  }

  disposables.add(connection.onClose(() => {
    markClosed(new Error("Connection closed"));
  }));

  disposables.add(connection.onError(([error]) => {
    handleConnectionError(error);
  }));

  connection.listen();

  function trackRequest<T>(
    startWork: () => Promise<T>,
    method: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const unavailable = unavailableError();
      if (unavailable) {
        reject(unavailable);
        return;
      }

      if (signal?.aborted) {
        reject(new Error("Request aborted"));
        return;
      }

      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: (() => void) | undefined;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (signal && onAbort) {
          signal.removeEventListener("abort", onAbort);
        }
        pending.delete(pendingEntry);
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const pendingEntry: PendingRequest = {
        cleanup,
        reject: (reason) => finish(() => reject(reason)),
      };

      pending.add(pendingEntry);

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          finish(() => reject(new Error(`LSP request timeout: ${method} after ${timeoutMs}ms`)));
        }, timeoutMs);
      }

      if (signal) {
        onAbort = () => {
          finish(() => reject(new Error("Request aborted")));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }

      let work: Promise<T>;
      try {
        work = startWork();
      } catch (error) {
        const normalized = handleConnectionError(error);
        finish(() => reject(normalized));
        return;
      }

      work.then(
        (value) => finish(() => resolve(value)),
        (error) => {
          const normalized = handleConnectionError(error);
          if (isConnectionClosedError(normalized)) return;
          finish(() => reject(normalized));
        },
      );
    });
  }

  return {
    request<T = unknown>(method: string, params: unknown, timeoutMs = 30000, signal?: AbortSignal): Promise<T> {
      return trackRequest(
        () => connection.sendRequest(method, params) as Promise<T>,
        method,
        timeoutMs,
        signal,
      );
    },

    notify(method: string, params: unknown): void {
      if (destroyed || closed) return;

      try {
        void connection.sendNotification(method, params).catch((error) => {
          handleConnectionError(error);
          // Best effort. Notifications are fire-and-forget.
        });
      } catch (error) {
        handleConnectionError(error);
        // Best effort. Notifications are fire-and-forget.
      }
    },

    onDiagnostics(cb: (uri: string, diagnostics: LspDiagnostic[]) => void): void {
      if (destroyed || closed) return;

      try {
        const disposable = connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
          const payload = (params ?? {}) as { uri?: string; diagnostics?: LspDiagnostic[] };
          if (typeof payload.uri !== "string") return;
          cb(payload.uri, payload.diagnostics ?? []);
        });
        disposables.add(disposable);
      } catch (error) {
        handleConnectionError(error);
      }
    },

    onNotification(method: string, cb: (params: unknown) => void): void {
      if (destroyed || closed) return;

      try {
        const disposable = connection.onNotification(method, cb);
        disposables.add(disposable);
      } catch (error) {
        handleConnectionError(error);
      }
    },

    onRequest<TParams = unknown, TResult = unknown>(
      method: string,
      cb: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      if (destroyed || closed) return;

      try {
        const disposable = connection.onRequest(method, (params: TParams) => cb(params));
        disposables.add(disposable);
      } catch (error) {
        handleConnectionError(error);
      }
    },

    isClosed(): boolean {
      return destroyed || closed;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      closed = true;

      destroyPending(new Error("Client destroyed"));

      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch {
          // Best effort.
        }
      }
      disposables.clear();

      try {
        connection.dispose();
      } catch {
        // Best effort.
      }
    },
  };
}
