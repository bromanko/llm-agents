import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";

import { cleanupTempFiles, fetchUrl, normalizeUrl } from "../../shared/lib/fetch-core.ts";

after(() => cleanupTempFiles());

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine test server address");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    await run(baseUrl);
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("normalizes URL by adding https:// when no scheme is provided", () => {
  assert.equal(normalizeUrl("example.com/path"), "https://example.com/path");
});

test("normalizeUrl throws for empty input", () => {
  assert.throws(() => normalizeUrl(""), /URL must not be empty/);
  assert.throws(() => normalizeUrl("   "), /URL must not be empty/);
});

test("normalizeUrl preserves existing http:// scheme", () => {
  assert.equal(normalizeUrl("http://example.com"), "http://example.com");
});

test("normalizeUrl preserves existing https:// scheme", () => {
  assert.equal(normalizeUrl("https://example.com/path"), "https://example.com/path");
});

test("normalizeUrl trims whitespace", () => {
  assert.equal(normalizeUrl("  example.com  "), "https://example.com");
});

test("throws on malformed URL", async () => {
  await assert.rejects(
    () => fetchUrl({ url: "://malformed" }),
    /Invalid URL/,
  );
});

test("rejects non-http schemes", async () => {
  await assert.rejects(
    () => fetchUrl({ url: "file:///etc/passwd" }),
    /Only HTTP\(S\) URLs are supported/,
  );

});

test("returns deterministic timeout error message", async () => {
  await withServer(
    (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("too slow");
      }, 300);
    },
    async (baseUrl) => {
      await assert.rejects(
        () => fetchUrl({ url: `${baseUrl}/slow`, timeoutSeconds: 0.05 }),
        /Request timed out after 0.05s/,
      );
    },
  );
});

test("pretty-prints JSON responses", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end('{"hello":"world","nested":{"value":1}}');
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/json` });
      assert.equal(response.method, "json");
      assert.match(response.content, /\{\n  "hello": "world",\n  "nested": \{/);
      assert.equal(response.contentType, "application/json");
    },
  );
});

test("converts HTML responses into readable text", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html>
<html>
  <head><title>Example Page</title></head>
  <body>
    <h1>Hello from server</h1>
    <p>This is <strong>important</strong> text.</p>
    <script>window.__secret = 'ignore';</script>
  </body>
</html>`);
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/html` });
      assert.equal(response.method, "html");
      assert.match(response.content, /Example Page/);
      assert.match(response.content, /Hello from server/);
      assert.match(response.content, /important/);
      assert.doesNotMatch(response.content.toLowerCase(), /<html|<script/);
    },
  );
});

test("passes through plain text responses", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("line one\nline two");
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/text` });
      assert.equal(response.method, "text");
      assert.equal(response.content, "line one\nline two");
    },
  );
});

test("returns truncation metadata and full output path when limits are exceeded", async () => {
  const largeOutput = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(largeOutput);
    },
    async (baseUrl) => {
      const response = await fetchUrl({
        url: `${baseUrl}/large`,
        maxLines: 5,
        maxBytes: 32,
      });

      assert.equal(response.truncated, true);
      assert.ok(response.fullOutputPath, "expected path to saved full output");
      const fullOutputPath = response.fullOutputPath;
      assert.ok(existsSync(fullOutputPath), "full output file should exist");
      assert.match(response.notes.join("\n"), /Output truncated/);
      assert.ok(response.content.split("\n").length <= 5, "content should respect maxLines");

      assert.ok(response.truncation, "expected truncation metadata");
      const truncation = response.truncation;
      assert.equal(truncation.totalLines, 80);
      assert.ok(truncation.totalBytes > 32, "totalBytes should exceed maxBytes");
      assert.ok(truncation.outputLines <= 5, "outputLines should respect maxLines");
      assert.ok(truncation.outputBytes <= 32, "outputBytes should respect maxBytes");

      const saved = readFileSync(fullOutputPath, "utf-8");
      assert.equal(saved, largeOutput);
    },
  );
});

test("returns 404 status and body content for not-found responses", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not Found");
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/missing` });
      assert.equal(response.status, 404);
      assert.equal(response.content, "Not Found");
    },
  );
});

test("returns 500 status and body for server errors", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"internal"}');
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/error` });
      assert.equal(response.status, 500);
      assert.equal(response.method, "json");
    },
  );
});

test("throws descriptive error when connection is refused", async () => {
  await assert.rejects(
    () => fetchUrl({ url: "http://127.0.0.1:1" }),
    /fetch failed|ECONNREFUSED/i,
  );
});

test("raw mode returns HTML content without transformation", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<h1>Hello</h1>");
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/raw`, raw: true });
      assert.equal(response.method, "raw");
      assert.equal(response.content, "<h1>Hello</h1>");
    },
  );
});

test("decodes HTML entities in converted text", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>Tom &amp; Jerry &#39;s &#x26; friends</p>");
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/entities` });
      assert.match(response.content, /Tom & Jerry 's & friends/);
    },
  );
});

test("returns fallback method for unknown content types", async () => {
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("binary-ish content");
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/binary` });
      assert.equal(response.method, "fallback");
      assert.equal(response.content, "binary-ish content");
    },
  );
});

test("truncation does not split multi-byte UTF-8 characters", async () => {
  const emoji = "🎉".repeat(20); // Each emoji is 4 bytes
  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(emoji);
    },
    async (baseUrl) => {
      const response = await fetchUrl({ url: `${baseUrl}/emoji`, maxBytes: 10 });
      // 10 bytes can fit 2 emoji (8 bytes), not 3
      assert.equal(response.content, "🎉🎉");
      assert.equal(response.truncated, true);
    },
  );
});

test("notes when response body exceeds read limit for large responses", async () => {
  // Generate a body larger than MIN_BODY_READ_BYTES (256 KiB)
  const largeBody = "x".repeat(300 * 1024);

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(largeBody);
    },
    async (baseUrl) => {
      // With maxBytes=32, the read limit is MIN_BODY_READ_BYTES (256 KiB),
      // which is less than the 300 KiB response body
      const response = await fetchUrl({ url: `${baseUrl}/huge`, maxBytes: 32, maxLines: 5 });
      assert.equal(response.truncated, true);
      assert.ok(
        response.notes.some((n) => n.includes("read limit")),
        "expected a note about the body read limit",
      );
    },
  );
});

test("cleanupTempFiles removes truncated output files", async () => {
  const largeOutput = Array.from({ length: 80 }, (_, index) => `line-${index + 1}`).join("\n");

  let savedPath: string | undefined;

  await withServer(
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(largeOutput);
    },
    async (baseUrl) => {
      const response = await fetchUrl({
        url: `${baseUrl}/large`,
        maxLines: 5,
        maxBytes: 32,
      });

      assert.ok(response.fullOutputPath, "expected path to saved full output");
      savedPath = response.fullOutputPath;
      assert.ok(existsSync(savedPath), "full output file should exist before cleanup");
    },
  );

  cleanupTempFiles();
  assert.ok(savedPath, "savedPath should have been set");
  assert.ok(!existsSync(savedPath), "full output file should be removed after cleanup");
});

test("cleanupTempFiles is safe to call when no temp files exist", () => {
  cleanupTempFiles();
  cleanupTempFiles();
});
