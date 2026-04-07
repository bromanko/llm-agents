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

  connection.listen();

  connection.onError((_error) => {
    // The underlying json-rpc library already routes transport errors through
    // request promises and connection lifecycle events. Keep this handler so
    // those errors do not become unhandled event noise.
  });

  function destroyPending(reason: Error): void {
    for (const entry of Array.from(pending)) {
      entry.cleanup();
      entry.reject(reason);
    }
  }

  function trackRequest<T>(
    work: Promise<T>,
    method: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (destroyed) {
        reject(new Error("Client destroyed"));
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

      work.then(
        (value) => finish(() => resolve(value)),
        (error) => {
          const normalized = error instanceof Error ? error : new Error(String(error));
          finish(() => reject(normalized));
        },
      );
    });
  }

  return {
    request<T = unknown>(method: string, params: unknown, timeoutMs = 30000, signal?: AbortSignal): Promise<T> {
      const work = connection.sendRequest(method, params) as Promise<T>;
      return trackRequest(work, method, timeoutMs, signal);
    },

    notify(method: string, params: unknown): void {
      if (destroyed) return;
      void connection.sendNotification(method, params).catch(() => {
        // Best effort. Notifications are fire-and-forget.
      });
    },

    onDiagnostics(cb: (uri: string, diagnostics: LspDiagnostic[]) => void): void {
      const disposable = connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
        const payload = (params ?? {}) as { uri?: string; diagnostics?: LspDiagnostic[] };
        if (typeof payload.uri !== "string") return;
        cb(payload.uri, payload.diagnostics ?? []);
      });
      disposables.add(disposable);
    },

    onNotification(method: string, cb: (params: unknown) => void): void {
      const disposable = connection.onNotification(method, cb);
      disposables.add(disposable);
    },

    onRequest<TParams = unknown, TResult = unknown>(
      method: string,
      cb: (params: TParams) => TResult | Promise<TResult>,
    ): void {
      const disposable = connection.onRequest(method, (params: TParams) => cb(params));
      disposables.add(disposable);
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;

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
