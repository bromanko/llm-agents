---
name: rust-review
description: This skill should be used when the user asks to "review Rust", "full Rust review", "review all Rust", "comprehensive Rust review", "review rust code", or wants a complete review covering code quality, security, performance, and testing for Rust code.
---

# Rust Full Review

**Action required:** Run the `/review rust` command. Do not perform the review manually.

The `/review` command provides an interactive TUI that:
- Runs code, security, performance, and test review skills
- Presents findings one at a time
- Lets the user choose to fix, skip, or stop for each finding

If the user wants only specific review types, run `/review rust <types>` where types can be: `code`, `security`, `performance`, `test`

Examples:
- Full review: `/review rust`
- Code and security only: `/review rust code security`
- Tests only: `/review rust test`
