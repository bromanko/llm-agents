# Design: jj-workspace-tmux

Now I have all the information I need. Let me produce the revised design document.

# jj-workspace tmux-based Isolation — Design Document (v2)

## Problem Statement

The current `jj-workspace` extension (`pi/jj/extensions/jj-workspace.ts`) virtualizes CWD by intercepting and overriding built-in tools (`read`, `write`, `edit`, `bash`), rewriting the system prompt, and intercepting `user_bash` events. While functional, this approach has concrete shortcomings:

1. **The `@` file picker doesn't work** — it is bound to `process.cwd()` and cannot be overridden by extensions, so workspace sessions cannot use `@` to browse workspace files.
2. **Other extensions need CWD hardening** — extensions like `/jj-review` and `/review` must special-case workspace CWD to function correctly, creating a leaky abstraction that infects the broader extension ecosystem.
3. **Cognitive complexity** — the virtual CWD model is non-obvious. The OS-level CWD, the prompt CWD, the tool CWD, and the `user_bash` CWD are all separate concepts that happen to align only because of careful interception. A single missed interception point breaks the illusion.
4. **Large surface area of override code** — tool override factories, `user_bash` interception, `before_agent_start` prompt rewriting, and session state persistence/restoration constitute substantial complexity that exists solely to maintain the virtual CWD fiction.

The proposed replacement spawns actual, independent pi sessions in dedicated tmux windows for each workspace. Each workspace pi session runs with its OS-level `process.cwd()` set to the workspace directory, eliminating all virtual CWD machinery.

## Goals

1. **Real OS-level CWD isolation** — each workspace pi session has `process.cwd()` set to its workspace directory. All tools, the `@` file picker, extensions, and `user_bash` work correctly without any interception.
2. **Leverage tmux windows** for workspace session management — creation, switching, listing, and cleanup use tmux's existing window model.
3. **Dramatically simplify the extension** — remove all tool CWD overrides, `user_bash` interception, `before_agent_start` prompt rewriting, and session state persistence/restoration.
4. **Fix `@` file picker** — works automatically because `process.cwd()` is correct in each workspace session.
5. **Eliminate cross-extension CWD coupling** — no extension ever needs to special-case workspace CWD again.

## Non-Goals

- **Supporting non-tmux users** — can expand later; tmux is a hard requirement for now.
- **Pane-based layout management** — users can convert tmux windows to panes manually via standard tmux keybindings.
- **Inheriting conversational context** from the parent pi session into workspace sessions — each workspace session starts fresh (or resumes its own session).
- **Automatic cleanup of tmux windows when pi exits** — handled by tmux's `remain-on-exit` (see Tmux Window Lifecycle Model).

## Proposed Architecture

### High-Level Model

```
┌─────────────────────────────────────────────────────────────────────┐
│ tmux session                                                        │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ window: "pi"     │  │ window: "ws:auth" │  │ window: "ws:ui"  │  │
│  │                  │  │                   │  │                  │  │
│  │  pi session      │  │  pi session       │  │  pi session      │  │
│  │  cwd: /repo      │  │  cwd: /repo-ws-   │  │  cwd: /repo-ws-  │  │
│  │                  │  │       auth        │  │       ui         │  │
│  │  (default ws)    │  │                   │  │                  │  │
│  │  manages:        │  │  independent      │  │  independent     │  │
│  │  /ws-create      │  │  session          │  │  session         │  │
│  │  /ws-finish      │  │                   │  │                  │  │
│  │  /ws-list        │  │                   │  │                  │  │
│  │  /ws-switch      │  │                   │  │                  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                     │
│          ▲ orchestrates ──────────────────────────▶                  │
└─────────────────────────────────────────────────────────────────────┘
```

The **default workspace session** (the pi instance where the user runs `/ws-create`, `/ws-finish`, etc.) is the orchestrator. It creates/destroys tmux windows and manages jj workspace lifecycle. Workspace pi sessions are independent — they know nothing about the orchestration layer.

### Key Architectural Decision: Orchestrator-Only Commands

All `/ws-*` commands run exclusively in the default workspace session. Workspace sessions are just normal pi sessions that happen to have their CWD in a workspace directory. They don't register any workspace commands.

This is a deliberate simplification: the default session owns the lifecycle (create, finish, list, switch), and workspace sessions own the work (coding, reviewing, committing).

### Tmux Window Lifecycle Model

**Decision: windows auto-close when `pi` exits; `/ws-switch` re-creates them.**

