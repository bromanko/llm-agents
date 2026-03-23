export interface WorkspaceHead {
  name: string;
  changeId: string;
}

export const WORKSPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const WORKSPACE_NAME_MAX_LENGTH = 128;

export const JJ_WORKSPACE_COMMANDS = {
  currentChangeId: ["--color=never", "log", "-r", "@", "-T", "change_id", "--no-graph"],
  workspaceList: ["--color=never", "workspace", "list", "-T", 'name ++ ":" ++ self.target().change_id() ++ "\\n"'],
} as const;

function findWorkspaceSeparator(line: string): number {
  const colonIndex = line.indexOf(":");
  const pipeIndex = line.indexOf("|");

  if (colonIndex === -1) return pipeIndex;
  if (pipeIndex === -1) return colonIndex;
  return Math.min(colonIndex, pipeIndex);
}

export function isValidWorkspaceName(name: string): boolean {
  return name.length <= WORKSPACE_NAME_MAX_LENGTH && WORKSPACE_NAME_RE.test(name);
}

export function parseWorkspaceHeads(output: string): WorkspaceHead[] {
  const heads: WorkspaceHead[] = [];

  for (const rawLine of output.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const sep = findWorkspaceSeparator(line);
    if (sep === -1) continue;

    const name = line.slice(0, sep).trim();
    const changeId = line.slice(sep + 1).trim();
    if (!name || !changeId) continue;

    heads.push({ name, changeId });
  }

  return heads;
}

export function parseWorkspaceNameFromOutput(
  ourChangeId: string,
  workspaceListOutput: string,
): string | null {
  for (const workspace of parseWorkspaceHeads(workspaceListOutput)) {
    if (workspace.changeId !== ourChangeId) continue;
    return workspace.name === "default" ? null : workspace.name;
  }

  return null;
}
