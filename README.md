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

**Commands:**
- `/jj:commit` - Analyze jj status and create logical commits with descriptive messages
- `/jj:workspace-cleanup` - Clean up empty jujutsu workspaces

**Hooks:**
- Blocks mutating git commands in jujutsu repositories, guiding you to jj equivalents

**Installation:**
```shell
/plugin install jj@bromanko-llm-agents
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

**Exception: extension directories.** Never place test files or non-extension support modules inside directories registered as `pi.extensions` in `package.json` (e.g. `packages/jj/extensions/`, `shared/extensions/`). Pi auto-discovers every `*.ts` file in those directories and loads them as extensions — test files will execute their `test()` calls on import, and library modules without a default export will fail to load. Place extension tests in `test/extensions/` and shared library code in `shared/lib/` (or a `lib/` directory within the package).

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

## Pi fetch tool (MVP)

This repository now includes a first-party `fetch` extension at `shared/extensions/fetch.ts`.

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
pi --extension ./shared/extensions/fetch.ts
```

## Pi web_search tool (Brave-first v1)

This repository now includes a first-party `web_search` extension at `shared/extensions/web-search/index.ts`.

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
- **Optional enrichment:** when `enrich=true`, top results are fetched through the local fetch pipeline (`shared/lib/fetch-core.ts`) and appended as bounded excerpts.

Run pi with this extension directly:

```bash
pi --extension ./shared/extensions/web-search/index.ts
```

## License

MIT
