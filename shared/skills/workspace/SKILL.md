---
name: workspace
description: >
  Use this skill when the user wants to create, continue, finish, or list
  jj workspaces for agentic work. Triggers include phrases like: "create a
  workspace", "run X agent in a workspace", "spin up a workspace",
  "continue work in workspace Y", "finish workspace Y", "merge workspace Y",
  "close workspace Y", "what workspaces are open". This skill is about
  managing isolated jj working copies for subagents — it should NOT trigger
  for general branch management, bookmarks, or non-workspace jj operations.
---

# jj Workspace Orchestration

Manage isolated jj workspaces for agentic work. This skill handles the full lifecycle: create, continue, finish, and list workspaces. It composes with any agent — the skill sets up the workspace, then launches whatever agent the user requests inside it.

## Determine the Operation

Based on the user's request, perform one of the four operations below:

- **Create**: User wants a new workspace (possibly with an agent to work in it)
- **Continue**: User wants to resume or add work in an existing workspace
- **Finish**: User wants to merge a workspace's changes back and clean it up
- **List**: User wants to see what workspaces exist and their status

---

## Operation 1: Create Workspace

### Step 1: Determine workspace name

- If the user provided a name, use it
- Otherwise, auto-generate one: run `date +%s%N | shasum | head -c 8` and prefix with `agent-` (e.g., `agent-a3f1b2c0`)

### Step 2: Set up paths

```bash
REPO_ROOT=$(jj root)
REPO_NAME=$(basename "$REPO_ROOT")
WS_NAME="<chosen-name>"
WS_PATH="$REPO_ROOT/../${REPO_NAME}-ws-${WS_NAME}"
```

### Step 3: Check for collisions

- Run `jj workspace list` and verify the name is not already taken
- Check that the path does not already exist on disk
- If either collision exists, report to the user and stop

### Step 4: Create the workspace

```bash
jj workspace add --name "$WS_NAME" "$WS_PATH"
```

### Step 5: Update the registry

