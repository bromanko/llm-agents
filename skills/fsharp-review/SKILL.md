---
name: fsharp-review
description: This skill should be used when the user asks to "review F#", "full F# review", "review all F#", "comprehensive F# review", "review fsharp", or wants a complete review covering code quality, security, performance, and testing for F# code.
---

# F# Full Review

**Action required:** Run the `/review fsharp` command. Do not perform the review manually.

The `/review` command provides an interactive TUI that:
- Runs code, security, performance, and test review skills
- Presents findings one at a time
- Lets the user choose to fix, skip, or stop for each finding

If the user wants only specific review types, run `/review fsharp <types>` where types can be: `code`, `security`, `performance`, `test`

Examples:
- Full review: `/review fsharp`
- Code and security only: `/review fsharp code security`
- Tests only: `/review fsharp test`
