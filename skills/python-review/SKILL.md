---
name: python-review
description: This skill should be used when the user asks to "review Python", "full Python review", "review all Python", "comprehensive Python review", or wants a complete review covering code quality, security, performance, and testing for Python code.
---

# Python Full Review

**Action required:** Run the `/review python` command. Do not perform the review manually.

The `/review` command provides an interactive TUI that:
- Runs code, security, performance, and test review skills
- Presents findings one at a time
- Lets the user choose to fix, skip, or stop for each finding

If the user wants only specific review types, run `/review python <types>` where types can be: `code`, `security`, `performance`, `test`

Examples:
- Full review: `/review python`
- Code and security only: `/review python code security`
- Tests only: `/review python test`
