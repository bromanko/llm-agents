import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  createToolResultInterceptor,
  formatDiagnosticsBlock,
  type InterceptorDeps,
} from "../lib/interceptor.ts";

/** Minimal mock diagnostic matching LSP diagnostic shape. */
interface MockDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
}

/** Creates a minimal InterceptorDeps mock. */
function createMockDeps(overrides?: Partial<InterceptorDeps>): InterceptorDeps {
  return {
    resolveServerForFile: () => null,
    getServerDiagnostics: () => [],
    getServerName: () => "test-server",
    ensureServerForFile: async () => null,
    formatFile: async () => null,
    formatOnWrite: true,
    diagnosticsOnWrite: true,
    autoCodeActions: false,
    diagnosticsTimeoutMs: 100,
    ...overrides,
  };
}

function createTmpFile(ext = ".ts"): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-int-test-"));
  const filePath = path.join(dir, `test${ext}`);
  fs.writeFileSync(filePath, "");
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// --- Tests ---

test("intercepts only write and edit results", async () => {
  const intercepted: string[] = [];
  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({ name: "test-server", client: null, rootUri: "", lastActivity: 0 }),
  });
  const interceptor = createToolResultInterceptor(deps);

  // Should intercept write
  const writeResult = await interceptor({
    toolName: "write",
    toolCallId: "tc1",
    input: { path: "/tmp/test.ts" },
    result: "File written",
  });
  // Should intercept edit
  const editResult = await interceptor({
    toolName: "edit",
    toolCallId: "tc2",
    input: { path: "/tmp/test.ts" },
    result: "File edited",
  });
  // Should NOT intercept bash
  const bashResult = await interceptor({
    toolName: "bash",
    toolCallId: "tc3",
    input: { command: "ls" },
    result: "file list",
  });

  // write and edit may return modified result; bash should return undefined
  assert.equal(bashResult, undefined);
});

test("no-op when diagnosticsOnWrite=false", async () => {
  const deps = createMockDeps({
    diagnosticsOnWrite: false,
    formatOnWrite: false,
    resolveServerForFile: () => "test-server",
  });
  const interceptor = createToolResultInterceptor(deps);

  const result = await interceptor({
    toolName: "write",
    toolCallId: "tc1",
    input: { path: "/tmp/test.ts" },
    result: "File written",
  });

  // When diagnostics and formatting are both off, result should be unmodified
  assert.equal(result, undefined);
});

test("sends didOpen/didChange notification via ensureServerForFile", async () => {
  const notifications: string[] = [];
  const mockClient = {
    notify: (method: string, _params: unknown) => notifications.push(method),
    request: async () => null,
    onDiagnostics: () => {},
    onNotification: () => {},
    destroy: () => {},
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "file:///tmp",
      lastActivity: Date.now(),
    }),
    getServerDiagnostics: () => [],
    diagnosticsTimeoutMs: 50,
  });
  const interceptor = createToolResultInterceptor(deps);

  const { filePath, cleanup } = createTmpFile();
  try {
    fs.writeFileSync(filePath, "const x = 1;");
    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    // Should have sent didOpen or didChange
    assert.ok(
      notifications.some((n) => n === "textDocument/didOpen" || n === "textDocument/didChange"),
      `Expected didOpen or didChange, got: ${JSON.stringify(notifications)}`,
    );
  } finally {
    cleanup();
  }
});

test("appends deterministic diagnostics block format", () => {
  const diagnostics: MockDiagnostic[] = [
    {
      range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
      message: "Type 'number' is not assignable to type 'string'.",
      severity: 1,
    },
    {
      range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
      message: "Cannot find name 'hello'.",
      severity: 1,
    },
  ];

  const block = formatDiagnosticsBlock("typescript-language-server", "/tmp/test.ts", diagnostics);
  assert.ok(block.includes("[typescript-language-server] 2 issue(s):"));
  assert.ok(block.includes("/tmp/test.ts:1:7"));
  assert.ok(block.includes("Type 'number' is not assignable to type 'string'."));
  assert.ok(block.includes("/tmp/test.ts:3:1"));
  assert.ok(block.includes("Cannot find name 'hello'."));
});

