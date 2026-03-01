import { execFileSync } from "node:child_process";

export interface FooterSessionEntry {
  type?: string;
  customType?: string;
  data?: unknown;
}

export interface JjInfo {
  uniquePrefix: string;
  rest: string;
  description: string;
  empty: boolean;
  insertions: number;
  deletions: number;
}

export const JJ_INFO_FIELD_SEPARATOR = "\u001f";

const JJ_INFO_TEMPLATE =
  `concat(change_id.shortest(0), "${JJ_INFO_FIELD_SEPARATOR}", change_id.short(), "${JJ_INFO_FIELD_SEPARATOR}", description.first_line(), "${JJ_INFO_FIELD_SEPARATOR}", if(empty, "empty", "dirty"))`;

export const JJ_FOOTER_COMMANDS = {
  currentChangeId: ["--color=never", "log", "-r", "@", "-T", "change_id", "--no-graph"],
  workspaceList: ["--color=never", "workspace", "list", "-T", 'name ++ ":" ++ self.target().change_id() ++ "\\n"'],
  infoLog: ["--color=never", "log", "-r", "@", "-T", JJ_INFO_TEMPLATE, "--no-graph"],
  diffStat: ["--color=never", "diff", "--stat"],
} as const;

type ExecFileSyncLike = (
  file: string,
  args: readonly string[],
  options: {
    cwd: string;
    encoding: "utf-8";
    timeout: number;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => string;

const DEFAULT_EXEC_OPTIONS = {
  encoding: "utf-8" as const,
  timeout: 3000,
  stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
};

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*m/g;
const JJ_FOOTER_DEBUG_ENABLED = process.env.PI_JJ_FOOTER_DEBUG === "1"
  || process.env.PI_JJ_FOOTER_DEBUG === "true";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function debugFooter(message: string, context?: Record<string, unknown>) {
  if (!JJ_FOOTER_DEBUG_ENABLED) return;
  if (context) {
    console.error(`[jj-footer] ${message}`, context);
    return;
  }
  console.error(`[jj-footer] ${message}`);
}

function formatCommandArgs(args: readonly string[]): string {
  return `jj ${args.join(" ")}`;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

function runJjCommand(
  cwd: string,
  args: readonly string[],
  runCommand: ExecFileSyncLike,
): string {
  return runCommand("jj", args, { cwd, ...DEFAULT_EXEC_OPTIONS });
}

export function detectWorkspaceName(
  cwd: string,
  entries?: FooterSessionEntry[],
  runCommand: ExecFileSyncLike = execFileSync as ExecFileSyncLike,
): string | null {
  if (entries) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      const isWsEntry =
        (entry.customType === "jj-workspace-state")
        || (entry.type === "jj-workspace-state");
      if (!isWsEntry) continue;

      const data = entry.data;
      if (data === null || data === undefined) return null;
      if (typeof data === "object" && data !== null && "name" in data) {
        const name = (data as { name: unknown }).name;
        return typeof name === "string" ? name : null;
      }
      return null;
    }
  }

  try {
    const ourChangeId = stripAnsi(
      runJjCommand(cwd, JJ_FOOTER_COMMANDS.currentChangeId, runCommand),
    ).trim();

    const listOutput = stripAnsi(
      runJjCommand(cwd, JJ_FOOTER_COMMANDS.workspaceList, runCommand),
    );

    let cursor = 0;
    while (cursor <= listOutput.length) {
      const nextNewline = listOutput.indexOf("\n", cursor);
      const lineEnd = nextNewline === -1 ? listOutput.length : nextNewline;
      const line = listOutput.slice(cursor, lineEnd).trim();

      if (line) {
        const sep = line.indexOf(":");
        if (sep !== -1) {
          const name = line.slice(0, sep);
          const changeId = line.slice(sep + 1);
          if (changeId === ourChangeId && name !== "default") {
            return name;
          }
        }
      }

      if (nextNewline === -1) break;
      cursor = nextNewline + 1;
    }
  } catch (error) {
    // Not in a workspace or jj not available
    debugFooter("workspace detection fallback failed", {
      cwd,
      commands: [
        formatCommandArgs(JJ_FOOTER_COMMANDS.currentChangeId),
        formatCommandArgs(JJ_FOOTER_COMMANDS.workspaceList),
      ],
      error: toErrorMessage(error),
    });
  }

  return null;
}

export function getJjInfo(
  cwd: string,
  runCommand: ExecFileSyncLike = execFileSync as ExecFileSyncLike,
): JjInfo | null {
  try {
    const logOutput = stripAnsi(
      runJjCommand(cwd, JJ_FOOTER_COMMANDS.infoLog, runCommand),
    ).trim();

    const parts = logOutput.split(JJ_INFO_FIELD_SEPARATOR);
    if (parts.length < 4) {
      debugFooter("unexpected jj info log format", {
        cwd,
        command: formatCommandArgs(JJ_FOOTER_COMMANDS.infoLog),
        partCount: parts.length,
      });
      return null;
    }

    const uniquePrefix = parts[0] ?? "";
    const fullShort = parts[1] ?? "";
    const emptyFlag = parts[parts.length - 1] ?? "";
    const description = parts.slice(2, -1).join(JJ_INFO_FIELD_SEPARATOR);

    const rest = fullShort.startsWith(uniquePrefix)
      ? fullShort.slice(uniquePrefix.length)
      : fullShort;

    let insertions = 0;
    let deletions = 0;

    try {
      const statOutput = stripAnsi(
        runJjCommand(cwd, JJ_FOOTER_COMMANDS.diffStat, runCommand),
      ).trim();

      const insertionMatch = statOutput.match(/(\d+) insertions?\(\+\)/);
      const deletionMatch = statOutput.match(/(\d+) deletions?\(-\)/);

      if (insertionMatch) {
        insertions = parseInt(insertionMatch[1], 10);
      }
      if (deletionMatch) {
        deletions = parseInt(deletionMatch[1], 10);
      }
    } catch (error) {
      // diff stats are best-effort
      debugFooter("diff stats unavailable", {
        cwd,
        command: formatCommandArgs(JJ_FOOTER_COMMANDS.diffStat),
        error: toErrorMessage(error),
      });
    }

    return {
      uniquePrefix,
      rest,
      description: description || "",
      empty: emptyFlag === "empty",
      insertions,
      deletions,
    };
  } catch (error) {
    debugFooter("failed to collect jj footer info", {
      cwd,
      command: formatCommandArgs(JJ_FOOTER_COMMANDS.infoLog),
      error: toErrorMessage(error),
    });
    return null;
  }
}
