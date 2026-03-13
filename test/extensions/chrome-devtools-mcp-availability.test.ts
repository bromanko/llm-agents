import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import registerChromeDevtoolsMcpAvailability, {
  hasExecutableInPath,
} from "../../pi/chrome-devtools-mcp/extensions/index.ts";
import { createMockExtensionAPI } from "../helpers.ts";

async function withTempExecutable<T>(
  name: string,
  fn: (binDir: string, executablePath: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pi-chrome-devtools-mcp-"));
  const executablePath = join(dir, name);

  try {
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n");
    await chmod(executablePath, 0o755);
    return await fn(dir, executablePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("hasExecutableInPath returns false when PATH is empty or missing the binary", () => {
  assert.equal(hasExecutableInPath("chrome-devtools-mcp", { pathEnv: "" }), false);
  assert.equal(hasExecutableInPath("chrome-devtools-mcp", { pathEnv: "/tmp:/usr/bin/does-not-exist" }), false);
});

test("hasExecutableInPath returns true when a matching executable exists in PATH", async () => {
  await withTempExecutable("chrome-devtools-mcp", async (binDir) => {
    assert.equal(hasExecutableInPath("chrome-devtools-mcp", { pathEnv: binDir }), true);
  });
});

test("hasExecutableInPath respects PATHEXT-style suffix lookup on win32", async () => {
  await withTempExecutable("chrome-devtools-mcp.cmd", async (binDir) => {
    assert.equal(
      hasExecutableInPath("chrome-devtools-mcp", {
        pathEnv: binDir,
        platform: "win32",
        pathExtEnv: ".CMD;.EXE",
      }),
      true,
    );
  });
});

test("resources_discover exposes the skill only when chrome-devtools-mcp is in PATH", async () => {
  const pi = createMockExtensionAPI();
  registerChromeDevtoolsMcpAvailability(
    pi as unknown as Parameters<typeof registerChromeDevtoolsMcpAvailability>[0],
  );

  const [handler] = pi.getHandlers("resources_discover");
  assert.ok(handler);

  const previousPath = process.env.PATH;

  try {
    process.env.PATH = "";
    const missingResult = await handler(
      { type: "resources_discover", cwd: process.cwd(), reason: "startup" },
      { cwd: process.cwd() },
    );
    assert.equal(missingResult, undefined);

    await withTempExecutable("chrome-devtools-mcp", async (binDir) => {
      process.env.PATH = binDir;
      const result = await handler(
        { type: "resources_discover", cwd: process.cwd(), reason: "startup" },
        { cwd: process.cwd() },
      );

      assert.deepEqual(result, {
        skillPaths: [join(process.cwd(), "pi/chrome-devtools-mcp/chrome-devtools-mcp/SKILL.md")],
      });
    });
  } finally {
    process.env.PATH = previousPath;
  }
});
