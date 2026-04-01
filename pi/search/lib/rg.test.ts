import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createRgExecutor, type SpawnProcess } from "./rg.ts";

class MockStream extends EventEmitter {
  setEncoding(_encoding: string): this {
    return this;
  }

  emitData(chunk: string): void {
    this.emit("data", chunk);
  }
}

class MockChildProcess extends EventEmitter {
  stdout = new MockStream();
  stderr = new MockStream();
}

function createSpawnMock(runScenario: (child: MockChildProcess) => void): SpawnProcess {
  return ((command, args, options) => {
    assert.equal(command, "rg");
    assert.equal(options?.stdio?.[0], "ignore");
    assert.equal(options?.stdio?.[1], "pipe");
    assert.equal(options?.stdio?.[2], "pipe");

    const child = new MockChildProcess();
    queueMicrotask(() => runScenario(child));
    return child as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
}

test("exit code 0 splits multiline stdout into trimmed lines", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    child.stdout.emitData("alpha\nbeta\n");
    child.stdout.emitData("gamma  \n\n");
    child.emit("close", 0);
  }));

  const result = await executeRg(["--files"], "/tmp/workspace");
  assert.deepEqual(result, {
    lines: ["alpha", "beta", "gamma"],
    matched: true,
    error: null,
  });
});

test("exit code 1 returns an empty non-error result", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    child.emit("close", 1);
  }));

  const result = await executeRg(["needle"], "/tmp/workspace");
  assert.deepEqual(result, {
    lines: [],
    matched: false,
    error: null,
  });
});

test("exit code greater than 1 surfaces stderr when available", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    child.stderr.emitData("regex parse error\n");
    child.emit("close", 2);
  }));

  const result = await executeRg(["("]);
  assert.deepEqual(result, {
    lines: [],
    matched: false,
    error: "regex parse error",
  });
});

test("exit code greater than 1 falls back to a generic message when stderr is empty", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    child.emit("close", 7);
  }));

  const result = await executeRg(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    matched: false,
    error: "ripgrep failed with exit code 7.",
  });
});

test("ENOENT errors return installation guidance", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    const error = Object.assign(new Error("spawn rg ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
  }));

  const result = await executeRg(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    matched: false,
    error: "ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep",
  });
});

test("generic process errors surface the original error message", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    child.emit("error", new Error("spawn failed"));
  }));

  const result = await executeRg(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    matched: false,
    error: "spawn failed",
  });
});

test("error followed by close resolves to the first finalized result", async () => {
  const executeRg = createRgExecutor(createSpawnMock((child) => {
    child.emit("error", new Error("spawn failed"));
    child.stderr.emitData("should be ignored\n");
    child.emit("close", 2);
  }));

  const result = await executeRg(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    matched: false,
    error: "spawn failed",
  });
});
