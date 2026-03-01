import test from "node:test";
import assert from "node:assert/strict";

import {
  JJ_FOOTER_COMMANDS,
  JJ_INFO_FIELD_SEPARATOR,
  detectWorkspaceName,
  getJjInfo,
} from "./footer.ts";

type MockExec = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    encoding: "utf-8";
    timeout: number;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => string;

function commandKey(file: string, args: readonly string[]): string {
  return `${file}\u0000${args.join("\u0000")}`;
}

function createMockExec(commandOutputs: Map<string, string>) {
  const calls: Array<{ file: string; args: string[] }> = [];

  const exec: MockExec = (file, args, _options) => {
    calls.push({ file, args: [...args] });

    const key = commandKey(file, args);
    if (!commandOutputs.has(key)) {
      throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
    }

    return commandOutputs.get(key)!;
  };

  return { exec, calls };
}

test("detectWorkspaceName runs --color=never log/workspace commands and resolves active workspace", () => {
  const { exec, calls } = createMockExec(new Map([
    [commandKey("jj", JJ_FOOTER_COMMANDS.currentChangeId), "abc123\n"],
    [commandKey("jj", JJ_FOOTER_COMMANDS.workspaceList), "default:def000\nfeature:abc123\n"],
  ]));

  const workspaceName = detectWorkspaceName("/repo", undefined, exec);

  assert.equal(workspaceName, "feature");
  assert.deepEqual(calls, [
    { file: "jj", args: [...JJ_FOOTER_COMMANDS.currentChangeId] },
    { file: "jj", args: [...JJ_FOOTER_COMMANDS.workspaceList] },
  ]);
});

test("getJjInfo runs --color=never log/diff commands and parses footer fields", () => {
  const { exec, calls } = createMockExec(new Map([
    [commandKey("jj", JJ_FOOTER_COMMANDS.infoLog), `ab${JJ_INFO_FIELD_SEPARATOR}ab12${JJ_INFO_FIELD_SEPARATOR}Fix parser${JJ_INFO_FIELD_SEPARATOR}dirty\n`],
    [commandKey("jj", JJ_FOOTER_COMMANDS.diffStat), "1 files changed, 12 insertions(+), 3 deletions(-)\n"],
  ]));

  const info = getJjInfo("/repo", exec);

  assert.deepEqual(info, {
    uniquePrefix: "ab",
    rest: "12",
    description: "Fix parser",
    empty: false,
    insertions: 12,
    deletions: 3,
  });
  assert.deepEqual(calls, [
    { file: "jj", args: [...JJ_FOOTER_COMMANDS.infoLog] },
    { file: "jj", args: [...JJ_FOOTER_COMMANDS.diffStat] },
  ]);
});

test("getJjInfo preserves descriptions containing pipe characters", () => {
  const { exec } = createMockExec(new Map([
    [commandKey("jj", JJ_FOOTER_COMMANDS.infoLog), `ab${JJ_INFO_FIELD_SEPARATOR}ab12${JJ_INFO_FIELD_SEPARATOR}Fix parser | keep literal pipe${JJ_INFO_FIELD_SEPARATOR}dirty\n`],
    [commandKey("jj", JJ_FOOTER_COMMANDS.diffStat), "1 files changed, 12 insertions(+), 3 deletions(-)\n"],
  ]));

  const info = getJjInfo("/repo", exec);

  assert.deepEqual(info, {
    uniquePrefix: "ab",
    rest: "12",
    description: "Fix parser | keep literal pipe",
    empty: false,
    insertions: 12,
    deletions: 3,
  });
});

test("ANSI escapes in jj output do not affect workspace or footer parsing", () => {
  const ansiGreen = "\u001b[32m";
  const ansiRed = "\u001b[31m";
  const ansiReset = "\u001b[0m";

  const wsMock = createMockExec(new Map([
    [commandKey("jj", JJ_FOOTER_COMMANDS.currentChangeId), `${ansiGreen}abc123${ansiReset}\n`],
    [commandKey("jj", JJ_FOOTER_COMMANDS.workspaceList), `default:def000\n${ansiGreen}feature${ansiReset}:${ansiGreen}abc123${ansiReset}\n`],
  ]));

  const workspaceName = detectWorkspaceName("/repo", undefined, wsMock.exec);
  assert.equal(workspaceName, "feature");

  const infoMock = createMockExec(new Map([
    [commandKey("jj", JJ_FOOTER_COMMANDS.infoLog), `${ansiGreen}ab${JJ_INFO_FIELD_SEPARATOR}ab12${JJ_INFO_FIELD_SEPARATOR}Colorized output${JJ_INFO_FIELD_SEPARATOR}dirty${ansiReset}\n`],
    [commandKey("jj", JJ_FOOTER_COMMANDS.diffStat), `1 files changed, ${ansiGreen}12 insertions(+)${ansiReset}, ${ansiRed}3 deletions(-)${ansiReset}\n`],
  ]));

  const info = getJjInfo("/repo", infoMock.exec);

  assert.deepEqual(info, {
    uniquePrefix: "ab",
    rest: "12",
    description: "Colorized output",
    empty: false,
    insertions: 12,
    deletions: 3,
  });
});
