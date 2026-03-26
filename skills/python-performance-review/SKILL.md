---
name: python-performance-review
description: This skill should be used when the user asks to "review performance", "optimize Python", "Python performance", "performance audit", "find bottlenecks", "improve efficiency", or wants analysis of Python code performance focusing on runtime hotspots, data handling, and concurrency patterns.
---

# Python Performance Review

**Action required:** Run `/review python performance` to start an interactive performance review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Analyze Python code for performance issues, focusing on CPython runtime behavior, allocation patterns, I/O throughput, and data processing efficiency.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.py` and `.pyi` files
   - If no changes, ask the user what to review

## Review Process

1. **Identify hot paths**: Request handlers, tight loops, data pipelines, startup paths
2. **Analyze allocation and I/O flow**
3. **Check runtime-specific patterns** below
4. **Output findings** in the standard format

## Performance Checklist

### Algorithmic Complexity
- Avoids accidental O(n²)/O(n³) in loops and nested searches
- Uses appropriate data structures (`dict`/`set` vs lists for lookups and membership)
- Avoids repeated full scans when indexing/caching would help
- Pagination/streaming used for large collections
- Uses `collections.deque` for queue operations instead of list pop(0)

### Allocation & Memory
- Avoids unnecessary list/dict recreation in hot paths
- Uses generators and `itertools` for lazy evaluation of large sequences
- Avoids materializing entire datasets when streaming is possible
- Uses `__slots__` on high-frequency data classes when beneficial
- Minimizes temporary allocations in parser/transform pipelines
- Uses `memoryview` or `array` for large binary/numeric data when appropriate

### I/O & External Calls
- Batches network/database requests when possible
- Avoids N+1 query patterns (ORM-aware: `select_related`, `prefetch_related`, eager loading)
- Uses connection pooling for database/HTTP clients
- File I/O uses buffering and appropriate chunk sizes
- Uses `mmap` for large file random access where applicable
- Caching strategy considered for frequently requested data (`functools.lru_cache`, `@cache`, external cache)

### Async & Concurrency
- Uses `asyncio` / `async/await` for I/O-bound concurrency
- Uses `concurrent.futures` / `multiprocessing` for CPU-bound parallelism
- Avoids GIL contention for CPU-heavy work (offloads to processes or C extensions)
- Independent async work runs concurrently (`asyncio.gather`, `TaskGroup`) where safe
- Avoids accidental serial awaits in loops
- Timeouts configured to avoid runaway resource usage

### Data Processing & Serialization
- JSON parsing/stringifying not repeated unnecessarily
- Uses appropriate serialization libraries (e.g., `orjson`, `msgpack` for high-throughput)
- Schema validation scoped to boundaries, not repeated in deep layers
- Large data transforms use chunking/streaming where possible
- Regex compiled and reused (`re.compile`) instead of repeated inline patterns
- Avoids catastrophic regex backtracking

### Python-Specific Patterns
- Uses built-in functions (`sum`, `min`, `max`, `sorted`, `any`, `all`) over manual loops
- Avoids repeated string concatenation in loops (uses `join` or `io.StringIO`)
- Uses `collections.Counter`, `defaultdict`, `namedtuple` where appropriate
- Avoids global variable lookups in tight loops (local variable binding)
- Import-time side effects minimized for fast startup
- Uses `bisect` for sorted collection operations
- Avoids unnecessary `copy.deepcopy` — uses shallow copies or immutable structures

### NumPy/Pandas (if applicable)
- Uses vectorized operations instead of row-by-row iteration
- Avoids `DataFrame.apply()` when vectorized alternatives exist
- Uses appropriate dtypes to minimize memory (e.g., `category`, smaller int types)
- Avoids chained indexing (`.loc`/`.iloc` used correctly)
- Large datasets processed in chunks when full materialization is unnecessary

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.py:LINE`
**Category:** performance

**Issue:** Description of the performance concern and its impact.

**Suggestion:** How to optimize, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Major bottlenecks, unbounded growth, blocking I/O on async paths
- MEDIUM: Suboptimal patterns with measurable overhead
- LOW: Minor optimizations and cleanup opportunities

## Summary

After all findings, provide:
- Total count by severity
- Top bottlenecks to address
- Hot paths identified
- Overall performance assessment (1-2 sentences)
