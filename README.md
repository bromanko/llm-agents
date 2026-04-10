# bromanko-llm-agents

A collection of Claude Code plugins for enhanced productivity and workflow automation.

## Adding this marketplace

Add this marketplace to your Claude Code installation:

### Using GitHub (recommended)
```shell
/plugin marketplace add bromanko/llm-agents
```

### Using local path (for development)
```shell
/plugin marketplace add /path/to/this/repo
```

## Available plugins

### jj
Tools and commands for working with Jujutsu (jj) version control.

> **Context tip:** Always use `--color=never` (or `--git` for diffs) when running jj commands via Bash. ANSI escape codes waste 2-3x the tokens.

**Commands:**
- `/jj:commit` - Analyze jj status and create logical commits with descriptive messages
- `/jj:workspace-cleanup` - Clean up empty jujutsu workspaces

**Configuration:**
- Global: `~/.pi/agent/jj-commit.json`
- Project: `.pi/jj-commit.json`
- Project config overrides global config

Example:
```json
{
  "model": "dbx-bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0"
}
```

The configured `provider/id` must match the exact model shown by pi's model selector.

**Hooks:**
- Blocks mutating git commands in jujutsu repositories, guiding you to jj equivalents

**Installation:**
```shell
/plugin install jj@bromanko-llm-agents
```

---

### git
AI-assisted Git commit workflow with optional hunk-level split commits.

**Commands:**
- `/git-commit` - Analyze Git changes, propose commit messages, and split mixed changes by file or hunk

**Configuration:**
- Global: `~/.pi/agent/git-commit.json`
- Project: `.pi/git-commit.json`
- Project config overrides global config

Example:
```json
{
  "model": "anthropic/claude-opus-4-1"
}
```

The configured `provider/id` must match the exact model shown by pi's model selector.

**Installation:**
```shell
/plugin install git@bromanko-llm-agents
```

---

### word-explorer
Comprehensive word exploration with dictionary definitions, etymology, and literary examples.

**Skills:**
- `word-explorer` - Provides word profiles combining Webster's 1913 definitions, literary quotations, and usage guidance

**Installation:**
```shell
/plugin install word-explorer@bromanko-llm-agents
```

---

### fp-ts
Master typed functional programming in TypeScript with fp-ts library guidance.

**Skills:**
- `fp-ts` - Expert guidance for Option, Either, Task, TaskEither, and functional composition patterns

**Installation:**
```shell
/plugin install fp-ts@bromanko-llm-agents
```

---

### gleam-review
Gleam-specific code review skills for quality, security, performance, and testing.

**Skills:**
- `code-review` - Quality and idiom analysis for Gleam code
- `security-review` - Security audit focusing on FFI safety, input validation, and dependencies
- `performance-review` - BEAM runtime optimization analysis
- `test-review` - Test coverage and quality assessment

**Installation:**
```shell
/plugin install gleam-review@bromanko-llm-agents
```

---

### fsharp-review
F#-specific code review skills for quality, security, performance, and testing.

**Skills:**
- `code-review` - Quality and idiom analysis for F# code
- `security-review` - Security audit focusing on .NET interop, serialization, input validation, and dependencies
- `performance-review` - .NET runtime optimization analysis (allocations, async, collections)
- `test-review` - Test coverage and quality assessment (Expecto, xUnit, FsCheck)

**Installation:**
```shell
/plugin install fsharp-review@bromanko-llm-agents
```

---

### elm-review
Elm-specific code review skills for quality, security, performance, and testing.

**Skills:**
- `code-review` - Quality and idiom analysis for Elm code (TEA, type design, decoders)
- `security-review` - Security audit focusing on port safety, JSON validation, and XSS prevention
- `performance-review` - Virtual DOM rendering and data structure optimization analysis
- `test-review` - Test coverage and quality assessment (elm-test, fuzz testing, Test.Html)

**Installation:**
```shell
/plugin install elm-review@bromanko-llm-agents
```

---

## Pi `/review` command

The repository includes an interactive code review command in `pi/code-review/extensions/index.ts`.

### Usage

```shell
/review <language> [types...] [-r|--revisions <range>] [--fix <high|medium|low|all>] [--report <high|medium|low|all>]
```

- `language` selects the review skill family (`gleam`, `fsharp`, `elm`, etc.).
- `types` optionally narrows to `code`, `security`, `performance`, and/or `test`.
- `-r/--revisions` selects what changes to review. Default is `@`.
- `--fix` auto-queues follow-up fix requests at or above the given severity threshold.
- `--report` renders a deterministic markdown report for findings at or above the given severity threshold. Use it with `pi -p`.

