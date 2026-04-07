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

interface MockDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number;
}

function createManagedServer() {
  return {
    name: "test-server",
    key: "test-server:/tmp/project",
    rootDir: "/tmp/project",
    rootUri: "file:///tmp/project",
    client: null,
    lastActivity: Date.now(),
    documents: new Map(),
  };
}

function createMockDeps(overrides?: Partial<InterceptorDeps>): InterceptorDeps {
  return {
    resolveServerForFile: () => null,
    getServerDiagnostics: () => [],
    getServerName: () => "test-server",
    syncDocumentContent: async () => null,
    saveDocument: async () => { },
    formatFile: async () => null,
    formatOnWrite: true,
    diagnosticsOnWrite: true,
    autoCodeActions: false,
    diagnosticsTimeoutMs: 10,
    ...overrides,
  };
}

function createTmpFile(ext = ".ts"): { filePath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lsp-int-test-"));
  const filePath = path.join(dir, `test${ext}`);
  fs.writeFileSync(filePath, "");
  return { filePath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test("intercepts only write and edit results", async () => {
  const interceptor = createToolResultInterceptor(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentContent: async () => createManagedServer(),
  }));

  const writeResult = await interceptor({
    toolName: "write",
    toolCallId: "tc1",
    input: { path: "/tmp/test.ts" },
    result: "File written",
  });
  const editResult = await interceptor({
    toolName: "edit",
    toolCallId: "tc2",
    input: { path: "/tmp/test.ts" },
    result: "File edited",
  });
  const bashResult = await interceptor({
    toolName: "bash",
    toolCallId: "tc3",
    input: { command: "ls" },
    result: "file list",
  });

  assert.equal(writeResult, undefined);
  assert.equal(editResult, undefined);
  assert.equal(bashResult, undefined);
});

test("no-op when diagnostics and formatting are disabled", async () => {
  const interceptor = createToolResultInterceptor(createMockDeps({
    diagnosticsOnWrite: false,
    formatOnWrite: false,
    resolveServerForFile: () => "test-server",
  }));

  const result = await interceptor({
    toolName: "write",
    toolCallId: "tc1",
    input: { path: "/tmp/test.ts" },
    result: "File written",
  });

  assert.equal(result, undefined);
});

test("delegates document synchronization to the injected sync helper", async () => {
  const calls: Array<{ filePath: string; content: string }> = [];
  const { filePath, cleanup } = createTmpFile();

  try {
    fs.writeFileSync(filePath, "const x = 1;");

    const interceptor = createToolResultInterceptor(createMockDeps({
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async (fp, content) => {
        calls.push({ filePath: fp, content });
        return createManagedServer();
      },
      diagnosticsTimeoutMs: 1,
    }));

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.filePath, filePath);
    assert.equal(calls[0]?.content, "const x = 1;");
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

test("format-on-write rewrites the file and re-synchronizes formatted content", async () => {
  const calls: string[] = [];
  const syncedContent: string[] = [];
  const { filePath, cleanup } = createTmpFile();

  try {
    fs.writeFileSync(filePath, "const   x=1;");

    const interceptor = createToolResultInterceptor(createMockDeps({
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async (_fp, content) => {
        calls.push("sync");
        syncedContent.push(content);
        return createManagedServer();
      },
      saveDocument: async () => {
        calls.push("save");
      },
      formatFile: async () => {
        calls.push("format");
        return "const x = 1;\n";
      },
      diagnosticsTimeoutMs: 1,
    }));

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.deepEqual(calls, ["sync", "format", "sync", "save"]);
    assert.deepEqual(syncedContent, ["const   x=1;", "const x = 1;\n"]);
    assert.equal(fs.readFileSync(filePath, "utf-8"), "const x = 1;\n");
  } finally {
    cleanup();
  }
});

test("recursion guard prevents infinite loop on rewrite", async () => {
  const { filePath, cleanup } = createTmpFile();
  let formatCalled = 0;

  try {
    fs.writeFileSync(filePath, "const x = 1;");

    const interceptor = createToolResultInterceptor(createMockDeps({
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async () => createManagedServer(),
      formatFile: async () => {
        formatCalled += 1;
        return "const x = 1;\n";
      },
      diagnosticsTimeoutMs: 1,
    }));

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written again",
    });

    assert.equal(formatCalled, 1);
  } finally {
    cleanup();
  }
});

test("no formatting when formatOnWrite is false", async () => {
  const { filePath, cleanup } = createTmpFile();
  let formatCalled = false;

  try {
    fs.writeFileSync(filePath, "const   x=1;");

    const interceptor = createToolResultInterceptor(createMockDeps({
      formatOnWrite: false,
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async () => createManagedServer(),
      formatFile: async () => {
        formatCalled = true;
        return "const x = 1;\n";
      },
      diagnosticsTimeoutMs: 1,
    }));

    await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.equal(formatCalled, false);
  } finally {
    cleanup();
  }
});

test("diagnostics are looked up with the synchronized server key", async () => {
  const { filePath, cleanup } = createTmpFile();
  let receivedKey = "";

  try {
    fs.writeFileSync(filePath, "const x = 1;");

    const interceptor = createToolResultInterceptor(createMockDeps({
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async () => createManagedServer(),
      saveDocument: async () => { },
      getServerDiagnostics: (serverKey) => {
        receivedKey = serverKey;
        return [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          message: "problem",
        }];
      },
      diagnosticsTimeoutMs: 1,
    }));

    const result = await interceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.equal(receivedKey, "test-server:/tmp/project");
    assert.ok(result?.result.includes("problem"));
  } finally {
    cleanup();
  }
});

test("saveDocument runs after the file is synchronized", async () => {
  const { filePath, cleanup } = createTmpFile();
  const order: string[] = [];

  try {
    fs.writeFileSync(filePath, "const x = 1;");

    const interceptor = createToolResultInterceptor(createMockDeps({
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async () => {
        order.push("sync");
        return createManagedServer();
      },
      saveDocument: async () => {
        order.push("save");
      },
      diagnosticsOnWrite: false,
      formatOnWrite: false,
    }));

    const disabledInterceptor = createToolResultInterceptor(createMockDeps({
      resolveServerForFile: () => "test-server",
      syncDocumentContent: async () => {
        order.push("sync");
        return createManagedServer();
      },
      saveDocument: async () => {
        order.push("save");
      },
      diagnosticsOnWrite: true,
      formatOnWrite: false,
      diagnosticsTimeoutMs: 1,
    }));

    await disabledInterceptor({
      toolName: "write",
      toolCallId: "tc1",
      input: { path: filePath },
      result: "File written",
    });

    assert.deepEqual(order, ["sync", "save"]);
    assert.equal(await interceptor({
      toolName: "write",
      toolCallId: "tc2",
      input: { path: filePath },
      result: "File written",
    }), undefined);
  } finally {
    cleanup();
  }
});
