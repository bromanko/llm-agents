import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CommitSnapshot,
  DiffHunk,
  FileChange,
  FileChangeKind,
  SnapshotFile,
} from "./types.ts";

export class GitError extends Error {
  command: string;
  stderr: string;

  constructor(command: string, stderr: string) {
    super(`git command failed [${command}]: ${stderr}`);
    this.name = "GitError";
    this.command = command;
    this.stderr = stderr;
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

interface FileDiffSection {
  filename: string;
  content: string;
  isBinary: boolean;
  kind: FileChangeKind;
}

function runGit(cwd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf-8", timeout: 30_000 },
      (error: Error | null, stdout: string, stderr: string) => {
        if (error) {
          reject(new GitError(["git", ...args].join(" "), stderr ?? error.message));
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

async function runGitWithInput(cwd: string, args: string[], input: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stderr = "";
    child.stderr.on("data", (chunk: { toString(): string }) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      reject(new GitError(["git", ...args].join(" "), error.message));
    });
    child.on("close", (code: number | null) => {
      if (code && code !== 0) {
        reject(new GitError(["git", ...args].join(" "), stderr.trim()));
        return;
      }
      resolve();
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

export class ControlledGit {
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  async hasStagedChanges(): Promise<boolean> {
    const { stdout } = await runGit(this.cwd, ["diff", "--cached", "--name-only"]);
    return stdout.split("\n").some((line) => line.trim().length > 0);
  }

  async stageAll(): Promise<void> {
    await runGit(this.cwd, ["add", "-A"]);
  }

  async resetStaging(files?: string[]): Promise<void> {
    const args = ["reset"];
    if (files && files.length > 0) {
      args.push("--", ...files);
    }
    await runGit(this.cwd, args);
  }

  async getStagedFiles(): Promise<string[]> {
    const { stdout } = await runGit(this.cwd, ["diff", "--cached", "--name-only"]);
    return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async getStagedSnapshot(): Promise<CommitSnapshot> {
    const [diffResult, statResult] = await Promise.all([
      runGit(this.cwd, ["diff", "--cached"]),
      runGit(this.cwd, ["diff", "--cached", "--stat"]),
    ]);

    const sections = parseFileDiffs(diffResult.stdout);
    const files: SnapshotFile[] = sections.map((section) => {
      const hunks = parseFileHunks(section);
      return {
        path: section.filename,
        kind: section.kind,
        isBinary: section.isBinary,
        patch: section.content,
        hunks,
        splitAllowed: !section.isBinary && section.kind === "modified" && hunks.length > 0,
      };
    });

    return {
      files,
      stat: statResult.stdout,
      diff: diffResult.stdout,
    };
  }

  async stageSnapshotChanges(snapshot: CommitSnapshot, changes: FileChange[]): Promise<void> {
    if (changes.length === 0) return;

    const fileMap = new Map(snapshot.files.map((file) => [file.path, file]));
    const patchParts: string[] = [];

    for (const change of changes) {
      const file = fileMap.get(change.path);
      if (!file) {
        throw new GitError("git apply --cached", `No staged snapshot found for ${change.path}`);
      }

      if (change.hunks.type === "all") {
        patchParts.push(file.patch);
        continue;
      }

      if (!file.splitAllowed) {
        throw new GitError("git apply --cached", `File cannot be split by hunk: ${change.path}`);
      }

      const selected = new Set(change.hunks.indices.map((index) => Math.floor(index)));
      const hunks = file.hunks.filter((hunk) => selected.has(hunk.index + 1));
      if (hunks.length === 0) {
        throw new GitError("git apply --cached", `No hunks selected for ${change.path}`);
      }

      patchParts.push([extractFileHeader(file.patch), ...hunks.map((hunk) => hunk.content)].join("\n"));
    }

    const patch = joinPatch(patchParts);
    if (!patch.trim()) return;

    const patchPath = join(tmpdir(), `pi-git-commit-${randomUUID()}.patch`);
    try {
      await fs.writeFile(patchPath, patch, "utf-8");
      await runGit(this.cwd, ["apply", "--cached", "--binary", patchPath]);
    } finally {
      await fs.rm(patchPath, { force: true });
    }
  }

  async commit(message: string): Promise<void> {
    await runGitWithInput(this.cwd, ["commit", "-F", "-"], message);
  }

  async push(): Promise<void> {
    await runGit(this.cwd, ["push"]);
  }
}

function parseFileDiffs(diff: string): FileDiffSection[] {
  const sections: FileDiffSection[] = [];
  const parts = diff.split("\ndiff --git ");

  for (let index = 0; index < parts.length; index++) {
    const part = index === 0 ? parts[index] : `diff --git ${parts[index]}`;
    if (!part.trim()) continue;

    const lines = part.split("\n");
    const header = lines[0] ?? "";
    const match = header.match(/diff --git a\/(.+?) b\/(.+)$/);
    if (!match) continue;

    const filename = match[2];
    const isBinary = lines.some((line) => line.startsWith("Binary files "));
    const kind = detectFileKind(lines);

    sections.push({
      filename,
      content: part,
      isBinary,
      kind,
    });
  }

  return sections;
}

function detectFileKind(lines: string[]): FileChangeKind {
  if (lines.some((line) => line.startsWith("new file mode "))) return "added";
  if (lines.some((line) => line.startsWith("deleted file mode "))) return "deleted";
  if (lines.some((line) => line.startsWith("rename from "))) return "renamed";
  return "modified";
}

function parseFileHunks(fileDiff: FileDiffSection): DiffHunk[] {
  if (fileDiff.isBinary) return [];

  const lines = fileDiff.content.split("\n");
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let buffer: string[] = [];
  let index = 0;

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) {
        current.content = buffer.join("\n");
        hunks.push(current);
      }
      const headerData = parseHunkHeader(line);
      current = {
        index,
        header: line,
        oldStart: headerData.oldStart,
        oldLines: headerData.oldLines,
        newStart: headerData.newStart,
        newLines: headerData.newLines,
        content: "",
      };
      buffer = [line];
      index += 1;
      continue;
    }
    if (current) buffer.push(line);
  }

  if (current) {
    current.content = buffer.join("\n");
    hunks.push(current);
  }

  return hunks;
}

function parseHunkHeader(line: string): {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
} {
  const match = line.match(/@@\s-([0-9]+)(?:,([0-9]+))?\s\+([0-9]+)(?:,([0-9]+))?\s@@/);
  if (!match) {
    return { oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 };
  }

  return {
    oldStart: Number.parseInt(match[1] ?? "0", 10) || 0,
    oldLines: Number.parseInt(match[2] ?? "1", 10) || 1,
    newStart: Number.parseInt(match[3] ?? "0", 10) || 0,
    newLines: Number.parseInt(match[4] ?? "1", 10) || 1,
  };
}

function extractFileHeader(diff: string): string {
  const lines = diff.split("\n");
  const headerLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("@@")) break;
    headerLines.push(line);
  }
  return headerLines.join("\n");
}

function joinPatch(parts: string[]): string {
  return parts
    .map((part) => (part.endsWith("\n") ? part : `${part}\n`))
    .join("\n")
    .trimEnd()
    .concat("\n");
}