### Examples

```shell
/review gleam
/review gleam -r main..@
/review gleam code security -r abc123
/review gleam -r @ --fix high
/review fsharp test -r main..@ --fix medium
pi -p "/review gleam --report all"
pi -p "/review fsharp security --report medium"
```

### Range resolution

`/review` gathers code changes by trying:

1. `jj diff -r <range> --git`
2. `git` fallback (`git diff` for ranges, `git show --patch` for single revisions)

If both fail, the command reports a deterministic error including the range and failing commands.

## Using plugins

After installing a plugin:

1. **Browse commands:** Use `/` to see available commands
2. **Get help:** Most commands support `/command --help`
3. **Configure:** Check plugin documentation for configuration options

## Contributing

### Adding new plugins

1. Create a new directory under `plugins/`
2. Add a `plugin.json` manifest file
3. Add your plugin components (commands, agents, hooks, etc.)
4. Update `.claude-plugin/marketplace.json` to register the plugin
5. Submit a pull request

### Plugin structure

```
plugins/your-plugin/
├── plugin.json          # Plugin manifest
├── commands/            # Custom commands (optional)
├── agents/              # Custom agents (optional)
└── README.md           # Plugin documentation (optional)
```

## Development

### Testing locally

1. Clone this repository
2. Add the local marketplace:
   ```shell
   /plugin marketplace add ./path/to/clone
   ```
3. Install plugins for testing:
   ```shell
   /plugin install plugin-name@bromanko-llm-agents
   ```

### Validation

Validate the marketplace configuration:
```bash
claude plugin validate .
```

## Testing

Run the full test suite from the repository root:

```bash
npm test
```

Run a single test file:

```bash
node --experimental-strip-types --test path/to/file.test.ts
```

Test files are co-located with the module under test and named `<module>.test.ts` (or `.test.js` for existing JavaScript modules).

**Exception: extension directories.** Never place test files or non-extension support modules inside directories registered as `pi.extensions` in `package.json` (e.g. `pi/jj/extensions/`, `pi/web/extensions/`). Pi auto-discovers every `*.ts` file in those directories and loads them as extensions — test files will execute their `test()` calls on import, and library modules without a default export will fail to load. Place extension tests in `test/extensions/` and shared library code in a package-local `lib/` directory (for example `pi/web/lib/`).

For extension tests, use the shared mock helper in `test/helpers.ts`:

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { createMockExtensionAPI } from "../../test/helpers.ts";
import extension from "./my-extension.ts";

test("registers and handles tool_call", async () => {
  const pi = createMockExtensionAPI();
  extension(pi as any);

  const [handler] = pi.getHandlers("tool_call");
  const result = await handler(
    { toolName: "bash", input: { command: "git push" } },
    { cwd: process.cwd(), sessionManager: { getBranch: () => [] } },
  );

  assert.equal(result?.block, true);
});
```

No external testing dependencies are required. Tests use Node.js built-ins (`node:test`, `node:assert/strict`) and TypeScript support from `--experimental-strip-types`.

## Pi enhanced read tool

This repository now includes a first-party `read` override at `pi/files/extensions/read.ts`.

- **Purpose:** keep the familiar `read` tool while adding direct line targeting for common paging workflows.
- **Supported parameters:** `path`, `offset`, `limit`, `endLine`, `tail`, `aroundLine`, and `context`.
- **Examples:**
  - `read package.json endLine=5`
  - `read package.json tail=5`
  - `read README.md aroundLine=280 context=2`
- **Image behavior:** known image extensions (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`) still delegate to pi's built-in image read pipeline.
- **Prompt guidance:** prefer `endLine`, `tail`, and `aroundLine` over `head`, `tail`, or `sed` when you need a targeted read.

Run pi with this extension directly:

```bash
pi -e ./pi/files/extensions/read.ts
```

## Pi fetch tool (MVP)

This repository now includes a first-party `fetch` extension at `pi/web/extensions/fetch.ts`.

- **Purpose:** fetch HTTP(S) URLs and return model-readable output with metadata (`URL`, optional `Final URL`, `Status`, `Content-Type`, `Method`) plus a readable body.
- **MVP content handling:**
  - `application/json` → pretty-printed JSON
  - `text/html` → conservative HTML-to-text conversion
  - `text/*` and markdown-like text → passthrough text
  - other content types → best-effort text fallback
