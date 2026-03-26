---
name: go-review
description: This skill should be used when the user asks to "review Go", "full Go review", "review all Go", "comprehensive Go review", "review golang", or wants a complete review covering code quality, security, performance, and testing for Go code.
---

# Go Full Review

**Action required:** Run the `/review go` command. Do not perform the review manually.

The `/review` command provides an interactive TUI that:
- Runs code, security, performance, and test review skills
- Presents findings one at a time
- Lets the user choose to fix, skip, or stop for each finding

If the user wants only specific review types, run `/review go <types>` where types can be: `code`, `security`, `performance`, `test`

Examples:
- Full review: `/review go`
- Code and security only: `/review go code security`
- Tests only: `/review go test`
