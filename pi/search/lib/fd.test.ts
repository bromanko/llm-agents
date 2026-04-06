import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createFdExecutor, type SpawnProcess } from "./fd.ts";

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
    assert.equal(command, "fd");
    assert.equal(options?.stdio?.[0], "ignore");
    assert.equal(options?.stdio?.[1], "pipe");
    assert.equal(options?.stdio?.[2], "pipe");

    const child = new MockChildProcess();
    queueMicrotask(() => runScenario(child));
    return child as unknown as ReturnType<SpawnProcess>;
  }) as SpawnProcess;
}

test("exit code 0 splits multiline stdout into lines and strips only trailing slashes", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    child.stdout.emitData("alpha/\nbeta\\\n");
    child.stdout.emitData("gamma  \n\n");
    child.emit("close", 0);
  }));

  const result = await executeFd([".", "src"], "/tmp/workspace");
  assert.deepEqual(result, {
    lines: ["alpha", "beta", "gamma  "],
    error: null,
  });
});

test("exit code 0 with empty stdout returns empty lines", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    child.emit("close", 0);
  }));

  const result = await executeFd(["."]);
  assert.deepEqual(result, {
    lines: [],
    error: null,
  });
});

test("exit code 1 surfaces stderr", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    child.stderr.emitData("regex parse error\n");
    child.emit("close", 1);
  }));

  const result = await executeFd(["("]);
  assert.deepEqual(result, {
    lines: [],
    error: "regex parse error",
  });
});

test("exit code greater than 1 falls back to a generic message when stderr is empty", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    child.emit("close", 7);
  }));

  const result = await executeFd(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    error: "fd failed with exit code 7.",
  });
});

test("ENOENT errors return installation guidance", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    const error = Object.assign(new Error("spawn fd ENOENT"), { code: "ENOENT" });
    child.emit("error", error);
  }));

  const result = await executeFd(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    error: "fd is not installed. Directory discovery requires fd. Install it from https://github.com/sharkdp/fd",
  });
});

test("lines without trailing slashes are preserved as-is", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    child.stdout.emitData("alpha\nbeta.ts\n");
    child.emit("close", 0);
  }));

  const result = await executeFd(["."]);
  assert.deepEqual(result, {
    lines: ["alpha", "beta.ts"],
    error: null,
  });
});

test("error followed by close resolves to the first finalized result", async () => {
  const executeFd = createFdExecutor(createSpawnMock((child) => {
    child.emit("error", new Error("spawn failed"));
    child.stderr.emitData("should be ignored\n");
    child.emit("close", 2);
  }));

  const result = await executeFd(["needle"]);
  assert.deepEqual(result, {
    lines: [],
    error: "spawn failed",
  });
});
