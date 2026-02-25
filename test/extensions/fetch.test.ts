import test from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fetchExtension, { createFetchToolDefinition, formatFetchEnvelope } from "../../shared/extensions/fetch.ts";
import type { FetchResponse } from "../../shared/lib/fetch-core.ts";

interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
  };
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

function createMockPi(): Pick<ExtensionAPI, "registerTool"> & { getTools(): RegisteredTool[] } {
  const tools: RegisteredTool[] = [];
  return {
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    getTools() {
      return tools;
    },
  };
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((part) => part.text).join("\n");
}

test("registers a tool named fetch", () => {
  const pi = createMockPi();

  fetchExtension(pi as ExtensionAPI);

  const tools = pi.getTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]!.name, "fetch");
  assert.equal(tools[0]!.label, "Fetch");
});

test("exposes url, timeout, raw, maxBytes, and maxLines parameters", () => {
  const tool = createFetchToolDefinition(async () => {
    throw new Error("not used");
  });

  const properties = tool.parameters.properties;

  assert.ok(properties.url);
  assert.ok(properties.timeout);
  assert.ok(properties.raw);
  assert.ok(properties.maxBytes);
  assert.ok(properties.maxLines);
});

test("returns a metadata envelope with URL, status, and content type", async () => {
  const mockResponse: FetchResponse = {
    requestUrl: "https://example.com",
    finalUrl: "https://example.com/final",
    status: 200,
    contentType: "text/html",
    method: "html",
    content: "Example Domain\nThis domain is for use in illustrative examples.",
    truncated: false,
    notes: [],
  };

  const tool = createFetchToolDefinition(async () => mockResponse);

  const result = await tool.execute(
    "call-1",
    {
      url: "https://example.com",
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  const text = getText(result);

  assert.match(text, /URL: https:\/\/example.com/);
  assert.match(text, /Final URL: https:\/\/example.com\/final/);
  assert.match(text, /Status: 200/);
  assert.match(text, /Content-Type: text\/html/);
  assert.match(text, /Method: html/);
  assert.match(text, /---/);
  assert.match(text, /Example Domain/);
});

test("includes truncation notice when core reports truncation", async () => {
  const mockResponse: FetchResponse = {
    requestUrl: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    contentType: "text/plain",
    method: "text",
    content: "line 1\nline 2",
    truncated: true,
    fullOutputPath: "/tmp/pi-fetch-123/output.txt",
    notes: [
      "[Output truncated: showing 2 of 200 lines (20 of 800 bytes). Full output saved to: /tmp/pi-fetch-123/output.txt]",
    ],
    truncation: {
      totalLines: 200,
      totalBytes: 800,
      outputLines: 2,
      outputBytes: 20,
    },
  };

  const tool = createFetchToolDefinition(async () => mockResponse);

  const result = await tool.execute(
    "call-2",
    {
      url: "https://example.com",
    },
    undefined,
    undefined,
    { cwd: process.cwd() },
  );

  const text = getText(result);

  assert.match(text, /Output truncated/);
  assert.match(text, /\/tmp\/pi-fetch-123\/output.txt/);
});

test("formatFetchEnvelope omits Final URL line when it matches requestUrl", () => {
  const response: FetchResponse = {
    requestUrl: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    contentType: "text/plain",
    method: "text",
    content: "hello",
    truncated: false,
    notes: [],
  };

  const text = formatFetchEnvelope(response);

  assert.match(text, /URL: https:\/\/example.com/);
  assert.doesNotMatch(text, /Final URL:/);
});

test("formatFetchEnvelope appends non-truncation notes", () => {
  const response: FetchResponse = {
    requestUrl: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    contentType: "text/plain",
    method: "text",
    content: "hello",
    truncated: false,
    notes: ["Some informational note"],
  };

  const text = formatFetchEnvelope(response);

  assert.match(text, /Note: Some informational note/);
});

test("formatFetchEnvelope shows truncation notice without fullOutputPath", () => {
  const response: FetchResponse = {
    requestUrl: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    contentType: "text/plain",
    method: "text",
    content: "partial",
    truncated: true,
    notes: [],
    truncation: {
      totalLines: 100,
      totalBytes: 5000,
      outputLines: 5,
      outputBytes: 40,
    },
  };

  const text = formatFetchEnvelope(response);

  assert.match(text, /Output truncated: showing 5 of 100 lines/);
  assert.match(text, /40 of 5000 bytes/);
  assert.doesNotMatch(text, /Full output saved to/);
});

test("execute propagates fetch errors to caller", async () => {
  const tool = createFetchToolDefinition(async () => {
    throw new Error("DNS resolution failed");
  });

  await assert.rejects(
    () => tool.execute("call-err", { url: "https://bad.invalid" }, undefined, undefined, { cwd: process.cwd() }),
    /DNS resolution failed/,
  );
});

test("renderCall returns component with fetch URL", () => {
  const tool = createFetchToolDefinition();
  const component = tool.renderCall({ url: "https://example.com" });
  assert.deepEqual(component.render(80), ["fetch https://example.com"]);
});

test("renderResult shows loading state when partial", () => {
  const tool = createFetchToolDefinition();
  const component = tool.renderResult({}, { isPartial: true });
  assert.deepEqual(component.render(80), ["Fetching..."]);
});

test("renderResult shows status and content type when complete", () => {
  const tool = createFetchToolDefinition();
  const component = tool.renderResult(
    { details: { status: 200, contentType: "text/html" } },
    { isPartial: false },
  );
  assert.deepEqual(component.render(80), ["Fetch complete (200, text/html)"]);
});
