# Design Studio

`/design <topic>` starts a structured design workflow inside pi.

## What it does

1. switches the session into design-facilitator mode
2. gathers a structured brief through normal chat
3. asks the user for approval when the brief is sufficient
4. saves the brief to `docs/designs/` before starting the debate
5. runs an unattended two-model debate
6. offers to update the saved file with the final design doc

## Commands

### `/design <topic>`

Full workflow: intake → brief → debate → save.

### `/design-debate <path-to-brief.md>`

Skip intake and run the debate directly from an existing brief file. The file
content is used as-is for the architect prompts. The final design document
overwrites the source file (with confirmation).

### `/design-cancel`

Cancel the active design workflow.

## Configuration

Global config:
- `~/.pi/agent/design-studio.json`

Project config:
- `.pi/design-studio.json`

Project config overrides global config.

### Example

```json
{
  "defaultProfile": "balanced",
  "profiles": {
    "balanced": {
      "facilitator": "anthropic/claude-sonnet-4-20250514:medium",
      "architectA": "anthropic/claude-sonnet-4-20250514:high",
      "architectB": "openai/gpt-5:high",
      "maxRounds": 3,
      "saveDir": "docs/designs"
    }
  }
}
```

Model refs support either:

- shorthand: `provider/model[:thinking]`
- object form:

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "thinkingLevel": "high"
}
```

Supported thinking levels:
- `off`
- `minimal`
- `low`
- `medium`
- `high`
- `xhigh`
