---
name: chrome-devtools-mcp
description: >
  Use when the user wants to inspect, verify, or debug a live web page in
  Chrome using chrome-devtools-mcp: reproduce browser bugs, connect to a
  running Chrome instance, launch a fresh isolated browser, inspect
  DOM/layout/console/network state, take snapshots or screenshots, automate
  forms and clicks, or record performance traces. Only use when
  `chrome-devtools-mcp` is installed and executable in PATH.
compatibility: Requires `chrome-devtools-mcp` in PATH and a local Chrome installation.
---

# Chrome DevTools MCP

## Availability gate

Before using this skill, verify that the executable is available:

    command -v chrome-devtools-mcp >/dev/null 2>&1

If the command is not available, stop and tell the user that `chrome-devtools-mcp` is not installed or not in `PATH`. Do not invent browser observations.

## When to use this skill

Use this skill when the user asks you to verify frontend behavior in a real browser, inspect live DOM or layout state, debug console or network failures, reproduce bugs by clicking through a flow, take browser snapshots or screenshots, investigate performance issues, or connect to an already-running Chrome instead of launching a fresh one.

## Choose the right browser session

Prefer the smallest, safest mode that fits the task.

### 1) Connect to a running Chrome 144+ instance

Use this when the user wants to share their current session, cookies, or manually opened tabs and remote debugging has already been enabled in Chrome at `chrome://inspect/#remote-debugging`.

Launch the server with:

    chrome-devtools-mcp --auto-connect

You can combine it with a channel if needed:

    chrome-devtools-mcp --auto-connect --channel=canary

Choose this when the reproduction depends on an existing signed-in session or user state.

### 2) Connect to a running Chrome on a debugging port

Use this when Chrome is already running with `--remote-debugging-port`, or when the agent must connect to a browser outside its own sandbox.

Launch the server with:

    chrome-devtools-mcp --browser-url=http://127.0.0.1:9222

If the user provides a WebSocket debugger URL, use:

    chrome-devtools-mcp --ws-endpoint=ws://127.0.0.1:9222/devtools/browser/<id>

Choose this when a specific browser instance must be reused.

### 3) Launch a fresh browser

Use this when the task does not require existing cookies or manual user state.

For an ordinary visible session:

    chrome-devtools-mcp

For a clean temporary profile:

    chrome-devtools-mcp --isolated

For non-interactive or CI-like work:

    chrome-devtools-mcp --headless --isolated

Use `--isolated` by default when safety matters more than state reuse.

## Important CLI caveats

There are two related executables:

- `chrome-devtools-mcp` is the MCP server and supports the full server flag set, including `--auto-connect`.
- `chrome-devtools` is a convenience CLI wrapper around that server.

In version `0.20.0`, the `chrome-devtools` wrapper intentionally does not expose `--auto-connect`, even though `chrome-devtools-mcp` does. If the task requires attaching to a user's already-running Chrome via the newer `chrome://inspect/#remote-debugging` flow, prefer the raw `chrome-devtools-mcp` server path over the wrapper CLI.

Also note that `--browser-url=http://127.0.0.1:9222` expects the classic DevTools HTTP JSON endpoints such as `/json/version`. A Chrome instance that says a remote debugging server is running may still return `404` on those paths when it is using the newer remote-debugging flow. In that case, `--browser-url` is the wrong attachment mode; use `--auto-connect` instead.

Empirical behavior worth remembering:

- Launching a fresh isolated browser works reliably and `list_pages` returns normally.
- Auto-connect may succeed at the browser-attachment step but still hang or time out on later tool calls such as `list_pages` on some setups.
- If attached-browser tooling hangs, fall back to a fresh isolated browser unless the existing session is essential to the task.

## How to decide

- Need existing login, current tabs, or manually reproduced state: connect to a running Chrome.
- Need a clean reproduction without browser history, extensions, or cookies: launch with `--isolated`.
- Need visible interaction for debugging layout or interaction problems: prefer headed mode.
- Need repeatable automation, screenshots, or performance traces without UI: prefer `--headless --isolated`.
- Need a specific installed Chrome build: add `--channel=stable|beta|dev|canary` or `--executablePath=...`.

## Tool workflow

When browser tools are available, use them in this order unless the task clearly needs something else:

1. Establish page context with `list_pages`, `new_page`, `select_page`, or `navigate_page`.
2. Capture the current page structure with `take_snapshot`. Prefer snapshots over screenshots for navigation and element selection.
3. For functional bugs, inspect `list_console_messages`, `get_console_message`, `list_network_requests`, and `get_network_request`.
4. For interaction, use `click`, `hover`, `fill`, `fill_form`, `press_key`, `type_text`, and `wait_for`.
5. For DOM or runtime checks, use `evaluate_script`.
6. For visual proof, use `take_screenshot`.
7. For performance, use `performance_start_trace`, `performance_stop_trace`, and `performance_analyze_insight`.

## Common task recipes

### Verify that a page or feature works

Open or select the right page. Take a snapshot. Perform the minimum user actions needed. Then confirm the result with a fresh snapshot, relevant console or network checks, and a screenshot only if visual proof matters.

### Investigate “the page looks wrong”

Take a snapshot first. Use `evaluate_script` to inspect layout-affecting state such as element sizes, classes, computed styles, viewport size, or feature flags. Take a screenshot if the issue is visual. If the page depends on API data, inspect network requests before assuming a CSS bug.

### Investigate “something failed”

Check console messages and network requests before clicking around more. Many browser failures are explained by JavaScript exceptions, blocked requests, failed CORS preflights, or 4xx/5xx responses. Use `get_console_message` and `get_network_request` to inspect the exact failure.

### Reproduce a user flow

Use `take_snapshot` to get the latest element uids, then interact with `click`, `fill`, `press_key`, and `wait_for`. Never reuse stale uids from an old snapshot after navigation or large DOM changes.

### Investigate performance

Navigate to the final URL before tracing. Use `performance_start_trace` and, if the task is page-load performance, record with reload enabled. After stopping the trace, summarize the highest-impact insights and only then suggest code changes.

## Operating rules

- Always verify the executable exists before relying on this skill.
- Prefer `take_snapshot` over `take_screenshot` unless the task is explicitly visual.
- Always refresh your snapshot after navigation or large DOM updates.
- On attached non-isolated browsers, avoid destructive actions unless the user clearly asked for them.
- Be explicit about which browser mode you chose and why.
- Prefer the raw `chrome-devtools-mcp` server when using `--auto-connect`; the `chrome-devtools` wrapper CLI in `0.20.0` does not expose that flag.
- If `--browser-url` attachment fails and the target returns `404` for `/json/version`, assume the browser is using the newer remote-debugging flow and retry with `--auto-connect` instead of treating the browser as unavailable.
- If connection to an existing browser fails, or connection succeeds but page-listing and other tools hang, fall back to launching a fresh isolated browser unless the task specifically requires the existing session.
- Never claim you observed browser behavior unless a browser tool actually provided the evidence.

## Safety notes

A connected browser may expose cookies, session state, page contents, and DevTools data. When attached to a user's running Chrome, treat the session as sensitive. Prefer `--isolated` for exploratory or destructive testing.
