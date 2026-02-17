# bromanko-for-claude

A collection of Claude Code plugins for enhanced productivity and workflow automation.

## Adding this marketplace

Add this marketplace to your Claude Code installation:

### Using GitHub (recommended)
```shell
/plugin marketplace add bromanko/claude
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
/plugin install jj@bromanko-for-claude
```

---

### word-explorer
Comprehensive word exploration with dictionary definitions, etymology, and literary examples.

**Skills:**
- `word-explorer` - Provides word profiles combining Webster's 1913 definitions, literary quotations, and usage guidance

**Installation:**
```shell
/plugin install word-explorer@bromanko-for-claude
```

---

### fp-ts
Master typed functional programming in TypeScript with fp-ts library guidance.

**Skills:**
- `fp-ts` - Expert guidance for Option, Either, Task, TaskEither, and functional composition patterns

**Installation:**
```shell
/plugin install fp-ts@bromanko-for-claude
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
/plugin install gleam-review@bromanko-for-claude
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
/plugin install fsharp-review@bromanko-for-claude
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
/plugin install elm-review@bromanko-for-claude
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
   /plugin install plugin-name@bromanko-for-claude
   ```

### Validation

Validate the marketplace configuration:
```bash
claude plugin validate .
```

## License

MIT