test("suppresses diagnostics block when no diagnostics", () => {
  const block = formatDiagnosticsBlock("test-server", "/tmp/test.ts", []);
  assert.equal(block, "");
});

test("format-on-write applies edits and rewrites file", async () => {
  const { filePath, cleanup } = createTmpFile();
  try {
    fs.writeFileSync(filePath, "const   x=1;");

    const deps = createMockDeps({
      resolveServerForFile: () => "test-server",
      ensureServerForFile: async () => ({
        name: "test-server",
        client: {
          notify: () => {},
          request: async () => null,
          onDiagnostics: () => {},
          onNotification: () => {},
          destroy: () => {},
        },
        rootUri: "file:///tmp",
        lastActivity: Date.now(),
      }),
      formatFile: async () => "const x = 1;\n",
      getServerDiagnostics: () => [],
      diagnosticsTimeoutMs: 50,
    });
    const interceptor = createToolResultInterceptor(deps);

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    const content = fs.readFileSync(filePath, "utf-8");
    assert.equal(content, "const x = 1;\n");
  } finally {
    cleanup();
  }
});

test("recursion guard prevents infinite loop on rewrite", async () => {
  const { filePath, cleanup } = createTmpFile();
  let callCount = 0;
  try {
    fs.writeFileSync(filePath, "const x = 1;");

    const deps = createMockDeps({
      resolveServerForFile: () => "test-server",
      ensureServerForFile: async () => ({
        name: "test-server",
        client: {
          notify: () => {},
          request: async () => null,
          onDiagnostics: () => {},
          onNotification: () => {},
          destroy: () => {},
        },
        rootUri: "file:///tmp",
        lastActivity: Date.now(),
      }),
      formatFile: async () => {
        callCount++;
        return "const x = 1;\n";
      },
      getServerDiagnostics: () => [],
      diagnosticsTimeoutMs: 50,
    });
    const interceptor = createToolResultInterceptor(deps);

    // First call
    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    // Second call with same toolCallId+path should be guarded
    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written again",
    });

    assert.equal(callCount, 1, "format should only be called once due to recursion guard");
  } finally {
    cleanup();
  }
});

test("no formatting when formatOnWrite=false", async () => {
  const { filePath, cleanup } = createTmpFile();
  let formatCalled = false;
  try {
    fs.writeFileSync(filePath, "const   x=1;");

    const deps = createMockDeps({
      formatOnWrite: false,
      resolveServerForFile: () => "test-server",
      ensureServerForFile: async () => ({
        name: "test-server",
        client: {
          notify: () => {},
          request: async () => null,
          onDiagnostics: () => {},
          onNotification: () => {},
          destroy: () => {},
        },
        rootUri: "file:///tmp",
        lastActivity: Date.now(),
      }),
      formatFile: async () => {
        formatCalled = true;
        return "const x = 1;\n";
      },
      getServerDiagnostics: () => [],
      diagnosticsTimeoutMs: 50,
    });
    const interceptor = createToolResultInterceptor(deps);

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.equal(formatCalled, false, "format should not be called when formatOnWrite=false");
  } finally {
    cleanup();
  }
});

test("auto code actions not applied when autoCodeActions=false (default)", async () => {
  const { filePath, cleanup } = createTmpFile();
  let codeActionsCalled = false;
  try {
    fs.writeFileSync(filePath, "const x: string = 1;");

    const deps = createMockDeps({
      autoCodeActions: false,
      resolveServerForFile: () => "test-server",
      ensureServerForFile: async () => ({
        name: "test-server",
        client: {
          notify: () => {},
          request: async (_method: string) => {
            if (_method === "textDocument/codeAction") {
              codeActionsCalled = true;
            }
            return null;
          },
          onDiagnostics: () => {},
          onNotification: () => {},
          destroy: () => {},
        },
        rootUri: "file:///tmp",
        lastActivity: Date.now(),
      }),
      getServerDiagnostics: () => [],
      diagnosticsTimeoutMs: 50,
    });
    const interceptor = createToolResultInterceptor(deps);

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.equal(codeActionsCalled, false, "code actions should not be requested when disabled");
  } finally {
    cleanup();
  }
});
