---
name: elm-review
description: This skill should be used when the user asks to "review Elm", "full Elm review", "review all Elm", "comprehensive Elm review", or wants a complete review covering code quality, security, performance, and testing for Elm code.
---

# Elm Full Review

**Action required:** Run the `/review elm` command. Do not perform the review manually.

The `/review` command provides an interactive TUI that:
- Runs code, security, performance, and test review skills
- Presents findings one at a time
- Lets the user choose to fix, skip, or stop for each finding

If the user wants only specific review types, run `/review elm <types>` where types can be: `code`, `security`, `performance`, `test`

Examples:
- Full review: `/review elm`
- Code and security only: `/review elm code security`
- Tests only: `/review elm test`
