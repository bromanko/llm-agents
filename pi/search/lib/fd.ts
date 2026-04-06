import { spawn } from "node:child_process";

import type { FdExecutor, FdResult } from "./types.ts";

export type SpawnProcess = typeof spawn;

function splitLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/[\\/]+$/g, ""))
    .filter((line) => line.length > 0);
}

export function createFdExecutor(spawnProcess: SpawnProcess = spawn): FdExecutor {
  return async (args, cwd = process.cwd()) => {
    return new Promise<FdResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finalize = (result: FdResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const child = spawnProcess("fd", args, {
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
            error: "fd is not installed. Directory discovery requires fd. Install it from https://github.com/sharkdp/fd",
          });
          return;
        }

        finalize({
          lines: [],
          error: error.message,
        });
      });

      child.on("close", (code) => {
        const exitCode = code ?? 1;
        if (exitCode === 0) {
          finalize({
            lines: splitLines(stdout),
            error: null,
          });
          return;
        }

        finalize({
          lines: [],
          error: stderr.trim() || `fd failed with exit code ${exitCode}.`,
        });
      });
    });
  };
}

export const executeFd = createFdExecutor();
