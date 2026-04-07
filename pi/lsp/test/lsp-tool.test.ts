import test from "node:test";
import assert from "node:assert/strict";

import { createLspToolDefinition, type LspToolDeps } from "../lib/lsp-tool.ts";
import { LSP_ACTIONS, type LspAction, type LanguageStatus } from "../lib/types.ts";

function createManagedServer(client: any = null) {
  return {
    name: "test-server",
    key: "test-server:/tmp/project",
    rootDir: "/tmp/project",
    rootUri: "file:///tmp/project",
    client,
    lastActivity: 0,
    documents: new Map(),
  };
}

function createMockDeps(overrides?: Partial<LspToolDeps>): LspToolDeps {
  return {
    listLanguagesStatus: () => [],
    resolveServerForFile: () => null,
    ensureServerForFile: async () => null,
    syncDocumentFromDisk: async () => null,
    getServerDiagnostics: () => [],
    getServerName: (name) => name,
    ...overrides,
  };
}

test("registers tool named lsp", () => {
  const tool = createLspToolDefinition(createMockDeps());
  assert.equal(tool.name, "lsp");
});

test("schema includes required action enum and optional fields", () => {
  const tool = createLspToolDefinition(createMockDeps());
  const props = tool.parameters.properties;

  assert.ok(props.action);
  assert.deepEqual(props.action.enum, [...LSP_ACTIONS]);
  assert.ok(props.file);
  assert.ok(props.line);
  assert.ok(props.column);
  assert.ok(props.query);
  assert.ok(props.new_name);
  assert.ok(props.apply);
  assert.deepEqual(tool.parameters.required, ["action"]);
});

test("action contract: every canonical action is recognized at runtime", async () => {
  const tool = createLspToolDefinition(createMockDeps());

  for (const action of LSP_ACTIONS) {
    const params: { action: LspAction; file?: string; line?: number; column?: number } = { action };
    if (action !== "languages") {
      params.file = "/tmp/test.ts";
      params.line = 1;
      params.column = 1;
    }

    const result = await tool.execute("tc-contract", params);
    const text = result.content[0]?.text ?? "";
    assert.ok(!text.includes("Unsupported action"), `action should be recognized: ${action}`);
  }
});

test("languages action returns status list", async () => {
  const statuses: LanguageStatus[] = [
    { name: "typescript-language-server", status: "available", fileTypes: [".ts", ".tsx"] },
    { name: "rust-analyzer", status: "missing", fileTypes: [".rs"] },
  ];
  const tool = createLspToolDefinition(createMockDeps({ listLanguagesStatus: () => statuses }));

  const result = await tool.execute("tc1", { action: "languages" as LspAction });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("typescript-language-server"));
  assert.ok(text.includes("available"));
  assert.ok(text.includes("rust-analyzer"));
  assert.ok(text.includes("missing"));
});

test("diagnostics action synchronizes the document before rendering cached diagnostics", async () => {
  const calls: string[] = [];
  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => {
      calls.push("sync");
      return createManagedServer();
    },
    getServerDiagnostics: () => {
      calls.push("diagnostics");
      return [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        message: "Type error",
        severity: 1,
      }];
    },
  }));

  const result = await tool.execute("tc1", {
    action: "diagnostics" as LspAction,
    file: "/tmp/test.ts",
  });

  assert.deepEqual(calls, ["sync", "diagnostics"]);
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("Type error"));
  assert.ok(text.includes("1:7"));
});

test("definition synchronizes before issuing the LSP request", async () => {
  const order: string[] = [];
  const mockClient = {
    request: async (method: string) => {
      order.push(method);
      return [{ uri: "file:///tmp/test.ts", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } } }];
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => {
      order.push("sync");
      return createManagedServer(mockClient);
    },
  }));

  const result = await tool.execute("tc1", {
    action: "definition" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });

  assert.deepEqual(order, ["sync", "textDocument/definition"]);
  assert.ok(result.content[0]?.text.includes("test.ts"));
});

