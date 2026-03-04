import test from "node:test";
import assert from "node:assert/strict";

import { createLspToolDefinition, type LspToolDeps } from "../lib/lsp-tool.ts";
import { LSP_ACTIONS, type LspAction, type LanguageStatus } from "../lib/types.ts";

/** Create mock deps for the lsp tool. */
function createMockDeps(overrides?: Partial<LspToolDeps>): LspToolDeps {
  return {
    listLanguagesStatus: () => [],
    resolveServerForFile: () => null,
    ensureServerForFile: async () => null,
    getServerDiagnostics: () => [],
    getServerName: (name) => name,
    ...overrides,
  };
}

test("registers tool named lsp", () => {
  const deps = createMockDeps();
  const tool = createLspToolDefinition(deps);
  assert.equal(tool.name, "lsp");
});

test("schema includes required action enum and optional fields", () => {
  const deps = createMockDeps();
  const tool = createLspToolDefinition(deps);
  const props = tool.parameters.properties;

  assert.ok(props.action, "should have action property");
  assert.ok(props.action.enum, "action should have enum");
  assert.deepEqual(props.action.enum, [...LSP_ACTIONS], "schema enum should match canonical LSP_ACTIONS");
  assert.ok(props.action.enum.includes("languages"), "should include languages");
  assert.ok(props.action.enum.includes("definition"), "should include definition");
  assert.ok(props.action.enum.includes("implementation"), "should include implementation");
  assert.ok(props.action.enum.includes("hover"), "should include hover");
  assert.ok(props.action.enum.includes("references"), "should include references");
  assert.ok(props.action.enum.includes("symbols"), "should include symbols");
  assert.ok(props.action.enum.includes("rename"), "should include rename");
  assert.ok(props.action.enum.includes("code_actions"), "should include code_actions");
  assert.ok(props.action.enum.includes("diagnostics"), "should include diagnostics");
  assert.ok(props.action.enum.includes("incoming_calls"), "should include incoming_calls");
  assert.ok(props.action.enum.includes("outgoing_calls"), "should include outgoing_calls");

  // Optional fields
  assert.ok(props.file, "should have file property");
  assert.ok(props.line, "should have line property");
  assert.ok(props.column, "should have column property");
  assert.ok(props.query, "should have query property");
  assert.ok(props.new_name, "should have new_name property");
  assert.ok(props.apply, "should have apply property");

  assert.deepEqual(tool.parameters.required, ["action"]);
});

test("action contract: every canonical action is recognized at runtime", async () => {
  const deps = createMockDeps();
  const tool = createLspToolDefinition(deps);

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
  const deps = createMockDeps({ listLanguagesStatus: () => statuses });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", { action: "languages" as LspAction });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("typescript-language-server"), "should list ts server");
  assert.ok(text.includes("available"), "should show available status");
  assert.ok(text.includes("rust-analyzer"), "should list rust server");
  assert.ok(text.includes("missing"), "should show missing status");
});

test("diagnostics action returns current diagnostics for file", async () => {
  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: null,
      rootUri: "",
      lastActivity: 0,
    }),
    getServerDiagnostics: () => [
      {
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
        message: "Type error",
        severity: 1,
      },
    ],
  });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", {
    action: "diagnostics" as LspAction,
    file: "/tmp/test.ts",
  });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("Type error"), "should include diagnostic message");
  assert.ok(text.includes("1:7"), "should include 1-indexed position");
});

test("definition routes to textDocument/definition", async () => {
  let requestedMethod = "";
  const mockClient = {
    request: async (method: string) => {
      requestedMethod = method;
      return [{ uri: "file:///tmp/test.ts", range: { start: { line: 5, character: 0 }, end: { line: 5, character: 10 } } }];
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", {
    action: "definition" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });
  assert.equal(requestedMethod, "textDocument/definition");
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("test.ts"), "should include file info");
});

test("implementation routes to textDocument/implementation with uri+position", async () => {
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
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

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

  const content = result.content[0];
  assert.equal(content?.type, "text");
  assert.ok(content?.text.includes("/tmp/impl.ts:6:1"), "should render location text");
});

test("implementation normalizes LocationLink[] results", async () => {
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
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", {
    action: "implementation" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });

  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("/tmp/impl-link.ts:9:3"), "should render LocationLink target selection range");
});

test("implementation rejects missing line/column", async () => {
  const mockClient = {
    request: async () => [],
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", {
    action: "implementation" as LspAction,
    file: "/tmp/test.ts",
  });

  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes('Missing required parameters "line" and "column"'));
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
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

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
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", {
    action: "hover" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });
  assert.equal(requestedMethod, "textDocument/hover");
  const text = result.content[0]?.text ?? "";
  assert.ok(text.includes("hover docs"), "should include hover content");
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
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", {
    action: "references" as LspAction,
    file: "/tmp/test.ts",
    line: 1,
    column: 1,
  });
  assert.equal(requestedMethod, "textDocument/references");
});

test("symbols switches between document and workspace based on query", async () => {
  const requestedMethods: string[] = [];
  const mockClient = {
    request: async (method: string) => {
      requestedMethods.push(method);
      return [];
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  // Without query → document symbols
  await tool.execute("tc1", { action: "symbols" as LspAction, file: "/tmp/test.ts" });
  assert.equal(requestedMethods[0], "textDocument/documentSymbol");

  // With query → workspace symbols
  await tool.execute("tc2", { action: "symbols" as LspAction, file: "/tmp/test.ts", query: "MyClass" });
  assert.equal(requestedMethods[1], "workspace/symbol");
});

test("missing required file field returns deterministic validation error", async () => {
  const deps = createMockDeps();
  const tool = createLspToolDefinition(deps);

  // definition requires file, line, column
  const result = await tool.execute("tc1", { action: "definition" as LspAction });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.toLowerCase().includes("required") || text.toLowerCase().includes("missing"),
    `Expected validation error, got: ${text}`);
});

test("line/column 1-index input is converted to 0-index LSP position", async () => {
  let sentParams: any = null;
  const mockClient = {
    request: async (_method: string, params: unknown) => {
      sentParams = params;
      return null;
    },
    notify: () => { },
    onDiagnostics: () => { },
    onNotification: () => { },
    destroy: () => { },
  };

  const deps = createMockDeps({
    resolveServerForFile: () => "test-server",
    ensureServerForFile: async () => ({
      name: "test-server",
      client: mockClient,
      rootUri: "",
      lastActivity: 0,
    }),
  });
  const tool = createLspToolDefinition(deps);

  await tool.execute("tc1", {
    action: "hover" as LspAction,
    file: "/tmp/test.ts",
    line: 10,
    column: 5,
  });

  assert.ok(sentParams, "should have sent params");
  assert.equal(sentParams.position.line, 9, "line should be 0-indexed (10 → 9)");
  assert.equal(sentParams.position.character, 4, "column should be 0-indexed (5 → 4)");
});

test("unsupported action returns deterministic error text", async () => {
  const deps = createMockDeps();
  const tool = createLspToolDefinition(deps);

  const result = await tool.execute("tc1", { action: "nonexistent" as LspAction });
  const text = result.content[0]?.text ?? "";
  assert.ok(text.toLowerCase().includes("unsupported") || text.toLowerCase().includes("unknown"),
    `Expected unsupported action error, got: ${text}`);
});
