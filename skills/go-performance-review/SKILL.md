---
name: go-performance-review
description: This skill should be used when the user asks to "review performance", "optimize Go", "Go performance", "golang performance", "performance audit", "find bottlenecks", "improve efficiency", or wants analysis of Go code performance focusing on runtime hotspots, allocation patterns, and concurrency throughput.
---

# Go Performance Review

**Action required:** Run `/review go performance` to start an interactive performance review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Go code for performance issues, focusing on Go runtime behavior, allocation patterns, concurrency throughput, and I/O efficiency.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.go` files
   - If no changes, ask the user what to review

## Review Process

1. **Identify hot paths**: Request handlers, tight loops, data pipelines, serialization, startup paths
2. **Analyze allocation and concurrency flow**
3. **Check runtime-specific patterns** below
4. **Output findings** in the standard format

## Performance Checklist

### Algorithmic Complexity
- Avoids accidental O(n²)/O(n³) in loops and nested searches
- Uses `map` for lookups/membership instead of linear scans over slices
- Avoids repeated full scans when indexing/caching would help
- Pagination/streaming used for large collections
- Sorting uses appropriate algorithms for the data size and shape

### Allocation & GC Pressure
- Pre-allocates slices and maps with known capacity (`make([]T, 0, n)`, `make(map[K]V, n)`)
- Avoids unnecessary heap allocations in hot paths (pointer escape analysis awareness)
- Uses `sync.Pool` for frequently allocated/freed objects in high-throughput paths
- Avoids excessive use of `interface{}` / `any` which forces boxing
- Minimizes string-to-byte-slice conversions in hot loops
- Uses `strings.Builder` or `bytes.Buffer` for string concatenation (not `+` in loops)
- Considers stack-allocated small structs vs pointer indirection trade-offs
- Avoids `append` in tight loops without pre-sized capacity

### I/O & External Calls
- Batches network/database requests when possible
- Avoids N+1 query patterns
- Uses connection pooling (`sql.DB`, HTTP `Transport` with connection reuse)
- Buffered I/O used where appropriate (`bufio.Reader`, `bufio.Writer`)
- File I/O uses appropriate buffer sizes
- HTTP response bodies fully drained and closed for connection reuse
- Caching strategy considered for frequently requested data
- Uses `io.Copy` / `io.CopyBuffer` instead of reading entire files into memory

### Concurrency & Scheduling
- Uses bounded goroutine pools for fan-out work (not unbounded goroutine spawning)
- Worker pools use buffered channels or semaphores for backpressure
- Lock granularity is appropriate — no coarse locks over large critical sections
- Uses `sync.RWMutex` for read-heavy shared state
- Avoids lock contention in hot paths (considers sharding or lock-free approaches)
- Uses `atomic` operations for simple counters and flags instead of mutexes
- Context cancellation propagated to avoid wasted work
- Channel operations don't block unexpectedly (no silent deadlocks)
- `select` with `default` used intentionally to avoid unnecessary blocking

### Serialization & Data Processing
- JSON encoding/decoding uses streaming (`json.Decoder`/`json.Encoder`) for large payloads
- Considers `encoding/binary` or protocol buffers for high-throughput binary data
- Regex compiled once (`regexp.MustCompile` at package level) not per-call
- Avoids reflection in hot paths (prefers code generation or manual marshaling)
- Uses `strconv` instead of `fmt.Sprintf` for simple numeric conversions
- Large data transforms use streaming/chunking where possible

### Go-Specific Runtime Patterns
- Avoids finalizers (`runtime.SetFinalizer`) — use explicit cleanup instead
- Understands goroutine stack growth implications for deeply recursive code
- Uses `unsafe.Sizeof` awareness for struct field alignment and padding
- Struct fields ordered to minimize padding (largest fields first)
- Considers `GOGC` and `GOMEMLIMIT` tuning for allocation-heavy workloads
- Uses `//go:noinline`, `//go:nosplit` pragmas only when profiling-justified
- Avoids `time.After` in tight loops (leaks timers until fire); uses `time.NewTimer` with `Reset`

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.go:LINE`
**Category:** performance

**Issue:** Description of the performance concern and its impact.

**Suggestion:** How to optimize, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Major bottlenecks, unbounded goroutine spawning, GC thrashing, blocking I/O on critical paths
- MEDIUM: Suboptimal patterns with measurable overhead
- LOW: Minor optimizations and cleanup opportunities

## Summary

After all findings, provide:
- Total count by severity
- Top bottlenecks to address
- Hot paths identified
- Overall performance assessment (1-2 sentences)
