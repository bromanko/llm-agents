---
name: typescript-review
description: This skill should be used when the user asks to "review TypeScript", "full TypeScript review", "review all TypeScript", "comprehensive TypeScript review", or wants a complete review covering code quality, security, performance, and testing for TypeScript code.
---

# TypeScript Full Review

**Action required:** Run the `/review typescript` command. Do not perform the review manually.

The `/review` command provides an interactive TUI that:
- Runs code, security, performance, and test review skills
- Presents findings one at a time
- Lets the user choose to fix, skip, or stop for each finding

If the user wants only specific review types, run `/review typescript <types>` where types can be: `code`, `security`, `performance`, `test`

Examples:
- Full review: `/review typescript`
- Code and security only: `/review typescript code security`
- Tests only: `/review typescript test`
