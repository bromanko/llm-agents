import { spawn } from "node:child_process";

import type { RgExecutor, RgResult } from "./types.ts";

export type SpawnProcess = typeof spawn;

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function createRgExecutor(spawnProcess: SpawnProcess = spawn): RgExecutor {
  return async (args, cwd = process.cwd()) => {
    return new Promise<RgResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finalize = (result: RgResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const child = spawnProcess("rg", args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");

      child.stdout?.on("data", (chunk) => {
        stdout += chunk;
      });

      child.stderr?.on("data", (chunk) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT") {
          finalize({
            lines: [],
            matched: false,
            error: "ripgrep (rg) is not installed. Install it from https://github.com/BurntSushi/ripgrep",
          });
          return;
        }

        finalize({
          lines: [],
          matched: false,
          error: error.message,
        });
      });

      child.on("close", (code) => {
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          finalize({
            lines: splitLines(stdout),
            matched: true,
            error: null,
          });
          return;
        }

        if (exitCode === 1) {
          finalize({
            lines: [],
            matched: false,
            error: null,
          });
          return;
        }

        finalize({
          lines: [],
          matched: false,
          error: stderr.trim() || `ripgrep failed with exit code ${exitCode}.`,
        });
      });
    });
  };
}

export const executeRg = createRgExecutor();