When `tmux new-window` runs `pi` as its shell command, tmux destroys the window when `pi` exits (this is tmux's default behavior — see `remain-on-exit off`). We do **not** set `remain-on-exit` because:

- Leaving dead panes with "[Pane exited]" is confusing and clutters the tmux status bar.
- The user has no obvious affordance to respawn or close the dead pane.
- `/ws-switch` already handles the "window is gone" case by re-creating it with `pi -c`.

This means:
- **Window exists** → `pi` is running (or at least the process hasn't exited yet).
- **Window is gone** → `pi` exited (user quit, crashed, etc.). The jj workspace and its directory still exist on disk; only the tmux window is gone.
- `/ws-switch` detects the missing window and creates a fresh one with `pi -c` (auto-continue most recent session in that workspace directory).
- `/ws-list` marks workspaces as `[window: live]` or `[window: —]` based on window existence.
- `/ws-finish` only needs to kill a window if it exists at the time of finish; if it's already gone, that step is skipped.

### Tmux Window Identification: User Options

Rather than relying on window name matching (which is fragile due to `tmux-titles` appending/prepending status icons), workspace windows are tagged with a **tmux user option** (`@pi-ws`) set on the window:

```
tmux set-window-option -t <window-id> @pi-ws <workspace-name>
```

Window lookup uses:

```
tmux list-windows -F '#{window_id} #{@pi-ws}'
```

This approach:
- Is immune to `tmux-titles` icon suffixes/prefixes modifying `#{window_name}`.
- Survives user renaming the window.
- Requires no state tracking inside the extension — the tmux server is the source of truth.
- Is supported by tmux 2.1+ (user options via `@` prefix).

The window is still **named** `ws:<name>` for visual identification in the tmux status bar, but name is cosmetic only; lookup is by `@pi-ws` option.

### Tmux Capability Contract

**Minimum tmux version: 3.0.**

The extension depends on the following tmux features:

| Feature | Minimum Version | Used By |
|---------|-----------------|---------|
| `new-window -c` | 1.9 | Setting workspace CWD |
| User options (`@name`) | 2.1 | Window tagging via `@pi-ws` |
| `new-window -e` | 3.0 | (Reserved, not used in v1 — see note below) |
| `list-windows -F '#{@option}'` | 2.1 | Window discovery |

**Note on `-e` (environment variables):** The initial design considered `new-window -e PI_WS_NAME=<name>` to pass workspace context to child pi processes. This is **not used in v1** — workspace windows are plain `pi` processes that discover their workspace name from their CWD via existing `jj workspace list` + `jj log -r @ -T change_id` logic (already implemented in `jj-footer.ts`). This removes the `-e` dependency and makes the minimum version requirement simpler.

**Enforcement:** At extension load time, the extension runs `tmux -V` and parses the version number. If the version is below 3.0, it skips registration and emits a notification explaining the minimum version requirement.

```typescript
async function getTmuxVersion(pi: ExtensionAPI): Promise<number | null> {
  const result = await pi.exec("tmux", ["-V"], { timeout: 3000 });
  if (result.code !== 0) return null;
  // "tmux 3.6a" → 3.6
  const match = (result.stdout ?? "").match(/tmux\s+(\d+\.\d+)/);
  return match ? parseFloat(match[1]) : null;
}
```

## Component Responsibilities

### 1. Tmux Guard

**Responsibility:** Early-exit the extension if not running inside tmux, or if tmux version is insufficient.

- Check `process.env.TMUX` (reuse pattern from `tmux-titles.ts`).
- If not in tmux, skip all command registration and notify that workspace features require tmux.
- If in tmux, parse `tmux -V` output and verify version ≥ 3.0.
- If version is insufficient, skip registration with a version-specific error message.

### 2. Tmux Window Manager (internal module)

**Responsibility:** Abstract tmux CLI interactions into a testable interface.

Operations:
- `listWorkspaceWindows()` → list tmux windows tagged with `@pi-ws`, returning workspace name, window ID, and active status
- `findWorkspaceWindow(wsName: string)` → find a window where `@pi-ws == wsName`, return window ID or null
- `createWorkspaceWindow(wsName: string, cwd: string)` → atomic create-and-tag (see Atomic Window Creation)
- `selectWindow(windowId: string)` → `tmux select-window -t <windowId>`
- `killWindow(windowId: string)` → `tmux kill-window -t <windowId>`

All operations use `pi.exec("tmux", [...])` for consistency with the existing exec pattern and testability via the mock exec infrastructure.

#### Atomic Window Creation

Window creation and tagging must be atomic from the extension's perspective. The sequence is:

```
1. tmux new-window -d -P -F '#{window_id}' -n "ws:<name>" -c <cwd> "pi -c"
   → captures the new window ID (e.g., "@7")
   → -d prevents auto-switching (we switch explicitly after tagging)

2. tmux set-window-option -t @7 @pi-ws <name>
   → tags the window

3. tmux select-window -t @7
   → switches to the new window
```

**Failure handling:**
- If step 1 fails: report error, no cleanup needed.
- If step 2 (tagging) fails: `tmux kill-window -t @7` to destroy the untagged window, then report error. The jj workspace was already created before this sequence, so the jj workspace persists but no orphaned tmux window remains.
- If step 3 (select) fails: non-fatal — the window exists and is tagged, the user just isn't switched to it. Report warning.

### 3. Workspace Lifecycle Manager (slash commands)

**Responsibility:** Implement `/ws-create`, `/ws-switch`, `/ws-list`, `/ws-finish`.

Delegates to jj CLI for workspace operations and to Tmux Window Manager for window operations. Contains no tool overrides, no prompt rewriting, no session state persistence.

### 4. jj Workspace Operations (internal helpers)

**Responsibility:** Wrap jj CLI calls for workspace management. Carried over largely unchanged from current implementation.

- `runJj(args, options)` — execute jj with `--color=never`
- `listWorkspaceHeads()` — parse templated `jj workspace list` output using `name` and `self.target().change_id()` (both confirmed available in jj 0.39 `WorkspaceRef` type)
- `resolveWorkspacePath(name)` — `jj workspace root --name <name>` (confirmed available in jj 0.39)
- `getUniqueWorkspaceChanges(name)` — query mutable commits unique to workspace
- `getPreMergeOpId()` — capture operation ID for rollback
- `safeDeleteWorkspaceDir(wsPath, repoRoot)` — guarded directory deletion

### 5. Merge Engine (within `/ws-finish`)

**Responsibility:** Deterministic merge with conflict rollback. Preserved from current implementation with one addition: tmux window cleanup (if window exists) before directory deletion.

## Interfaces / APIs

### Command Interface

| Command | Arguments | Preconditions | Behavior |
|---------|-----------|---------------|----------|
| `/ws-create <name>` | workspace name (required) | In tmux ≥ 3.0, in jj repo, in default workspace CWD | Creates jj workspace, spawns tmux window `ws:<name>` tagged with `@pi-ws=<name>`, running `pi -c` at workspace CWD |
| `/ws-switch <name>` | workspace name (required) | In tmux ≥ 3.0, workspace exists in jj | Focuses existing workspace window (by `@pi-ws` tag), or creates new one with `pi -c` if window is gone |
| `/ws-list` | none | In tmux ≥ 3.0, in jj repo | Shows all non-default workspaces with tmux window status indicators |
| `/ws-finish <name>` | workspace name (required) | In tmux ≥ 3.0, in jj repo, CWD is default workspace root | Confirms, kills live tmux window if present, merges, forgets workspace, deletes directory |

### Tmux Window Manager Interface

```typescript
interface TmuxWorkspaceWindow {
  windowId: string;     // tmux window ID (e.g., "@7")
  windowName: string;   // display name (e.g., "ws:auth ✻")
  wsName: string;       // workspace name from @pi-ws option
  active: boolean;      // whether window is currently selected
}

interface TmuxWindowManager {
  listWorkspaceWindows(): Promise<TmuxWorkspaceWindow[]>;
  findWorkspaceWindow(wsName: string): Promise<TmuxWorkspaceWindow | null>;
  createWorkspaceWindow(wsName: string, cwd: string): Promise<{ ok: true; windowId: string } | { ok: false; error: string }>;
  selectWindow(windowId: string): Promise<boolean>;
  killWindow(windowId: string): Promise<boolean>;
}
```

### jj Operations Interface (unchanged from current)

```typescript
interface JjResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface WorkspaceHead {
  name: string;
  changeId: string;
}

interface WorkspaceChange {
  changeId: string;
  description: string;
  empty: boolean;
  conflict: boolean;
}
```

## Data Flow

### `/ws-create <name>`

```
User ─── /ws-create auth ───▶ Extension
  │
  ├─ validate name (regex, length)
  ├─ jj root → repo root path
  ├─ compute wsPath = <repo-root>/../<repo-name>-ws-auth
  ├─ check !existsSync(wsPath)
  │
  ├─ jj workspace add --name auth <wsPath>
  │   └─ [failure] → report error, STOP
  │
  ├─ createWorkspaceWindow("auth", wsPath):
  │   ├─ tmux new-window -d -P -F '#{window_id}' -n "ws:auth" -c <wsPath> pi -c
  │   │   └─ [failure] → jj workspace forget auth, safeDelete(wsPath), report error, STOP
  │   │
  │   ├─ tmux set-window-option -t <windowId> @pi-ws auth
  │   │   └─ [failure] → tmux kill-window -t <windowId>, report error, STOP
  │   │   (jj workspace persists — user can re-try /ws-create or /ws-switch)
  │   │
  │   └─ tmux select-window -t <windowId>
  │       └─ [failure] → warn (non-fatal, window exists)
  │
  └─ notify success
```

### `/ws-switch <name>`

```
User ─── /ws-switch auth ───▶ Extension
  │
  ├─ jj workspace list → verify workspace exists
  │   └─ [not found] → report error, STOP
  │
  ├─ findWorkspaceWindow("auth") → lookup by @pi-ws tag
  │
  ├─ [window exists]
  │   └─ tmux select-window -t <windowId>
  │
  └─ [window gone]
      ├─ jj workspace root --name auth → wsPath
      ├─ verify existsSync(wsPath)
      │   └─ [missing] → report error, STOP
      └─ createWorkspaceWindow("auth", wsPath)
          └─ (same atomic create-tag-select sequence as /ws-create)
```

### `/ws-list`

```
User ─── /ws-list ───▶ Extension
  │
  ├─ jj workspace list → all workspaces with heads
  ├─ listWorkspaceWindows() → all windows tagged with @pi-ws
  ├─ for each non-default workspace:
  │   ├─ resolve path via jj workspace root --name <name>
  │   ├─ match against workspace windows by wsName
  │   └─ mark as [window: live] or [window: —]
  └─ render table/list to notification
```

### `/ws-finish <name>`

```
User ─── /ws-finish auth ───▶ Extension
  │
  ├─ validate: name is not "default"
  ├─ validate: CWD == jj root (not inside a workspace)
  ├─ jj workspace list → verify workspace exists
  │   └─ [not found] → report error, STOP
  ├─ jj workspace root --name auth → wsPath
  │
  ├─ findWorkspaceWindow("auth") → check for live window
  │   └─ [window exists]
  │       ├─ warn: "Workspace 'auth' has a live pi session (window <windowId>). Kill it?"
  │       ├─ confirm Y/n
  │       │   ├─ [Y] → tmux kill-window -t <windowId>
  │       │   │   └─ [kill fails] → re-check: findWorkspaceWindow("auth")
  │       │   │       ├─ [still exists] → report error "Cannot kill workspace window", STOP
  │       │   │       └─ [gone] → continue (race: window closed between kill and re-check)
  │       │   └─ [n] → abort finish
  │
  ├─ confirm: "Finish workspace 'auth'? This will merge and delete <wsPath>"
  ├─ query unique workspace changes
  ├─ preflight: reject if conflicted commits exist
  ├─ preflight: reject if default@ has uncommitted changes
  ├─ abandon all-empty commits if applicable
  │
  ├─ [has commits to merge]
  │   ├─ capture pre-merge op ID
  │   ├─ jj new default@ <heads...> -m "finish workspace auth"
  │   ├─ check conflict on @
  │   │   ├─ [conflict] → jj op restore <opId>, notify error, STOP
  │   │   └─ [clean] → continue
  │
  ├─ jj workspace forget auth
  ├─ safeDeleteWorkspaceDir(wsPath, repoRoot)
  └─ notify summary with recent history
```

## Feature Set

1. **Workspace creation with tmux window** — `/ws-create <name>` creates a jj workspace and spawns a new tmux window named `ws:<name>`, tagged with `@pi-ws=<name>`, running `pi -c` with CWD set to the workspace directory. If the tmux window creation or tagging fails, the jj workspace is cleaned up (or the window is killed, respectively).

2. **Workspace switching via tmux** — `/ws-switch <name>` focuses the existing workspace tmux window (discovered by `@pi-ws` tag). If the window was closed (pi exited), creates a new tmux window with `pi -c` to auto-continue the most recent session in that workspace directory.

3. **Workspace listing with tmux status** — `/ws-list` shows all non-default jj workspaces with their change IDs, paths, and whether a corresponding tmux window is currently live.

4. **Workspace finishing with tmux cleanup** — `/ws-finish <name>` detects a live tmux window via `@pi-ws` tag lookup, warns, confirms, kills it (with post-kill verification), then performs the existing deterministic merge with conflict rollback, workspace forget, and directory deletion.

5. **Deterministic merge with conflict rollback** — carried over unchanged from the current implementation. Creates an explicit merge commit via `jj new default@ <heads...>`, detects conflicts, and rolls back via `jj op restore` if needed.

6. **Command completions** — `/ws-switch` and `/ws-finish` provide tab completions from the cached workspace list.

## Operational Considerations

### Tmux Detection and Version Check

The extension performs two checks at load time:

1. **Tmux presence:** Check `process.env.TMUX` (reuse pattern from `tmux-titles.ts`). If not in tmux, skip registration.
2. **Tmux version:** Run `tmux -V`, parse version number, require ≥ 3.0. If version is insufficient, skip registration with a descriptive notification.

```typescript
function inTmux(): boolean {
  const term = process.env.TERM ?? "";
  return !!(
    process.env.TMUX ||
    process.env.TERM_PROGRAM === "tmux" ||
    term.startsWith("tmux") ||
    term === "screen"
  );
}
```

### Window Naming Convention

Tmux windows are named `ws:<name>` (e.g., `ws:auth`, `ws:ui-refactor`). The `ws:` prefix makes workspace windows visually identifiable in the tmux status bar. However, **the name is cosmetic only** — all programmatic lookup uses the `@pi-ws` user option set on the window. This decouples workspace identification from name mutations by `tmux-titles` or the user.

### `pi -c` for Workspace Sessions

Workspace tmux windows run `pi -c` (auto-continue most recent session). This is used for both initial creation and re-creation via `/ws-switch`:

- **Initial creation:** `pi -c` starts a fresh session if none exists in the workspace directory (since pi session storage is keyed by CWD, a new workspace directory has no prior sessions).
- **Re-creation after window close:** `pi -c` reconnects to the most recent session from that workspace directory, preserving the user's conversation history.

`pi -c` was chosen over `pi --resume` (interactive session picker) because:
- It is more seamless — no interactive picker step when there's exactly one session.
- If there are multiple sessions from the same directory, `pi -c` deterministically picks the most recent, which is the expected behavior.
- The user can always run `pi --resume` manually inside the workspace window if they need the picker.

### `jj-footer` Workspace Name Detection — Compatibility Verified

The `jj-footer` extension already handles workspace name detection correctly for the tmux model. Its approach:

1. First checks session entries for `jj-workspace-state` custom entries (the virtual CWD model's state). In the new tmux model, no such entries exist, so this falls through.
2. Falls back to: `jj log -r @ -T change_id --no-graph` to get the current commit's change ID, then `jj workspace list -T 'name ++ ":" ++ self.target().change_id() ++ "\n"'` to find which workspace has that change ID.

Both of these commands use `ctx.cwd` (which equals `process.cwd()` in the new model), so they naturally resolve to the correct workspace. **Verified against jj 0.39:** the `WorkspaceRef` type exposes `.name()` and `.target()` methods, and the templates used by `jj-footer` (`name`, `self.target().change_id()`) are confirmed working.

**No changes to `jj-footer` are required.** Once the virtual CWD machinery is removed, the `jj-workspace-state` entry check becomes dead code that harmlessly falls through. It can be cleaned up in a follow-up.

### `/ws-finish` Must Run From Default Session

The `/ws-finish` command verifies that `process.cwd()` matches `jj root` output (the repository root). If CWD is a workspace directory, the command refuses to run.

This constraint exists because:
- The merge creates a commit in the default workspace's commit graph.
- Deleting the workspace directory from within a session running in that directory would fail.
- The orchestrator mental model (default session manages lifecycle) is preserved.

### Interaction with `tmux-titles` Extension

The `tmux-titles` extension modifies tmux window names by appending/prepending status icons (e.g., `ws:auth` → `ws:auth ✻`). Because workspace discovery uses the `@pi-ws` user option (not window name), this coexistence is automatic — no special handling needed.

### What Happens When the User Manually Renames a Window

If the user renames `ws:auth` to something else, the `@pi-ws` option remains set. The window is still discoverable. If the user closes and re-creates a window at the same workspace path manually (without going through `/ws-switch`), the `@pi-ws` tag won't be present on the new window, but `/ws-switch` will handle this by creating a properly tagged window.

### Shell Command for Workspace Windows

The tmux window runs `pi -c` directly as its shell command via:

```
tmux new-window -d -n "ws:auth" -c <wsPath> pi -c
```

Since `tmux new-window -c <dir>` sets the working directory for the shell command, and `pi` reads `process.cwd()` at startup, this is sufficient. We do **not** use `cd <dir> && pi -c` because:
- `-c` already sets CWD before the command runs (it's not a shell-level cd).
- Adding `cd` would require wrapping in `sh -c`, which complicates quoting and adds a shell layer.
- User shell profiles (`~/.bashrc`, `~/.zshrc`) are not sourced because `pi` is run directly, not via a login shell. This is intentional — we want a clean environment.

## Risks and Trade-Offs

### Risk: Tmux Dependency Excludes Non-Tmux Users

**Severity:** Medium  
**Mitigation:** The extension cleanly no-ops outside tmux. A future alternative backend (e.g., terminal tabs, kitty windows) could be added behind the same command interface.  
**Trade-off accepted:** Cleaner isolation for tmux users outweighs reduced reach.

### Risk: Killing Tmux Windows Loses Unsaved Work

**Severity:** Medium  
**Mitigation:** `/ws-finish` warns explicitly that a live workspace session exists and requires Y/n confirmation before killing. The warning message names the window and indicates it has a running process.  
**Trade-off accepted:** User must explicitly confirm destruction.

### Risk: Race Between `/ws-finish` Window Kill and Process Cleanup

**Severity:** Low  
`tmux kill-window` sends SIGHUP to processes in the window. The pi process in the workspace window will be killed. If pi is mid-write, the filesystem may have partial changes.  
**Mitigation:** The merge operates on **committed jj state**, not filesystem state. `jj new default@ <heads...>` references committed revisions. Partial filesystem writes in the workspace directory don't affect the merge because: (1) uncommitted changes would have been caught by the preflight check on default@ emptiness, and (2) the workspace directory is about to be deleted anyway.

### Risk: `/ws-finish` Window Kill Failure

**Severity:** Low  
If `tmux kill-window` fails (e.g., tmux server disconnected), the extension could proceed to `workspace forget` and directory deletion while a pi process is still running.  
**Mitigation:** After `kill-window`, re-check with `findWorkspaceWindow()`. If the window is still present, abort with a clear error message. Only proceed with forget/delete when the window is confirmed gone (or was never present).

### Risk: Window Creation Partial Failure (Tag Step)

**Severity:** Low  
`new-window` succeeds but `set-window-option @pi-ws` fails, leaving an untagged window.  
**Mitigation:** If tagging fails, immediately `kill-window` on the new window ID (captured from `new-window -P -F '#{window_id}'`). The jj workspace persists on disk; the user can retry `/ws-create` or use `/ws-switch`. This is explicitly documented in the Atomic Window Creation section.

### Risk: `pi -c` Session Matching

**Severity:** Low  
If the user has multiple pi sessions from the same workspace directory, `pi -c` auto-continues the most recent. If the user wants a different session, they can run `pi --resume` manually inside the window.  
**Trade-off accepted:** `pi -c` is the right default for the common case (one session per workspace).

### Trade-Off: No Context Inheritance

Workspace sessions start fresh — they don't inherit the parent session's conversation, tools, or system prompt context. This means the user must re-explain context when switching to a workspace.  
**Why acceptable:** Context inheritance would require serializing and deserializing session state across process boundaries, which is complex and fragile. The `pi -c` model (reconnect to a workspace's own session history) is simpler and more predictable.

### Trade-Off: Simpler Extension at Cost of External Dependency

The new design trades internal complexity (tool overrides, prompt rewriting) for external dependency (tmux ≥ 3.0). The extension code becomes dramatically simpler, but users must have tmux.

## Alternatives Considered

### Alternative 1: Keep Virtual CWD Approach, Fix `@` Picker

Add an extension API to override the `@` file picker's root directory.

**Rejected because:**
- Only fixes one symptom. Other extensions still need CWD hardening.
- Requires pi core changes (new API surface) for a single use case.
- Does not reduce the inherent cognitive complexity of virtual CWD.

### Alternative 2: `cd` to Workspace in Same Process

Actually change `process.chdir()` to the workspace directory within the same pi session.

**Rejected because:**
- `process.chdir()` is global and affects all code in the process, including pi internals.
- Cannot maintain multiple "current directories" — there's only one `process.cwd()`.
- Returning to default requires another `chdir`, which could race with in-flight operations.
- Pi's file watcher, session storage, and other internals assume stable CWD.

### Alternative 3: Tmux Panes Instead of Windows

Use tmux panes (splits) instead of windows, so all workspaces are visible simultaneously.

**Rejected because:**
- Pane layout management is complex (resizing, swapping).
- Users can convert windows to panes manually via `Ctrl-B !` / `join-pane`.
- Windows are simpler to create, switch, and kill programmatically.
- Keeps the extension simple; layout is the user's domain.

### Alternative 4: Child Process Without Tmux

Spawn `pi` as a direct child process and pipe stdio.

**Rejected because:**
- TUI applications (pi uses a TUI) cannot be meaningfully piped — they need a real terminal.
- No way for the user to interact with the child session.
- Would require a pseudo-terminal allocation layer, effectively reimplementing tmux.

### Alternative 5: Detached Terminal Emulator Windows

Spawn new terminal emulator windows (e.g., via `xterm`, `$TERMINAL`).

**Rejected because:**
- Not portable across terminal emulators.
- No standardized API for window management (switching, killing, listing).
- tmux is already in the critical path for the target users.

### Alternative 6: Name-Based Window Lookup with Prefix Matching

Use `#{window_name}` and prefix-match `ws:<name>` to find workspace windows.

**Rejected because:**
- `tmux-titles` extension appends icons to window names, so `ws:auth` becomes `ws:auth ✻`.
- Users can rename windows manually, breaking the match.
- Requires fragile regex matching with edge cases around icon characters.
- User option `@pi-ws` is more robust and tmux-native.

### Alternative 7: `remain-on-exit` to Keep Dead Windows

Set `remain-on-exit on` on workspace windows so they persist after `pi` exits.

**Rejected because:**
- Dead panes show "[Pane exited]" which is confusing to users who don't know tmux internals.
- Requires `respawn-window` or `kill-window` to clean up, adding another user responsibility.
- Clutters the tmux status bar with dead workspace windows.
- `/ws-switch` re-creating the window with `pi -c` is a cleaner UX.

## Open Questions

1. **Should workspace sessions register any commands?** — Currently proposed as "no" — workspace sessions are plain pi sessions. But should they at least have a `/ws-info` that shows which workspace they're in? This is low-priority since the tmux window name already indicates it, and `jj workspace root` works from any workspace.

2. **Should `/ws-create` accept additional arguments?** — e.g., an initial commit description, or a revision to base the workspace on (`jj workspace add --revision <rev>`). This could be deferred to a follow-up.

3. **Should `/ws-create` clean up the jj workspace if tmux window creation fails?** — The current design says yes: if `tmux new-window` fails after `jj workspace add` succeeds, run `jj workspace forget` and `safeDeleteWorkspaceDir`. But this could be aggressive — the user might want to keep the jj workspace and just retry the window creation. **Decision: clean up.** A partially-created workspace with no window is confusing; the user can always re-run `/ws-create`.

4. **How should the extension handle tmux server disconnection during operations?** — If the tmux server becomes unreachable mid-operation (e.g., during `/ws-finish`), `pi.exec("tmux", ...)` will fail. The extension treats all tmux failures as errors and reports them. Since jj operations are independent of tmux, the worst case is a workspace that exists in jj but has no tmux window — which is a normal state (equivalent to "window was closed").

## Debate Outcome
- Consensus not fully reached
- Architect B did not accept the design after 3 rounds. The latest draft is preserved below, followed by unresolved disagreement notes.
- Architect A: anthropic/claude-opus-4-6 (high)
- Architect B: openai-codex/gpt-5.4 (xhigh)

## Unresolved Disagreements

## Verdict: REJECT

## Summary
The core direction is good: replacing virtual CWD with real tmux-backed processes is the right simplification. But the draft is not safe enough as written. It still has a data-loss hole in `/ws-finish`, the session lifecycle semantics are wrong for fresh workspace creation, and key boundaries around tmux liveness and orchestrator-only command registration are still underspecified.

## Critical Objections
- `/ws-finish` can silently lose real workspace edits. `jj` commands run from the default workspace do **not** automatically snapshot dirty files in another workspace directory. If `/repo-ws-auth` has on-disk edits and the orchestrator kills the tmux window, merges `auth@`, forgets the workspace, and deletes the directory, those edits can be dropped without ever entering the merge. The draft's "merge operates on committed jj state" argument does not solve this; it is the problem.

<!-- FEEDBACK: Good catch. We should detect dirty, uncommitted files, and show an error in that case -->

- `pi -c` for `/ws-create` violates the stated fresh-session model. Pi sessions are organized by cwd and persist after the workspace directory is deleted. Reusing the same workspace name/path can reopen stale conversation state from an older incarnation of that workspace, which is not "fresh."
- The liveness model is too optimistic. The design now depends on "window exists = live pi session" and on windows auto-closing when `pi` exits, but that assumption fails if tmux is configured with `remain-on-exit on` or the user repurposes the window. `/ws-switch` and `/ws-list` can then misclassify dead/non-pi windows as live.

    <!-- FEEDBACK: This is low likelihood -->
- "Orchestrator-only commands" is asserted but not actually designed. The extension loads in any jj repo, so workspace child sessions will also load it unless there is an explicit default-vs-workspace detection path at startup. The proposed `process.cwd() == jj root` check is also the wrong proxy; it rejects legitimate default sessions launched from a repo subdirectory.

## Suggested Revisions
- Add a workspace-local `/ws-finish` preflight that runs a harmless `jj` command with `cwd: wsPath` to snapshot that workspace before evaluating merge heads. Then explicitly detect dirty workspace state and refuse destructive cleanup until the state is snapshotted/confirmed.
- Split launch semantics: use a **new** pi session for `/ws-create`, and reserve `pi -c` or `pi --resume` for `/ws-switch` re-creation only. If reused workspace names are allowed, define whether old session files are retained or pruned.
- Make window liveness explicit instead of inferring it from existence. Either force `remain-on-exit off` per workspace window, or inspect tmux state like dead-pane/current-command in addition to the `@pi-ws` tag.
- Either define a real startup-time mechanism for suppressing `/ws-*` registration in non-default workspace sessions, or drop the "orchestrator-only registration" rule and keep the commands available everywhere with strong guards. In either case, detect "default workspace" by workspace identity, not raw cwd equality.

## Design Brief Used For Debate

# Design: jj-workspace tmux-based Isolation

## Problem Statement

The current `jj-workspace` extension (`pi/jj/extensions/jj-workspace.ts`) virtualizes CWD by intercepting and overriding built-in tools (`read`, `write`, `edit`, `bash`), rewriting the system prompt, and intercepting `user_bash` events. While functional, this approach has concrete shortcomings:

1. **The `@` file picker doesn't work** — it is bound to `process.cwd()` and cannot be overridden by extensions, so workspace sessions cannot use `@` to browse workspace files.
2. **Other extensions need CWD hardening** — extensions like `/jj-review` and `/review` must special-case workspace CWD to function correctly, creating a leaky abstraction that infects the broader extension ecosystem.
3. **Cognitive complexity** — the virtual CWD model is non-obvious. The OS-level CWD, the prompt CWD, the tool CWD, and the `user_bash` CWD are all separate concepts that happen to align only because of careful interception. A single missed interception point breaks the illusion.
4. **Large surface area of override code** — tool override factories, `user_bash` interception, `before_agent_start` prompt rewriting, and session state persistence/restoration constitute substantial complexity that exists solely to maintain the virtual CWD fiction.

The proposed replacement spawns actual, independent pi sessions in dedicated tmux windows for each workspace. Each workspace pi session runs with its OS-level `process.cwd()` set to the workspace directory, eliminating all virtual CWD machinery.

## Goals

1. **Real OS-level CWD isolation** — each workspace pi session has `process.cwd()` set to its workspace directory. All tools, the `@` file picker, extensions, and `user_bash` work correctly without any interception.
2. **Leverage tmux windows** for workspace session management — creation, switching, listing, and cleanup use tmux's existing window model.
3. **Dramatically simplify the extension** — remove all tool CWD overrides, `user_bash` interception, `before_agent_start` prompt rewriting, and session state persistence/restoration.
4. **Fix `@` file picker** — works automatically because `process.cwd()` is correct in each workspace session.
5. **Eliminate cross-extension CWD coupling** — no extension ever needs to special-case workspace CWD again.

## Non-Goals

- **Supporting non-tmux users** — can expand later; tmux is a hard requirement.
- **Pane-based layout management** — users can convert tmux windows to panes manually via standard tmux keybindings.
- **Inheriting conversational context** from the parent pi session into workspace sessions — each workspace session starts fresh (or resumes its own session).
- **Automatic cleanup of tmux windows when pi exits** — orphaned empty tmux windows are the user's responsibility.

## Proposed Architecture

### High-Level Model

```
┌─────────────────────────────────────────────────────────────────────┐
│ tmux session                                                        │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ window: "pi"     │  │ window: "ws:auth" │  │ window: "ws:ui"  │  │
│  │                  │  │                   │  │                  │  │
│  │  pi session      │  │  pi session       │  │  pi session      │  │
│  │  cwd: /repo      │  │  cwd: /repo-ws-   │  │  cwd: /repo-ws-  │  │
│  │                  │  │       auth        │  │       ui         │  │
│  │  (default ws)    │  │                   │  │                  │  │
│  │  manages:        │  │  independent      │  │  independent     │  │
│  │  /ws-create      │  │  session          │  │  session         │  │
│  │  /ws-finish      │  │                   │  │                  │  │
│  │  /ws-list        │  │                   │  │                  │  │
│  │  /ws-switch      │  │                   │  │                  │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                     │
│          ▲ orchestrates ──────────────────────────▶                  │
└─────────────────────────────────────────────────────────────────────┘
```

The **default workspace session** (the pi instance where the user runs `/ws-create`, `/ws-finish`, etc.) is the orchestrator. It creates/destroys tmux windows and manages jj workspace lifecycle. Workspace pi sessions are independent — they know nothing about the orchestration layer.

### Key Architectural Decision: Orchestrator-Only Commands

All `/ws-*` commands run exclusively in the default workspace session. Workspace sessions are just normal pi sessions that happen to have their CWD in a workspace directory. They don't register any workspace commands.

This is a deliberate simplification: the default session owns the lifecycle (create, finish, list, switch), and workspace sessions own the work (coding, reviewing, committing).

## Component Responsibilities

### 1. Tmux Guard

**Responsibility:** Early-exit the extension if not running inside tmux.

- Check `process.env.TMUX` or equivalent (reuse pattern from `tmux-titles.ts`).
- If not in tmux, skip all command registration and notify that workspace features require tmux.
- If in tmux, continue to register commands.

### 2. Tmux Window Manager (internal module)

**Responsibility:** Abstract tmux CLI interactions into a testable interface.

Operations:
- `listWindows()` → list tmux windows in current session, returning names and activity status
- `findWindow(name: string)` → check if a window with the given name exists, return window target identifier
- `createWindow(name: string, cwd: string, command: string)` → `tmux new-window -n <name> -c <cwd> <command>`
- `selectWindow(target: string)` → `tmux select-window -t <target>`
- `killWindow(target: string)` → `tmux kill-window -t <target>`
- `isWindowAlive(target: string)` → check if a tmux window still exists and has running processes

All operations use `pi.exec("tmux", [...])` for consistency with the existing exec pattern and testability via the mock exec infrastructure.

### 3. Workspace Lifecycle Manager (slash commands)

**Responsibility:** Implement `/ws-create`, `/ws-switch`, `/ws-list`, `/ws-finish`.

Delegates to jj CLI for workspace operations and to Tmux Window Manager for window operations. Contains no tool overrides, no prompt rewriting, no session state persistence.

### 4. jj Workspace Operations (internal helpers)

**Responsibility:** Wrap jj CLI calls for workspace management. Carried over largely unchanged from current implementation.

- `runJj(args, options)` — execute jj with `--color=never`
- `listWorkspaceHeads()` — parse templated `jj workspace list` output
- `resolveWorkspacePath(name)` — `jj workspace root --name <name>`
- `getUniqueWorkspaceChanges(name)` — query mutable commits unique to workspace
- `getPreMergeOpId()` — capture operation ID for rollback
- `safeDeleteWorkspaceDir(wsPath, repoRoot)` — guarded directory deletion

### 5. Merge Engine (within `/ws-finish`)

**Responsibility:** Deterministic merge with conflict rollback. Preserved from current implementation with one addition: tmux window cleanup before directory deletion.

## Interfaces / APIs

### Command Interface

| Command | Arguments | Preconditions | Behavior |
|---------|-----------|---------------|----------|
| `/ws-create <name>` | workspace name | In tmux, in jj repo, in default workspace CWD | Creates jj workspace, spawns tmux window `ws:<name>` with `pi` running at workspace CWD |
| `/ws-switch <name>` | workspace name | In tmux, workspace exists in jj | Focuses existing `ws:<name>` tmux window, or creates new one with `pi --resume` if window is gone |
| `/ws-list` | none | In tmux, in jj repo | Shows all non-default workspaces with tmux window status indicators |
| `/ws-finish <name>` | workspace name (required) | In tmux, in jj repo, CWD is default workspace root | Confirms, kills live tmux window, merges, forgets workspace, deletes directory |

### Tmux Window Manager Interface

```typescript
interface TmuxWindowInfo {
  name: string;
  id: string;        // tmux window target (e.g., "@1")
  active: boolean;   // whether window is currently selected
}

interface TmuxWindowManager {
  listWindows(): Promise<TmuxWindowInfo[]>;
  findWindow(name: string): Promise<TmuxWindowInfo | null>;
  createWindow(name: string, cwd: string, command: string): Promise<boolean>;
  selectWindow(target: string): Promise<boolean>;
  killWindow(target: string): Promise<boolean>;
}
```

### jj Operations Interface (unchanged from current)

```typescript
interface JjResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

interface WorkspaceHead {
  name: string;
  changeId: string;
}

interface WorkspaceChange {
  changeId: string;
  description: string;
  empty: boolean;
  conflict: boolean;
}
```

## Data Flow

### `/ws-create <name>`

```
User ─── /ws-create auth ───▶ Extension
  │
  ├─ validate name (regex, length)
  ├─ jj root → repo root path
  ├─ compute wsPath = <repo-root>/../<repo-name>-ws-auth
  ├─ check !existsSync(wsPath)
  ├─ jj workspace add --name auth <wsPath>
  ├─ tmux new-window -n "ws:auth" -c <wsPath> "pi"
  └─ notify success
```

### `/ws-switch <name>`

```
User ─── /ws-switch auth ───▶ Extension
  │
  ├─ jj workspace list → verify workspace exists
  ├─ tmux list-windows → find "ws:auth"
  │
  ├─ [window exists]
  │   └─ tmux select-window -t <target>
  │
  └─ [window gone]
      ├─ jj workspace root --name auth → wsPath
      ├─ verify existsSync(wsPath)
      └─ tmux new-window -n "ws:auth" -c <wsPath> "pi --resume"
```

### `/ws-list`

```
User ─── /ws-list ───▶ Extension
  │
  ├─ jj workspace list → all workspaces with heads
  ├─ tmux list-windows → all windows in session
  ├─ for each non-default workspace:
  │   ├─ resolve path via jj workspace root
  │   ├─ match against tmux windows named "ws:<name>"
  │   └─ mark as [tmux: active] or [tmux: —]
  └─ render table/list to notification
```

### `/ws-finish <name>`

```
User ─── /ws-finish auth ───▶ Extension
  │
  ├─ validate: not "default"
  ├─ validate: CWD == default workspace root (not inside a workspace)
  ├─ jj workspace list → verify workspace exists
  ├─ jj workspace root --name auth → wsPath
  │
  ├─ tmux list-windows → check for "ws:auth" window
  │   └─ [window exists]
  │       ├─ warn: "Workspace 'auth' has a live tmux window. Kill it?"
  │       ├─ confirm Y/n
  │       │   ├─ [Y] tmux kill-window -t <target>
  │       │   └─ [n] abort finish
  │
  ├─ confirm: "Finish workspace 'auth'? This will merge and delete <wsPath>"
  ├─ query unique workspace changes
  ├─ preflight: reject if conflicted commits exist
  ├─ preflight: reject if default@ has uncommitted changes
  ├─ abandon all-empty commits if applicable
  │
  ├─ [has commits to merge]
  │   ├─ capture pre-merge op ID
  │   ├─ jj new default@ <heads...> -m "finish workspace auth"
  │   ├─ check conflict on @
  │   │   ├─ [conflict] → jj op restore <opId>, notify error, STOP
  │   │   └─ [clean] → continue
  │
  ├─ jj workspace forget auth
  ├─ safeDeleteWorkspaceDir(wsPath, repoRoot)
  └─ notify summary with recent history
```

## Feature Set

1. **Workspace creation with tmux window** — `/ws-create <name>` creates a jj workspace and spawns a new tmux window named `ws:<name>` with a fresh pi session whose CWD is the workspace directory.

2. **Workspace switching via tmux** — `/ws-switch <name>` focuses the existing `ws:<name>` tmux window. If the window was closed (pi exited or user killed it), creates a new tmux window with `pi --resume` to reconnect to any existing session state.

3. **Workspace listing with tmux status** — `/ws-list` shows all non-default jj workspaces with their change IDs, paths, and whether a corresponding tmux window is currently active.

4. **Workspace finishing with tmux cleanup** — `/ws-finish <name>` detects live tmux windows, warns, confirms, kills them, then performs the existing deterministic merge with conflict rollback, workspace forget, and directory deletion.

5. **Deterministic merge with conflict rollback** — carried over unchanged from the current implementation. Creates an explicit merge commit via `jj new default@ <heads...>`, detects conflicts, and rolls back via `jj op restore` if needed.

6. **Command completions** — `/ws-switch` and `/ws-finish` provide tab completions from the cached workspace list.

## Operational Considerations

### Tmux Detection

The extension must detect whether it's running inside tmux before registering any commands. Reuse the pattern from `tmux-titles.ts`:

```typescript
function inTmux(): boolean {
  const term = process.env.TERM ?? "";
  return !!(
    process.env.TMUX ||
    process.env.TERM_PROGRAM === "tmux" ||
    term.startsWith("tmux") ||
    term === "screen"
  );
}
```

If not in tmux, the extension should either skip registration entirely or register commands that emit a helpful error ("workspace commands require tmux").

### Window Naming Convention

Tmux windows are named `ws:<name>` (e.g., `ws:auth`, `ws:ui-refactor`). The `ws:` prefix:
- Avoids collision with user-created tmux windows
- Makes workspace windows visually identifiable in the tmux status bar
- Enables reliable pattern matching for `listWindows` filtering

### `pi --resume` Semantics

When `/ws-switch` re-creates a tmux window for a workspace whose window was closed, it launches `pi --resume` rather than a bare `pi`. This allows the user to reconnect to their previous session in that workspace. If no previous session exists, `pi --resume` presents the session browser (which is acceptable).

**Open question:** should this use `pi -c` (auto-continue last session) instead of `pi --resume` (interactive session picker)? `pi -c` is more seamless if there's exactly one session, but `pi --resume` is safer if there are multiple.

### `/ws-finish` Must Run From Default Session

The `/ws-finish` command must verify that it's running from the default workspace CWD, not from within a workspace session. This is enforced by comparing `process.cwd()` against the jj repo root (`jj root`). If CWD is a workspace directory, the command refuses to run with a clear error message.

This constraint exists because:
- The merge creates a commit in the default workspace's commit graph
- Deleting the workspace directory from within a session running in that directory would fail
- The orchestrator mental model (default session manages lifecycle) is preserved

### Orphaned Tmux Windows

When pi exits inside a workspace tmux window (the user quits, or pi crashes), the tmux window remains. This is **by design**: tmux windows dropping the user to a shell prompt is standard tmux behavior. The user can:
- Close the tmux window manually (`Ctrl-B &` or `exit`)
- Re-enter with `/ws-switch <name>` (which detects the existing window)
- Let `/ws-finish` kill it during cleanup

### Interaction with `tmux-titles` Extension

The `tmux-titles` extension (`pi/tmux-titles/extensions/tmux-titles.ts`) modifies tmux window names by appending/prepending status icons. The workspace window naming `ws:<name>` must coexist with this:
- `tmux-titles` uses `rename-window` to append icons like `✻` to the current window name
- Workspace windows may appear as `ws:auth ✻` in the status bar
- `findWindow` must match on the `ws:<name>` prefix, not exact name, to tolerate icon suffixes
- Alternatively, `tmux-titles` position can be set to `prefix`, or window lookup can use `#{window_name}` template filtering

**Recommendation:** Use `tmux list-windows -F '#{window_id} #{window_name}'` and match window names starting with `ws:<name>` to tolerate any suffix added by `tmux-titles`.

## Risks and Trade-Offs

### Risk: Tmux Dependency Excludes Non-Tmux Users

**Severity:** Medium  
**Mitigation:** The extension cleanly no-ops outside tmux. A future alternative backend (e.g., terminal tabs, kitty windows) could be added behind the same command interface.  
**Trade-off accepted:** Cleaner isolation for tmux users outweighs reduced reach.

### Risk: Cross-Session Coordination Complexity

**Severity:** Low  
The default session must reason about workspace sessions it doesn't own. However, the coordination surface is minimal:
- `/ws-finish` only needs to check if a tmux window exists and kill it — no IPC required
- `/ws-list` only needs to check window existence — read-only tmux query
- No message passing between pi sessions is needed

### Risk: Killing Tmux Windows Loses Unsaved Work

**Severity:** Medium  
**Mitigation:** `/ws-finish` warns explicitly that a live workspace session exists and requires Y/n confirmation before killing. The warning message should name the window and indicate it has a running process.  
**Trade-off accepted:** User must explicitly confirm destruction.

### Risk: `pi --resume` Session Matching

**Severity:** Low  
If the user has multiple pi sessions from the same workspace directory, `pi --resume` presents a picker rather than auto-connecting. This is acceptable behavior — it's the user's expected pi workflow.  
**Mitigation:** Consider using `pi -c` (continue most recent) as the default, with documentation noting that `/ws-switch` resumes the most recent session.

### Risk: Race Between `/ws-finish` Window Kill and Process Cleanup

**Severity:** Low  
`tmux kill-window` sends SIGHUP to processes in the window. The pi process in the workspace window will be killed. If pi is mid-write, the filesystem may have partial changes.  
**Mitigation:** The jj workspace content is captured in jj's commit graph before the merge. The workspace directory is about to be deleted anyway. Partial filesystem state doesn't affect the merge outcome because the merge operates on committed jj state.

### Trade-Off: No Context Inheritance

Workspace sessions start fresh — they don't inherit the parent session's conversation, tools, or system prompt context. This means the user must re-explain context when switching to a workspace.  
**Why acceptable:** Context inheritance would require serializing and deserializing session state across process boundaries, which is complex and fragile. The `pi --resume` model (reconnect to a workspace's own session history) is simpler and more predictable.

### Trade-Off: Simpler Extension at Cost of External Dependency

The new design trades internal complexity (tool overrides, prompt rewriting) for external dependency (tmux). The extension code becomes dramatically simpler, but users must have tmux.

## Alternatives Considered

### Alternative 1: Keep Virtual CWD Approach, Fix `@` Picker

Add an extension API to override the `@` file picker's root directory.

**Rejected because:**
- Only fixes one symptom. Other extensions still need CWD hardening.
- Requires pi core changes (new API surface) for a single use case.
- Does not reduce the inherent cognitive complexity of virtual CWD.

### Alternative 2: `cd` to Workspace in Same Process

Actually change `process.chdir()` to the workspace directory within the same pi session.

**Rejected because:**
- `process.chdir()` is global and affects all code in the process, including pi internals.
- Cannot maintain multiple "current directories" — there's only one `process.cwd()`.
- Returning to default requires another `chdir`, which could race with in-flight operations.
- Pi's file watcher, session storage, and other internals assume stable CWD.

### Alternative 3: Tmux Panes Instead of Windows

Use tmux panes (splits) instead of windows, so all workspaces are visible simultaneously.

**Rejected because:**
- Pane layout management is complex (resizing, swapping).
- Users can convert windows to panes manually via `Ctrl-B !` / `join-pane`.
- Windows are simpler to create, switch, and kill programmatically.
- Keeps the extension simple; layout is the user's domain.

### Alternative 4: Child Process Without Tmux

Spawn `pi` as a direct child process and pipe stdio.

**Rejected because:**
- TUI applications (pi uses a TUI) cannot be meaningfully piped — they need a real terminal.
- No way for the user to interact with the child session.
- Would require a pseudo-terminal allocation layer, effectively reimplementing tmux.

### Alternative 5: Detached Terminal Emulator Windows

Spawn new terminal emulator windows (e.g., via `xterm`, `$TERMINAL`).

**Rejected because:**
- Not portable across terminal emulators.
- No standardized API for window management (switching, killing, listing).
- tmux is already in the critical path for the target users.

## Open Questions

1. **`pi --resume` vs `pi -c` for `/ws-switch` re-creation** — Should `/ws-switch` use `pi --resume` (interactive session picker) or `pi -c` (auto-continue most recent)? `pi -c` is more seamless when there's exactly one session in the workspace; `pi --resume` is safer when there are multiple.

2. **Should workspace sessions register any commands?** — Currently proposed as "no" — workspace sessions are plain pi sessions. But should they at least have a `/ws-info` that shows which workspace they're in? This is low-priority since the tmux window name already indicates it.

3. **How does `tmux-titles` icon handling interact with window name matching?** — The `tmux-titles` extension appends status icons to window names. Window lookup by name must be robust to these suffixes. Should we use window ID (`#{window_id}`) tracking instead of name matching? Or should workspace windows set a tmux window option to mark them?

4. **Should `/ws-create` accept additional arguments?** — e.g., an initial commit description, or a branch to base the workspace on? This could be deferred to a follow-up.

5. **What happens if the user manually renames the tmux window?** — If the user renames `ws:auth` to something else, `/ws-switch` won't find it. Should we track window IDs internally (reintroducing some state), or accept this as user error?

6. **Should `/ws-finish` name argument be optional?** — In the current implementation, `/ws-finish` can infer the target from the active workspace. In the tmux model, `/ws-finish` always runs from the default session, so the name argument should be required. This is reflected in the command surface table but is a behavioral change from the current UX.

7. **What shell command should tmux run in workspace windows?** — Simply `pi`, or `cd <wsPath> && pi`? Since `tmux new-window -c <dir>` sets CWD, a bare `pi` should suffice. But if the user's shell profile changes CWD on startup, this could be disrupted. Should we use `tmux new-window -c <dir> 'cd <dir> && pi'` defensively?
