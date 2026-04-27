---
name: gascity-workspaces
description: Use when working with Gas City workspace isolation, jj workspace-backed implementation slices, parallel implementation batches, /ws-create, /ws-list, /ws-switch, /ws-finish, or merge-back workflow in a consuming repository.
---

# Gas City workspace workflow

Use this skill for Gas City workstreams that need source-control isolation, jj workspace-backed implementation, parallel batches, or merge-back coordination.

Before changing workflow policy, read the consuming repository's local operating model and any task, bead, plan, or contribution notes that define authority for that repository. Shared guidance here is generic; local policy may add stricter gates, paths, or cleanup requirements.

## Modes

Inline/default workspace work uses the repository's default jj workspace. It is appropriate for read-only research, scoping and review with no edits, tiny reversible documentation edits, and final integration validation when the local policy allows it.

A workstream workspace is a separate jj workspace for one bounded implementation slice or spike. Use it for medium-risk work, generated files, dependency or configuration changes, likely file overlap, long-running work, or any slice assigned while other builders may be editing nearby areas.

A parallel batch is a lead-managed set of workstream workspaces. Each workstream has its own local implementation, verification, and review. Integrate workspaces back to default one at a time unless a human explicitly directs otherwise.

## Command boundary

The user's existing workspace extension owns low-level lifecycle commands:

- `/ws-create <name>`
- `/ws-list`
- `/ws-switch <name>`
- `/ws-finish <name>`

Gas City packs may describe when to use these commands, but they must not add duplicate `/ws-*` command implementations. If repository-specific automation is needed later, use a clearly namespaced command and write an accepted plan first.

If `/ws-list` is unavailable in a Pi session where workspace workflow is expected, stop and ask the human to load the workspace extension. Do not continue by adding a duplicate extension under the consuming repository.

## Workspace preflight

A workspace-assigned agent must prove its current workspace before editing. From the current directory, run:

    pwd
    jj root
    jj log -r @ --no-graph -T 'change_id'
    jj workspace list --color=never -T 'name ++ ":" ++ self.target().change_id() ++ "\n"'
    jj status --color=never

The current workspace is the row in `jj workspace list` whose change id matches the `jj log -r @` output. If that row is `default`, the agent is not in an isolated workstream workspace. If the current directory or workspace name is wrong, stop and report the mismatch instead of editing.

`jj status --color=never` must be recorded before implementation and before any integration request. Unexpected unsnapshotted changes, conflicts, untracked generated files, or edits outside the assigned target path should block handoff until resolved or explicitly accepted by a human.

## Gates and integration

Workspace-local completion is not integration completion. A workstream is only ready to integrate after implementation, workspace-local verification, and workspace-local review pass.

`/ws-finish`, merges, source-control commits, pushes, and equivalent merge-back operations are human-owned unless the source task or human explicitly delegates them. Before integration, summarize the workspace name, changed files, verification command and result, review result, and risks.

Before finishing a workspace, also check the default workspace if local policy delegates that step. If default has uncommitted working-copy changes or unresolved integration state, stop for the human-owned source-control step that records or advances that state before finishing another workspace. After integration, rerun the relevant validation from default and record cleanup status.

Builders should not edit the default workspace for a workspace-assigned task. Reviewers should state whether they are reviewing the workspace-local diff or the integrated default workspace. Leads should choose the isolation mode when routing work and should keep the default workspace clean for coordination and integration.