test("implementation routes to textDocument/implementation with uri and position", async () => {
  let requestedMethod = "";
  let requestedParams: any = null;
  const mockClient = {
    request: async (method: string, params: unknown) => {
      requestedMethod = method;
      requestedParams = params;
      return [{
        uri: "file:///tmp/impl.ts",
        range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } },
      }];
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  const result = await tool.execute("tc1", {
    action: "implementation" as LspAction,
    file: "/tmp/test.ts",
    line: 3,
    column: 7,
  });

  assert.equal(requestedMethod, "textDocument/implementation");
  assert.deepEqual(requestedParams, {
    textDocument: { uri: "file:///tmp/test.ts" },
    position: { line: 2, character: 6 },
  });
  assert.ok(result.content[0]?.text.includes("/tmp/impl.ts:6:1"));
});

test("implementation normalizes LocationLink results", async () => {
  const mockClient = {
    request: async () => ([{
      targetUri: "file:///tmp/impl-link.ts",
      targetSelectionRange: {
        start: { line: 8, character: 2 },
        end: { line: 8, character: 11 },
      },
    }]),
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  const result = await tool.execute("tc1", {
    action: "implementation" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });

  assert.ok(result.content[0]?.text.includes("/tmp/impl-link.ts:9:3"));
});

test("implementation rejects missing line and column", async () => {
  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(),
  }));

  const result = await tool.execute("tc1", {
    action: "implementation" as LspAction,
    file: "/tmp/test.ts",
  });

  assert.ok(result.content[0]?.text.includes('Missing required parameters "line" and "column"'));
});

test("implementation maps request failures to deterministic error text", async () => {
  let requestedMethod = "";
  const mockClient = {
    request: async (method: string) => {
      requestedMethod = method;
      throw new Error("implementation transport error");
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  const result = await tool.execute("tc1", {
    action: "implementation" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });

  assert.equal(requestedMethod, "textDocument/implementation");
  assert.equal(result.content[0]?.text, "Error: LSP request failed: implementation transport error");
});

test("hover routes to textDocument/hover", async () => {
  let requestedMethod = "";
  const mockClient = {
    request: async (method: string) => {
      requestedMethod = method;
      return { contents: { kind: "markdown", value: "hover docs" } };
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  const result = await tool.execute("tc1", {
    action: "hover" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });

  assert.equal(requestedMethod, "textDocument/hover");
  assert.ok(result.content[0]?.text.includes("hover docs"));
});

test("references routes to textDocument/references", async () => {
  let requestedMethod = "";
  const mockClient = {
    request: async (method: string) => {
      requestedMethod = method;
      return [{ uri: "file:///tmp/a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }];
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  await tool.execute("tc1", {
    action: "references" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });

  assert.equal(requestedMethod, "textDocument/references");
});

test("symbols switches between document and workspace queries", async () => {
  const requestedMethods: string[] = [];
  const mockClient = {
    request: async (method: string) => {
      requestedMethods.push(method);
      return [];
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  await tool.execute("tc1", { action: "symbols" as LspAction, file: "/tmp/test.ts" });
  await tool.execute("tc2", { action: "symbols" as LspAction, file: "/tmp/test.ts", query: "MyClass" });

  assert.equal(requestedMethods[0], "textDocument/documentSymbol");
  assert.equal(requestedMethods[1], "workspace/symbol");
});

test("missing required file field returns deterministic validation error", async () => {
  const tool = createLspToolDefinition(createMockDeps());
  const result = await tool.execute("tc1", { action: "definition" as LspAction });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.toLowerCase().includes("required") || text.toLowerCase().includes("missing"));
});

test("line and column input is converted to 0-indexed LSP positions", async () => {
  let sentParams: any = null;
  const mockClient = {
    request: async (_method: string, params: unknown) => {
      sentParams = params;
      return null;
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    onRequest: () => { },
    destroy: () => { },
  };

  const tool = createLspToolDefinition(createMockDeps({
    resolveServerForFile: () => "test-server",
    syncDocumentFromDisk: async () => createManagedServer(mockClient),
  }));

  await tool.execute("tc1", {
    action: "hover" as LspAction,
    file: "/tmp/test.ts",
    line: 10,
    column: 5,
  });

  assert.equal(sentParams.position.line, 9);
  assert.equal(sentParams.position.character, 4);
});

test("unsupported action returns deterministic error text", async () => {
  const tool = createLspToolDefinition(createMockDeps());
  const result = await tool.execute("tc1", { action: "nonexistent" as LspAction });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.toLowerCase().includes("unsupported") || text.toLowerCase().includes("unknown"));
});
