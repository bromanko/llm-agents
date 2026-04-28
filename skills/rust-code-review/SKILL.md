---
name: rust-code-review
description: This skill should be used when the user asks to "review Rust code", "Rust code quality", "Rust idioms check", "review my Rust", "rust code review", "check code quality", or wants feedback on Rust ownership, error handling, trait design, async patterns, and module organization.
---

# Rust Code Review

**Action required:** Run `/review rust code` to start an interactive code quality review. Do not perform the review manually.

---

<!-- The content below is used by the /review command as review instructions -->

Perform a thorough code quality review of Rust code, focusing on idiomatic ownership, error handling, trait/API design, async correctness, and maintainable module structure.

## Scope Determination

First, determine what code to review:

1. **If the user specifies files/directories**: Review those paths
2. **If no scope specified**: Review working changes
   - Check for `.jj` directory first, use `jj diff` if present
   - Otherwise use `git diff` to identify changed `.rs` files
   - If no changes, ask the user what to review

## Review Process

1. **Read the target files** using the Read tool
2. **Understand crate context**: inspect nearby `Cargo.toml`, module boundaries, feature flags, and existing project conventions when relevant
3. **Analyze against the checklist** below
4. **Output findings** in the standard format

## Review Checklist

### Error Handling
- Fallible operations return `Result` instead of panicking for recoverable failures
- `unwrap()` / `expect()` are avoided in library and request-handling code unless invariants are documented and truly impossible to violate
- Errors carry useful context (`anyhow::Context`, `thiserror`, custom error enums, or equivalent)
- Public APIs expose stable, meaningful error types rather than leaking incidental implementation details
- Error conversions with `From` / `?` preserve cause chains where callers need diagnostics
- No swallowed errors (`let _ = ...`) unless explicitly safe and documented
- `panic!`, `todo!`, `unimplemented!`, and `unreachable!` are not reachable from normal inputs

### Ownership, Borrowing & Lifetimes
- Avoids unnecessary `clone()` / `to_string()` / allocation to appease the borrow checker when borrowing or `Cow` would be clearer
- Ownership transfer is explicit and matches API intent
- Lifetimes are not over-constrained; signatures stay readable and ergonomic
- `Copy` / `Clone` derives are intentional and do not hide expensive copies
- References do not outlive protected state (especially around locks, caches, and async boundaries)
- Interior mutability (`RefCell`, `Mutex`, `RwLock`, `Cell`) is justified and localized

### Idiomatic Rust Patterns
- Uses pattern matching, `Option` / `Result` combinators, and `?` where they improve clarity
- Prefers iterators for straightforward transformations but uses loops when they are clearer
- Uses `Default`, `From` / `TryFrom`, `AsRef` / `Borrow`, and `IntoIterator` idiomatically
- Avoids excessive macro magic when ordinary functions/types would be clearer
- Derives standard traits (`Debug`, `Clone`, `Eq`, `Hash`, `Serialize`, etc.) intentionally
- Keeps unsafe code isolated behind safe abstractions with documented invariants
- `rustfmt` and `clippy` expectations are respected; no needless `#[allow]` attributes

### API & Trait Design
- Public APIs are minimal, documented, and hard to misuse
- Trait bounds are no stronger than necessary (`AsRef<Path>` vs `String`, `impl Trait` vs concrete types)
- Traits are introduced for real abstraction points, not premature mocking or layering
- Generic code remains readable and compile-time costs are justified
- Type aliases/newtypes clarify domain concepts and prevent argument-order mistakes
- Public structs avoid exposing fields that should remain invariants
- Feature flags do not create surprising API or behavior differences

### Async & Concurrency
- Async functions do not hold `std::sync::Mutex` guards or other blocking guards across `.await`
- Blocking I/O or CPU-heavy work is not performed on async executor threads; uses `spawn_blocking` / worker pools where needed
- Tasks have clear cancellation/shutdown paths and are awaited or detached intentionally
- Shared mutable state is protected by appropriate synchronization (`Arc<Mutex<_>>`, channels, atomics, `DashMap`, etc.)
- Channel ownership and close semantics are clear
- `Send` / `Sync` bounds are intentional and not worked around unsafely
- No deadlocks from lock ordering, nested locks, or await-while-locked patterns

### Module & Crate Organization
- Module boundaries reflect domain concepts and keep visibility narrow (`pub(crate)` before `pub`)
- `lib.rs` / `main.rs` remain thin; complex logic lives in focused modules
- Crate features are additive and documented
- Tests, benches, examples, and integration tests are placed in conventional locations
- Dependencies are justified; no large dependency for trivial functionality
- Build scripts (`build.rs`) are minimal and deterministic

### Readability & Maintainability
- Names follow Rust conventions (`snake_case`, `CamelCase`, clear enum variants)
- Functions are focused and have manageable control flow
- Comments explain invariants, safety, and non-obvious domain rules rather than restating code
- No dead code, stale TODOs, or commented-out implementations
- Logging/tracing is structured and at appropriate levels
- Domain invariants are enforced by types where practical

## Output Format

Present findings as:

```markdown
## Findings

### [SEVERITY] Issue Title
**File:** `path/to/file.rs:LINE`
**Category:** quality

**Issue:** Description of what's wrong and why it matters.

**Suggestion:** How to fix, with code example if helpful.

**Effort:** trivial|small|medium|large

---
```

Use severity indicators:
- HIGH: Bugs, reachable panics, deadlocks, data races through unsafe/interior mutability misuse, resource leaks, broken public API contracts
- MEDIUM: Non-idiomatic ownership/error handling, confusing trait/API design, async misuse with realistic reliability impact
- LOW: Style issues, minor simplifications, optional maintainability improvements

## Summary

After all findings, provide:
- Total count by severity
- Top 2-3 priority items to address
- Overall code quality assessment (1-2 sentences)
