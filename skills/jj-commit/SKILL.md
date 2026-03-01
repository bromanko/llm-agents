---
name: jj-commit
description: >
  Analyze jj status and create well-structured, logical commits with
  descriptive messages. Use when the user wants to commit changes in a
  jujutsu repository, create atomic commits, or organize working copy
  changes into meaningful commit groups.
---

# jj commit

Analyze jj status and create logical commits with good messages.

## Preferred: `/jj-commit` command

When available, prefer the `/jj-commit` extension command which provides:
- AI-powered commit message generation with model fallback
- Automatic split commit detection for unrelated changes
- Optional `jj absorb` pre-pass
- Changelog detection and updates (existing files only)
- Push workflow with bookmark management

Usage:
- `/jj-commit` — analyze and commit
- `/jj-commit --dry-run` — preview without committing
- `/jj-commit --push --bookmark main` — commit and push
- `/jj-commit --no-changelog` — skip changelog updates
- `/jj-commit --no-absorb` — skip absorb pre-pass
- `/jj-commit --context "fixing auth bug"` — provide context

If `/jj-commit` is not available, fall back to the manual workflow below.

## Description

This skill helps create well-structured commits in a jujutsu repository by:

1. Analyzing the current `jj status` and changes
2. Examining diffs to understand modifications
3. Intelligently absorbing changes into existing mutable commits when appropriate
4. Grouping remaining changes into logical commits
5. Creating commits with descriptive messages following conventional commit format
6. Using a linear commit workflow with `jj commit -m "message"`

## Important: avoid ANSI color output

Always pass `--color=never` when running jj commands via Bash.
Without it, jj may emit ANSI escape codes that waste 2-3x the tokens.

- `jj diff --color=never` or `jj diff --git` (plain text format)
- `jj log --color=never ...`
- `jj show --color=never ...`

## Implementation

When invoked:

1. Run `jj status` to see all changes
2. Run `jj diff --git` to understand the nature of modifications (plain diff, no color)
3. Check `jj log --color=never -r 'mutable() & ancestors(@) & ~@'` to see if there are mutable commits in the stack
4. If mutable commits exist in the stack:
   - Analyze whether changes look like fixes/updates to existing commits (typos, refinements, addressing feedback)
   - If appropriate, run `jj absorb` to automatically move changes into ancestor commits
   - Run `jj op show -p` to show what was absorbed
   - Check `jj status` again to see if any changes remain
5. For any remaining changes (or all changes if absorb wasn't used):
   - Analyze changes and group by:
     - File types and purposes (config, modules, docs, etc.)
     - Functional relationships
     - Scope (single feature, bug fix, refactoring, etc.)
   - Create commits using non-interactive commands:
     - **CRITICAL**: When creating multiple commits from a working copy, you MUST specify files explicitly
     - Use `jj commit -m "message" path/to/file1 path/to/file2` for each logical group
     - **NEVER** run `jj commit -m "message"` without file paths when you intend to create multiple commits
     - Running `jj commit` without file arguments commits ALL working copy changes, leaving nothing for subsequent commits
     - Follow conventional commit format
     - Use imperative mood in messages
     - Create commits linearly, one after another
6. Never use interactive commands (`jj commit` without `-m`, `jj split` without paths)
7. **Do NOT merge unrelated branches or workspaces.** This skill only commits working copy changes. Ignore other heads, bookmarks, or workspaces—they are intentionally separate.
8. After creating commits, show the result using:
   ```
   jj log --color=never -r 'ancestors(@, 5)' -T 'concat(change_id.short(), ": ", description)'
   ```

## Notes

- Requires a jujutsu repository (`.jj` directory present)
- Uses non-interactive workflow only
- Creates descriptive, atomic commits
- Follows the user's commit style preferences
- **Important jujutsu behavior**: `jj commit -m "message"` without file arguments commits ALL working copy changes at once. This is fundamentally different from git's incremental staging model. To create multiple commits from a single working copy, always specify file paths: `jj commit -m "message" file1 file2`
