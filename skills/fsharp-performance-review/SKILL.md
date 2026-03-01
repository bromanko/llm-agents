---
name: fsharp-performance-review
description: This skill should be used when the user asks to "review performance", "optimize F#", ".NET performance", "performance audit", "find bottlenecks", "improve efficiency", or wants analysis of F# code performance focusing on .NET runtime patterns, async architecture, and data structure choices.
---

# F# Performance Review

**Action required:** Run `/review fsharp performance` to start an interactive performance review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze F# code for performance issues, focusing on .NET runtime patterns, allocation behavior, async architecture, and efficient data handling.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.fs` and `.fsx` files
   - If no changes, ask the user what to review

## Review Process

1. **Identify hot paths**: Find frequently executed code (request handlers, loops, recursive functions)
2. **Analyze data flow**: Track how data moves through the system
3. **Check .NET-specific patterns** below
4. **Review async architecture** if applicable
5. **Output findings** in the standard format

## Performance Checklist

### Allocation & GC Pressure
- Avoid unnecessary boxing (e.g., DU cases with value types, generic constraints)
- Use `[<Struct>]` on small discriminated unions and records where appropriate
- Avoid excessive intermediate collections in pipelines (consider `Seq` or manual loops)
- Use `ValueOption` / `ValueTask` in hot paths where allocation matters
- `StringBuilder` used instead of repeated string concatenation
- Aware of closure allocations in lambdas capturing local variables

### Collection Choices
- `List` (F# immutable list) used for sequential access and pattern matching
- `Array` used for random access, interop, and performance-critical code
- `Seq` used for lazy evaluation and large data streams
- `Map`/`Set` used for immutable key-based lookups
- `Dictionary`/`HashSet` used in hot paths where mutability is acceptable
- Avoid `List.nth` (O(n)) for random access — use arrays
- `ResizeArray` preferred over repeated `List.append` for building collections

### Async & Task Patterns
- `task { }` CE preferred over `async { }` for .NET interop and performance
- Avoid `Async.RunSynchronously` blocking on async code
- `Task.WhenAll` used for concurrent independent operations
- No unnecessary `async`/`task` wrapping of synchronous code
- `CancellationToken` threaded through for cancellable operations
- Avoid `Async.Start` fire-and-forget without error handling

### Recursion & Iteration
- Tail-call optimization used (accumulator pattern)
- `Array.Parallel` or `PSeq` for CPU-bound parallel work
- Recursive functions use `[<TailCall>]` attribute where supported
- Loops preferred over recursion in performance-critical code (when readability allows)
- `Seq.cache` used when a sequence is enumerated multiple times

### String Handling
- `String.Concat` or `StringBuilder` over `+` in loops
- `StringComparison.OrdinalIgnoreCase` for case-insensitive comparisons
- `ReadOnlySpan<char>` / `Span` for parsing-heavy code
- Interpolated strings preferred over `sprintf` for simple formatting (less allocation)
- Avoid repeated regex compilation — use `[<Literal>]` patterns or compiled regex

### Computation Expressions
- Custom CEs don't allocate excessively in `Bind`/`Return`
- `Result` CE chains don't build unnecessary intermediate state
- Consider inlining short CE builders in hot paths

### Interop & Marshalling
- P/Invoke signatures correct and efficient
- `[<Struct>]` used for interop structs to avoid heap allocation
- `ReadOnlySpan` / `Memory` used for buffer operations
- Minimize managed/unmanaged transitions

### Caching & Memoization
- Pure functions with expensive computation are memoized where appropriate
- `ConcurrentDictionary` or `Lazy<T>` for thread-safe caching
- Cache eviction considered for unbounded caches
- Avoid memoizing functions with large input spaces

### I/O & External Calls
- External calls don't block critical paths
- Batch operations where possible
- Connection pooling for databases/services
- Timeouts prevent hanging on slow externals
- Streaming used for large data (avoid loading entire datasets into memory)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/File.fs:LINE`
**Category:** performance

**Issue:** Description of the performance concern and its impact.

**Suggestion:** How to optimize, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Significant bottleneck, unbounded growth, blocking issues
- MEDIUM: Suboptimal patterns, unnecessary overhead
- LOW: Minor optimizations, micro-improvements

## Summary

After all findings, provide:
- Total count by severity
- Top bottlenecks to address
- Hot paths identified
- Architecture recommendations (if applicable)
- Overall performance assessment (1-2 sentences)
