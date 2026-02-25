export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed: boolean;
}

/**
 * Options accepted by the exec stub.
 *
 * Mirrors the shape of the real `ExecOptions` exported by
 * `@mariozechner/pi-coding-agent` without importing it (the package is not
 * an installed npm dependency — see the comment on MockExtensionAPI below).
 * Adding fields here when the real API changes keeps the two in sync and
 * prevents `options: any` from silently accepting invalid shapes.
 */
export interface ExecOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}

/** Result a `tool_call` handler may return to block or pass through a call. */
export interface HandlerResult {
  block?: boolean;
  reason?: string;
}

/** Minimal tool-call event shape used across test files. */
export interface MockToolCallEvent {
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}

/**
 * Narrow type for the handler returned by `setupToolCallHandler` helpers.
 *
 * `getHandlers` returns `EventHandler[]` — a loose `(...args: unknown[]) =>
 * unknown` — so every call site would otherwise receive `unknown` from
 * `await handler(...)` and access `.block` / `.reason` with no compiler
 * backing.  By casting the extracted handler to this type at the single
 * return point inside each `setupToolCallHandler`, all call sites get a
 * fully-checked result type without repeating the cast.
 *
 * Generic over `Ctx` so each test file can supply its own context interface
 * (e.g. `{ cwd: string | undefined }` vs `{ sessionManager: … }`).
 */
export type MockToolCallHandler<Ctx = Record<string, unknown>> = (
  event: MockToolCallEvent,
  ctx: Ctx,
) => Promise<HandlerResult | undefined>;

/** Narrow handler type used in place of the bare `Function` type. */
type EventHandler = (...args: unknown[]) => unknown;

/**
 * Function signature for the pluggable exec implementation on the mock.
 * Defined once here so the interface declaration and the factory variable
 * share exactly the same type and cannot drift apart.
 */
type ExecFn = (
  cmd: string,
  args?: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/**
 * Stub implementation of the pi ExtensionAPI used in tests.
 *
 * Why not import the real `ExtensionAPI` type here?
 * `@mariozechner/pi-coding-agent` is not an installed npm dependency — it is
 * injected by the pi runtime at startup and is therefore unavailable to plain
 * `node` test runs. Importing it would break IDE type-checking and any CI that
 * runs tests without pi present.
 *
 * Instead of importing the real type, test files derive the expected parameter
 * type directly from the extension function under test using
 * `Parameters<typeof myExtension>[0]`, and bridge the gap with a single
 * `as unknown as <derived-type>` cast at the call site. This is safer than
 * `as any` because:
 *  - `as any` suppresses errors in both directions (checker is completely
 *    disabled for that expression).
 *  - `as unknown as T` forces the compiler to treat the value as the *exact*
 *    type T from that point on, so subsequent usage is fully checked.
 *  - `Parameters<typeof fn>[0]` re-derives T from the real function signature,
 *    so if the production API changes the type mismatch becomes visible.
 */
export interface MockExtensionAPI {
  on(event: string, handler: EventHandler): void;
  exec(command: string, args?: string[], options?: ExecOptions): Promise<ExecResult>;
  registerCommand(name: string, options: any): void;
  registerTool(definition: any): void;
  registerShortcut(shortcut: string, options: any): void;
  registerFlag(name: string, options: any): void;
  sendMessage(message: any, options?: any): void;
  sendUserMessage(content: any, options?: any): void;
  appendEntry(customType: string, data?: any): void;
  setSessionName(name: string): void;
  getSessionName(): string;
  getActiveTools(): string[];
  getAllTools(): string[];
  setActiveTools(tools: string[]): void;
  getCommands(): string[];
  getFlag(name: string): any;
  getThinkingLevel(): string;
  setThinkingLevel(level: string): void;
  registerMessageRenderer(name: string, renderer: any): void;
  registerProvider(name: string, provider: any): void;
  setModel(model: string): void;
  events: {
    on(event: string, handler: EventHandler): void;
    emit(event: string, payload?: unknown): void;
  };
  getHandlers(eventName: string): EventHandler[];
  execMock: { fn: ExecFn | null };
}

const DEFAULT_EXEC_RESULT: ExecResult = {
  code: 0,
  stdout: "",
  stderr: "",
  killed: false,
};

export function createMockExtensionAPI(): MockExtensionAPI {
  const handlers = new Map<string, EventHandler[]>();
  let sessionName = "mock-session";
  let activeTools: string[] = [];
  let thinkingLevel = "normal";

  const execMock: { fn: ExecFn | null } = { fn: null };

  const api: MockExtensionAPI = {
    on(event, handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },

    async exec(command, args = [], options) {
      const result = execMock.fn
        ? await execMock.fn(command, args, options)
        : DEFAULT_EXEC_RESULT;

      // Runtime guard: catch malformed mock return values before they
      // silently propagate to the system under test.  exec results drive
      // block/allow decisions in extensions such as ci-guard, so a poorly
      // typed mock could mask real bugs or security regressions.
      if (
        typeof result.code !== "number" ||
        typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        typeof result.killed !== "boolean"
      ) {
        throw new Error(
          `execMock.fn returned an invalid ExecResult: ${JSON.stringify(result)}`,
        );
      }

      return result;
    },

    registerCommand() {},
    registerTool() {},
    registerShortcut() {},
    registerFlag() {},
    sendMessage() {},
    sendUserMessage() {},
    appendEntry() {},

    setSessionName(name) {
      sessionName = name;
    },

    getSessionName() {
      return sessionName;
    },

    getActiveTools() {
      return [...activeTools];
    },

    getAllTools() {
      return [];
    },

    setActiveTools(tools) {
      activeTools = [...tools];
    },

    getCommands() {
      return [];
    },

    getFlag() {
      return undefined;
    },

    getThinkingLevel() {
      return thinkingLevel;
    },

    setThinkingLevel(level) {
      thinkingLevel = level;
    },

    registerMessageRenderer() {},
    registerProvider() {},
    setModel() {},

    events: {
      on() {},
      emit() {},
    },

    getHandlers(eventName) {
      return handlers.get(eventName) ?? [];
    },

    execMock,
  };

  return api;
}
