export interface ToolExecutionContext {
  cwd?: string;
}

export function getCwd(ctx: unknown): string {
  if (typeof ctx !== "object" || ctx === null) {
    return process.cwd();
  }

  const { cwd } = ctx as ToolExecutionContext;
  return typeof cwd === "string" ? cwd : process.cwd();
}
