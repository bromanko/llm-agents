---
name: rust-performance-review
description: This skill should be used when the user asks to "review performance", "optimize Rust", "Rust performance", "rust performance audit", "performance audit", "find bottlenecks", "improve efficiency", or wants analysis of Rust code performance focusing on allocation patterns, async/runtime efficiency, data structures, and zero-cost abstractions.
---

# Rust Performance Review

**Action required:** Run `/review rust performance` to start an interactive performance review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Rust code for performance issues, focusing on allocation behavior, data structure choice, async/runtime efficiency, I/O throughput, and avoidable costs that matter on realistic hot paths.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.rs` files
   - If no changes, ask the user what to review

## Review Process

1. **Identify hot paths**: request handlers, tight loops, parsers, serialization, background workers, startup paths, and frequently called library APIs
2. **Analyze ownership/allocation flow**, async scheduling, and I/O behavior
3. **Check Rust-specific performance patterns** below
4. **Prefer evidence-aware findings**: distinguish likely bottlenecks from optional micro-optimizations; suggest benchmarking/profiling when impact is uncertain
5. **Output findings** in the standard format

## Performance Checklist

### Algorithmic Complexity & Data Structures
- Avoids accidental O(n²)/O(n³) loops, nested scans, or repeated sorting
- Uses `HashMap`/`BTreeMap`/`IndexMap`/sets appropriately for lookup and ordering needs
- Avoids repeated full scans when indexing, caching, or pre-grouping would help
- Uses streaming/pagination for large collections instead of materializing everything
- Chooses data structures that fit mutation/access patterns (`Vec`, `VecDeque`, `SmallVec`, `Cow`, arenas, slabs, etc.)
- Avoids unnecessary synchronization structures on single-threaded paths

### Allocation & Copies
- Avoids unnecessary `clone()`, `to_string()`, `format!`, `collect()`, and intermediate `Vec`s in hot paths
- Pre-allocates `Vec`, `String`, `HashMap`, and buffers when size is known (`with_capacity`)
- Uses borrowing, slices, iterators, or `Cow` to avoid avoidable ownership conversions
- Avoids boxing/dynamic dispatch (`Box<dyn Trait>`, `Arc`) where monomorphized/static dispatch is clearly preferable and compile-size trade-off is acceptable
- Reuses buffers where appropriate for parsers/encoders and high-throughput loops
- Avoids excessive `Arc` cloning or refcount churn in tight loops
- Keeps large values from being copied unintentionally; derives `Copy` only for cheap types

### Iterators, Dispatch & Compiler Behavior
- Iterator chains remain understandable and do not allocate accidentally
- Avoids needless `collect::<Vec<_>>()` just to iterate again
- Uses `&str`/`&[T]` parameters instead of `String`/`Vec<T>` when borrowing is enough
- Generic abstractions are justified and do not create excessive compile-time or code-size costs on hot APIs
- Dynamic dispatch is used intentionally when it reduces code size or enables real runtime polymorphism
- Inlining attributes are profiling-justified; no speculative `#[inline(always)]` everywhere

### Async & Concurrency Performance
- Blocking file/network/CPU work is not performed on async executor worker threads
- Uses `spawn_blocking`, bounded worker pools, or dedicated threads for CPU/blocking work
- Avoids holding locks across `.await`
- Uses bounded channels/backpressure rather than unbounded queues for high-volume producers
- Task fan-out is bounded; no unbounded `tokio::spawn` / `join_all` over large inputs without limits
- Lock granularity is appropriate; avoids contention on hot shared state
- Chooses `std::sync` vs `tokio::sync` primitives intentionally based on await behavior
- Uses atomics carefully for simple counters/flags where mutexes are too costly

### I/O, Serialization & Parsing
- Uses buffered I/O (`BufReader`, `BufWriter`) for many small reads/writes
- Streams large files/responses instead of loading all data into memory
- Batches database/network requests where possible; avoids N+1 queries
- HTTP clients reuse connections and set timeouts
- Serialization avoids repeated allocation and unnecessary conversions
- Regexes are compiled once (`LazyLock`, `once_cell`, `lazy_static`) rather than per call
- Parsers enforce size limits and avoid recursive stack blowups on large inputs

### Memory Layout & Cache Locality
- Struct layout avoids avoidable padding for large arrays/hot structs when relevant
- Uses enums/newtypes without introducing large variant-size blowups accidentally
- Considers `Box` for large enum variants only when it improves memory layout or avoids moves
- Avoids pointer-heavy structures when contiguous `Vec` storage would improve cache locality
- Large maps/sets are reserved or sharded when appropriate

### Cargo/Profile/Build Considerations
- Release profile settings (`lto`, `codegen-units`, `panic`, debug symbols) match deployment/performance goals
- Feature flags avoid pulling in expensive runtime components unnecessarily
- Benchmarks exist or are recommended for changed hot paths (`criterion`, `cargo bench`, integration benchmarks)
- Profiling tools are suggested where needed (`perf`, `flamegraph`, `dhat`, `heaptrack`, `tokio-console`)

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.rs:LINE`
**Category:** performance

**Issue:** Description of the performance concern and its impact.

**Suggestion:** How to optimize, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Major bottlenecks, unbounded task spawning/queues, blocking work on async runtimes, pathological allocation/complexity on critical paths
- MEDIUM: Suboptimal patterns with plausible measurable overhead
- LOW: Minor optimizations, benchmark suggestions, or cleanup opportunities

## Summary

After all findings, provide:
- Total count by severity
- Top bottlenecks to address
- Hot paths identified
- Overall performance assessment (1-2 sentences)
