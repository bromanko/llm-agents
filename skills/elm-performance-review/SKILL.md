---
name: elm-performance-review
description: This skill should be used when the user asks to "review performance", "optimize Elm", "Elm performance", "performance audit", "find bottlenecks", "improve efficiency", or wants analysis of Elm code performance focusing on virtual DOM efficiency, rendering patterns, and data structure choices.
---

# Elm Performance Review

**Action required:** Run `/review elm performance` to start an interactive performance review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Elm code for performance issues, focusing on virtual DOM rendering, lazy evaluation, efficient data handling, and avoiding unnecessary re-renders.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.elm` files
   - If no changes, ask the user what to review

## Review Process

1. **Identify hot paths**: Find frequently re-rendered views, large update cycles, expensive computations
2. **Analyze data flow**: Track how data moves through Model/update/view
3. **Check rendering patterns** below
4. **Review data structure choices**
5. **Output findings** in the standard format

## Performance Checklist

### Virtual DOM & Rendering
- `Html.Lazy.lazy` used for expensive view functions that don't change often
- `Html.Lazy.lazy2`/`lazy3` used with stable reference arguments
- `Html.Keyed.node` used for lists where items are reordered, added, or removed
- Avoid recreating view structures unnecessarily (e.g., inline anonymous functions in event handlers)
- Large lists use keyed nodes to avoid full re-render
- View functions that depend on a small subset of Model receive only what they need

### Model Design
- Model is not a single deeply nested record (causes full equality checks)
- Frequently changing data separated from stable data in Model
- Avoid storing derived/computed data in Model (compute in view instead, or use `Html.Lazy`)
- Consider breaking large Model into focused sub-models for `Html.Lazy` effectiveness
- Avoid `Dict` with thousands of entries if only a few are displayed at a time

### Update Function
- `update` returns same Model reference when nothing changed (enables `Html.Lazy` skipping)
- Avoid unnecessary record updates (`{ model | field = model.field }`)
- Batch related state changes in a single `update` branch
- `Cmd.batch` used to combine commands, not chained updates
- Avoid cascading messages (Msg triggers another Msg triggers another) — flatten when possible

### Data Structures
- `Dict` used for key-based lookups instead of `List.filter` / `List.find`
- `Set` used for membership tests instead of `List.member`
- `Array` used when index-based access is needed
- Avoid `List.length` in conditionals (O(n)) — track count in Model if needed
- Avoid `List.reverse` after `List.foldl` when `List.foldr` would suffice (or vice versa)
- Avoid rebuilding large data structures on every update

### JSON Decoding
- Decoders are not doing unnecessary work
- Large JSON payloads decoded into efficient structures (Dict, not List of pairs)
- `Decode.lazy` used for recursive decoders
- Avoid re-decoding data that hasn't changed

### Subscriptions
- Subscriptions are stable references (avoid recreating on every call)
- High-frequency subscriptions (animation frames, mouse moves) do minimal work
- `Sub.batch` used efficiently
- Inactive subscriptions return `Sub.none` rather than filtering events in update

### String & List Operations
- String concatenation uses `++` sparingly in loops — consider `String.join` or `String.concat`
- `List.map` / `List.filter` chains consolidated where possible
- Avoid multiple passes over the same list — use `List.foldl` for single-pass operations
- `String.fromInt` / `String.fromFloat` not called repeatedly for the same value

### HTTP & Commands
- Requests are not duplicated (debouncing for user input, deduplication for data fetching)
- Large responses handled appropriately (pagination, streaming if possible via ports)
- Loading states prevent redundant requests
- Failed requests don't trigger infinite retry loops

### Ports & JavaScript Interop
- Port messages are as small as necessary
- Avoid sending entire Model through ports
- High-frequency port communication batched where possible
- Large data transfers through ports use efficient serialization

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/Module.elm:LINE`
**Category:** performance

**Issue:** Description of the performance concern and its impact.

**Suggestion:** How to optimize, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Significant bottleneck, unbounded growth, rendering performance issues
- MEDIUM: Suboptimal patterns, unnecessary overhead
- LOW: Minor optimizations, micro-improvements

## Summary

After all findings, provide:
- Total count by severity
- Top bottlenecks to address
- Hot paths identified
- Architecture recommendations (if applicable)
- Overall performance assessment (1-2 sentences)
