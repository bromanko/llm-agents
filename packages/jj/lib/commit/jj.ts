/**
 * ControlledJj — thin wrapper around the jj CLI for commit pipeline operations.
 *
 * Every method shells out to `jj` in the given working directory and maps
 * the raw output into structured results. Errors are thrown with actionable
 * messages that include the failed command.
 */

import { execFile } from "node:child_process";

export interface DiffHunk {
  index: number;
  header: string;
  content: string;
}

export class JjError extends Error {
  command: string;
  stderr: string;

  constructor(command: string, stderr: string) {
    super(`jj command failed [${command}]: ${stderr}`);
    this.name = "JjError";
    this.command = command;
    this.stderr = stderr;
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

function runJj(cwd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "jj",
      args,
      { cwd, encoding: "utf-8", timeout: 30_000 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new JjError(["jj", ...args].join(" "), stderr ?? error.message));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

export class ControlledJj {
  private cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Returns the list of changed files in the working copy.
   * Parses `jj diff --name-only` output.
   */
  async getChangedFiles(): Promise<string[]> {
    const { stdout } = await runJj(this.cwd, ["diff", "--name-only"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /**
   * Returns the git-format diff for the working copy, optionally scoped to files.
   */
  async getDiffGit(files?: string[]): Promise<string> {
    const args = ["diff", "--git"];
    if (files && files.length > 0) {
      args.push("--", ...files);
    }
    const { stdout } = await runJj(this.cwd, args);
    return stdout;
  }

  /**
   * Returns diff stat summary for the working copy, optionally scoped to files.
   */
  async getStat(files?: string[]): Promise<string> {
    const args = ["diff", "--stat"];
    if (files && files.length > 0) {
      args.push("--", ...files);
    }
    const { stdout } = await runJj(this.cwd, args);
    return stdout;
  }

  /**
   * Extracts hunks from a git-format diff for a specific file.
   */
  async getHunks(file: string): Promise<DiffHunk[]> {
    const diff = await this.getDiffGit([file]);
    return parseHunks(diff);
  }

  /**
   * Returns recent commit summaries.
   */
  async getRecentCommits(count: number): Promise<string[]> {
    const { stdout } = await runJj(this.cwd, [
      "log",
      "-r",
      `ancestors(@, ${count})`,
      "-T",
      "description.first_line() ++ \"\\n\"",
      "--no-graph",
    ]);
    return stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  /**
   * Run `jj absorb` to automatically move working-copy changes into ancestor commits.
   * Returns whether any changes were absorbed and the raw output.
   */
  async absorb(): Promise<{ changed: boolean; output: string }> {
    try {
      const { stdout, stderr } = await runJj(this.cwd, ["absorb"]);
      const output = (stdout + "\n" + stderr).trim();
      // If absorb reports "Nothing changed" or empty output, no changes absorbed
      const changed = !(/nothing changed/i.test(output) || output.length === 0);
      return { changed, output };
    } catch (err) {
      if (err instanceof JjError) {
        // absorb may fail if there are no ancestor commits to absorb into
        return { changed: false, output: err.stderr };
      }
      throw err;
    }
  }

  /**
   * Create a commit from the working copy.
   * If files are specified, only those files are included.
   * Important: `jj commit` without file args commits ALL working-copy changes.
   */
  async commit(message: string, files?: string[]): Promise<void> {
    const args = ["commit", "-m", message];
    if (files && files.length > 0) {
      args.push(...files);
    }
    await runJj(this.cwd, args);
  }

  /**
   * Set a bookmark to point at a specific revision.
   */
  async setBookmark(name: string, rev: string): Promise<void> {
    await runJj(this.cwd, ["bookmark", "set", name, "-r", rev]);
  }

  /**
   * Push a bookmark to the remote.
   */
  async pushBookmark(name: string): Promise<void> {
    await runJj(this.cwd, ["git", "push", "--bookmark", name]);
  }
}

/**
 * Parse hunks from a git-format diff.
 * Each hunk starts with a @@ header line.
 */
export function parseHunks(diff: string): DiffHunk[] {
  const lines = diff.split("\n");
  const hunks: DiffHunk[] = [];

  let currentStart = -1;
  let currentHeader = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("@@")) continue;

    if (currentStart !== -1) {
      hunks.push({
        index: hunks.length,
        header: currentHeader,
        content: lines.slice(currentStart, i).join("\n"),
      });
    }

    currentStart = i;
    currentHeader = line;
  }

  if (currentStart !== -1) {
    hunks.push({
      index: hunks.length,
      header: currentHeader,
      content: lines.slice(currentStart).join("\n"),
    });
  }

  return hunks;
}