Read `<repo-root>/.jj/workspace-registry.json` (create it if it doesn't exist). Add the new workspace entry:

```json
{
  "workspaces": {
    "<name>": {
      "path": "<absolute-path>",
      "created": "<ISO-8601 timestamp>"
    }
  }
}
```

Write the updated JSON back to the file.

### Step 6: Report to user

Tell the user the workspace name and absolute path.

### Step 7: Launch agent (if requested)

If the user asked for an agent to work in the workspace, launch it via the Task tool. Inject the following context into the subagent's prompt:

```
You are working in an isolated jj workspace.

WORKSPACE RULES:
- Your working directory is: <absolute-workspace-path>
- ALWAYS cd to your working directory before doing any work
- Use `jj` for all version control. NEVER use `git` commands.
- Commit incrementally as you work. Each logical unit of change (e.g., a
  single file refactored, a function added, a bug fixed) should be its own
  commit. Small, focused commits make rebases and conflict resolution easier.
  Use `jj commit -m "message"` with conventional commit format.
- Do not leave uncommitted changes when you are done.
- Do NOT run `jj workspace add`, `jj workspace forget`, or `rm -rf`.
  Workspace lifecycle is managed externally.
- The full repo history is available via `jj log`.

YOUR TASK:
<user's task description>
```

If the user specified a particular agent type (e.g., "the code review agent"), use the appropriate subagent_type in the Task tool call. Otherwise, use the `general-purpose` subagent type.

---

## Operation 2: Continue in Workspace

### Step 1: Verify workspace exists

- Run `jj workspace list` and confirm the named workspace appears
- Read the registry file at `<repo-root>/.jj/workspace-registry.json`
- Look up the workspace path from the registry
- If the workspace is in jj but not the registry, fall back to the naming convention: `<repo-root>/../<repo-name>-ws-<workspace-name>`
- Verify the directory exists on disk

### Step 2: Show current state

Run from the repo root:
```bash
jj log -r '<workspace-name>@'
```

Report what commits exist and whether there are uncommitted changes.

### Step 3: Launch agent (if requested)

Same as Create Step 7 — inject workspace context into the subagent prompt. Add this additional line to the context:

```
This is a CONTINUATION of work in an existing workspace. Review existing
changes with `jj log` and `jj diff` before starting new work.
```

---

## Operation 3: Finish Workspace

### Step 1: Verify workspace exists

- Run `jj workspace list` and confirm the workspace exists
- Read the registry file and look up the path
- If the workspace is not found in jj, report to the user and stop
- **NEVER proceed with finish if the workspace name is "default"**

### Step 2: Confirm with user

Before any destructive operations, tell the user:
- The workspace name
- The workspace path (from registry)
- What will happen: merge changes, forget workspace, delete directory

Ask for confirmation before proceeding.

### Step 3: Analyze commits

```bash
jj log -r 'ancestors(<name>@) & mutable() & ~ancestors(default@)' --no-graph
```

Count the workspace-specific commits.

### Step 3b: Commit any uncommitted workspace changes

Before merging, check whether the workspace working copy has uncommitted changes:

```bash
cd <workspace-path>
jj diff --stat
```

If there are uncommitted changes, commit them so nothing is lost:

```bash
jj commit -m "workspace <name>: uncommitted changes"
cd <repo-root>
```

Then re-run the Step 3 analysis to include the new commit in the count.

### Step 4: Merge strategy

- **No workspace-specific commits**: Nothing to merge. Proceed to cleanup.
- **Single commit**: Squash it, then abandon the emptied commit:
  ```bash
  jj squash -r <change-id>
  jj abandon <change-id>
  ```
- **Multiple commits**: Rebase them onto the default workspace's parent:
  ```bash
  jj rebase -s <earliest-change-id> -d <target>
  ```

### Step 5: Check for conflicts

After the merge operation, check for conflict markers in the output. jj will report conflicts if they occur.

**If conflicts exist:**
1. Report the conflicting files to the user
2. **Do NOT forget or delete the workspace** — preserve it
3. Suggest options:
   - Resolve conflicts manually in the workspace directory
   - Abandon the workspace changes: `jj abandon <change-ids>` then finish again
   - Run another agent in the workspace to attempt resolution
4. Stop here. The user decides what to do next.

**If no conflicts, continue to cleanup.**

### Step 6: Cleanup

```bash
jj workspace forget <name>
```

Then delete the workspace directory. **Follow ALL safety rules:**

1. The path MUST come from the registry file — never reconstruct for deletion
2. The directory name MUST contain `-ws-`
3. The path MUST NOT be an ancestor of the repo root
4. If any check fails, stop and ask the user

```bash
rm -rf <workspace-path>
```

Remove the workspace entry from the registry file and write it back.

### Step 7: Report results

```bash
jj log -r 'ancestors(@, 5)'
```

Show the user the merged result.

---

## Operation 4: List Workspaces

### Step 1: Gather data

- Run `jj workspace list` for jj-tracked workspaces and their current commits
- Read the registry file for managed workspace paths

### Step 2: Cross-reference

For each workspace in the registry:
- Check if it still appears in `jj workspace list`
- Flag any inconsistencies (registry entry without jj workspace, or jj workspace without registry entry)

### Step 3: Report

For each workspace, show:
- Name
- Path (from registry)
- Current change ID and description (from jj)
- Whether it has uncommitted changes

Format as a clean readable list. Exclude the "default" workspace from the managed workspace output (it's always there and not managed by this skill).

---

## Registry File Format

**Location**: `<repo-root>/.jj/workspace-registry.json`

```json
{
  "workspaces": {
    "my-feature": {
      "path": "/Users/me/code/project-ws-my-feature",
      "created": "2026-01-29T12:00:00Z"
    },
    "agent-a3f1b2c0": {
      "path": "/Users/me/code/project-ws-agent-a3f1b2c0",
      "created": "2026-01-29T14:30:00Z"
    }
  }
}
```

- Created automatically on first workspace creation
- Stored in `.jj/` so it is not tracked by the repository
- If the file is missing or corrupt, fall back to the naming convention (`<repo-root>/../<repo-name>-ws-<name>`) for reads, but NEVER for deletion