- **Truncation behavior:** output is bounded by line/byte limits (defaults: 2000 lines, 50KB). When truncated, full output is saved to a temp file and the response includes a truncation notice with the saved path.
- **Safety:** non-HTTP(S) schemes are rejected (for example `file://`).
- **Known non-goals (deferred):** binary/PDF conversion and site-specific advanced scraping pipelines.

Run pi with this extension directly:

```bash
pi -e ./pi/web/extensions/fetch.ts
```

## Pi web_search tool (Brave-first v1)

This repository now includes a first-party `web_search` extension at `pi/web/extensions/web-search/index.ts`.

- **Purpose:** discover current web sources via Brave Search and return bounded, citation-friendly output.
- **Provider scope (v1):** `brave` only.
  - `provider: "auto"` resolves to Brave when `BRAVE_API_KEY` is set.
  - Anthropic/Codex provider-native adapters are intentionally deferred to v2.
- **Required env var:** `BRAVE_API_KEY`
- **Parameters:**
  - `query` (required)
  - `provider` (`auto | brave`)
  - `recency` (`day | week | month | year`)
  - `limit` (clamped to `1..10`, default `5`)
  - `enrich` (`boolean`, default `false`)
  - `fetchTop` (clamped to `0..5`, default `0`)
- **Optional enrichment:** when `enrich=true`, top results are fetched through the local fetch pipeline (`pi/web/lib/fetch-core.ts`) and appended as bounded excerpts.

Run pi with this extension directly:

```bash
pi -e ./pi/web/extensions/web-search/index.ts
```

## Pi lsp tool

This repository includes a universal LSP extension at `pi/lsp/extensions/lsp.ts` that provides automatic diagnostics and code intelligence for any language with a configured LSP server.

### What it does

- **Auto diagnostics on write/edit:** after every `write` or `edit` tool call, the extension sends the file to the appropriate LSP server and appends any diagnostics directly to the tool result. No explicit tool call needed.
- **Format on write:** optionally reformats the file after write/edit using the LSP server's formatting capability. Enabled by default.
- **`lsp` tool for code intelligence:** a single tool with an `action` parameter for on-demand queries:
  - `languages` — list detected servers and their status
  - `diagnostics` — get current diagnostics for a file
  - `definition` — go to definition
  - `references` — find all references
  - `hover` — get hover/type information
  - `symbols` — document or workspace symbols (pass `query` for workspace)
  - `rename` — rename a symbol
  - `code_actions` — list available code actions
  - `incoming_calls` / `outgoing_calls` — call hierarchy

### Configuration

The extension merges configuration from three layers (lowest to highest precedence):

1. Built-in defaults (`pi/lsp/lib/defaults.json`)
2. User config (`~/.pi/agent/lsp.json`)
3. Project config (`.pi/lsp.json`)

Example `.pi/lsp.json`:

```json
{
  "formatOnWrite": true,
  "diagnosticsOnWrite": true,
  "autoCodeActions": false,
  "idleTimeoutMinutes": 10,
  "servers": {
    "typescript-language-server": {
      "args": ["--stdio", "--log-level=1"]
    },
    "custom-server": {
      "command": "my-lsp",
      "args": ["--stdio"],
      "fileTypes": [".custom"],
      "rootMarkers": ["custom.config"]
    }
  }
}
```

### Supported languages (v1)

- **TypeScript/JavaScript** via `typescript-language-server` (`.ts`, `.tsx`, `.js`, `.jsx`)

Additional servers can be added via config files.

### Running

The extension is auto-loaded when using this repository as a pi package. To run directly:

```bash
pi -e ./pi/lsp/extensions/lsp.ts
```

### Integration tests

Integration tests require `typescript-language-server` and `typescript` in PATH:

```bash
nix develop .#lsp-test -c node --experimental-strip-types --test pi/lsp/test/integration/typescript.e2e.test.ts
```

## Pi `/session-stats` command

Cross-session token usage and cost reporting.

### Usage

```
/session-stats [range] [by day|project|model]
```

### Examples

```
/session-stats
/session-stats today
/session-stats last 7 days
/session-stats this month by project
/session-stats 2026-04-01..2026-04-06 by day
/session-stats all time by model
```

### Notes

- Scans all saved sessions across all projects on this machine.
- Only saved sessions are counted. Ephemeral `--no-session` runs are invisible.
- Ranges are interpreted in local time.
- Does not invoke a model. Deterministic and read-only.

## License

MIT
