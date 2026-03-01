---
name: fp-ts
description: This skill should be used when the user asks to "write idiomatic fp-ts", "refactor to fp-ts", "use Option/Either/Task/TaskEither", "compose with pipe/flow", "handle errors with fp-ts", "convert to functional style", "use fp-ts patterns", or mentions fp-ts types, monads, or functional composition in TypeScript.
---

# fp-ts Mastery

Provide expert guidance for writing idiomatic TypeScript using fp-ts, the most widely-used library for typed functional programming in TypeScript.

## Installation and Setup

```bash
npm install fp-ts
```

Import from specific modules to optimize tree-shaking:

```typescript
import * as O from 'fp-ts/Option';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import * as A from 'fp-ts/Array';
import { pipe, flow } from 'fp-ts/function';
```

## Core Composition: pipe and flow

The foundation of fp-ts is function composition using `pipe` and `flow`.

**pipe** - Apply functions left-to-right on a value:

```typescript
const result = pipe(
  5,
  n => n * 2,    // 10
  n => n + 1,    // 11
  n => n.toString() // "11"
);
```

**flow** - Compose functions without an initial value:

```typescript
const processNumber = flow(
  (n: number) => n * 2,
  n => n + 1,
  n => n.toString()
);

processNumber(5); // "11"
```

## When to Use Which Type

Guide users to the appropriate fp-ts type based on their needs:

### Option<A>
Use when a value may or may not exist (replaces null/undefined).

**Use cases:**
- Safe array access (head, lookup)
- Safe property access
- Optional configuration values
- Parsing that may fail without detailed errors

**Key operations:** `some`, `none`, `map`, `flatMap`, `getOrElse`, `fold`

### Either<E, A>
Use when an operation can fail and you need error information.

**Use cases:**
- Validation with specific error messages
- Parsing with error details
- Business logic that can fail
- Chaining operations that may fail

**Key operations:** `right`, `left`, `map`, `flatMap`, `fold`, `mapLeft`, `orElse`

### Task<A>
Use for asynchronous operations that cannot fail (lazy Promise).

**Use cases:**
- Delays
- Simple async operations without error handling
- Composing async operations

**Key operations:** `map`, `flatMap`, `of`

### TaskEither<E, A>
Use for asynchronous operations that can fail (the most common choice for async code).

**Use cases:**
- API requests
- Database queries
- File I/O
- Any async operation with error handling

**Key operations:** `tryCatch`, `map`, `flatMap`, `mapLeft`, `fold`, `orElse`, `getOrElse`

### Reader<R, A>
Use for dependency injection (threading configuration/dependencies).

**Use cases:**
- Configuration management
- Dependency injection
- Environment-based behavior

**Key operations:** `ask`, `map`, `flatMap`, `local`

### ReaderTaskEither<R, E, A>
Use for async operations with dependencies and error handling.

**Use cases:**
- Application services with injected dependencies
- Testing with mock dependencies
- Complex async workflows with DI

**Key operations:** `ask`, `tryCatch`, `map`, `flatMap`, Do notation

### State<S, A>
Use for threading state through computations.

**Use cases:**
- State machines
- Stateful computations
- Counter/accumulator patterns

**Key operations:** `get`, `put`, `modify`, `map`, `flatMap`

### IO<A>
Use for synchronous side effects.

**Use cases:**
- Console logging
- Random number generation
- Reading current time
- Wrapping imperative code

**Key operations:** `map`, `flatMap`, `of`

## Essential Patterns

### Do Notation for Sequential Operations

When chaining multiple operations, use Do notation for cleaner syntax:

```typescript
// With TaskEither
const processUser = (id: number): TE.TaskEither<Error, Result> =>
  pipe(
    TE.Do,
    TE.bind('user', () => fetchUser(id)),
    TE.bind('posts', ({ user }) => fetchPosts(user.id)),
    TE.bind('comments', ({ posts }) => fetchComments(posts[0].id)),
    TE.map(({ user, posts, comments }) => ({
      user,
      postCount: posts.length,
      commentCount: comments.length
    }))
  );
```

### Parallel vs Sequential Execution

Use `ApplicativePar` for parallel execution, `ApplicativeSeq` for sequential:

```typescript
import { sequenceT } from 'fp-ts/Apply';

// Parallel
const fetchUserData = pipe(
  sequenceT(TE.ApplicativePar)(
    fetchUser(id),
    fetchPosts(id),
    fetchComments(id)
  ),
  TE.map(([user, posts, comments]) => ({ user, posts, comments }))
);

// Sequential
pipe(
  ids.map(fetchUser),
  A.sequence(TE.ApplicativeSeq)
);
```

### Error Handling

Chain operations with `flatMap` to short-circuit on first error:

```typescript
const validateUser = (email: string, age: number): E.Either<string, User> =>
  pipe(
    validateEmail(email),
    E.flatMap(validEmail =>
      pipe(
        validateAge(age),
        E.map(validAge => ({ email: validEmail, age: validAge }))
      )
    )
  );
```

### Safe Array Operations

Use fp-ts Array utilities for safe, functional operations:

```typescript
pipe(
  [1, 2, 3],
  A.head,                          // Some(1)
  O.map(n => n * 2),              // Some(2)
  O.getOrElse(() => 0)            // 2
);

pipe(
  ['1', 'foo', '2'],
  A.filterMap(s => {
    const n = parseInt(s);
    return isNaN(n) ? O.none : O.some(n);
  })
); // [1, 2]
```

### Traverse for Effect Collections

Use `traverse` to apply effects over collections:

```typescript
// Fetch multiple users in parallel
const fetchUsers = (ids: number[]): TE.TaskEither<Error, User[]> =>
  pipe(
    ids,
    A.traverse(TE.ApplicativePar)(fetchUser)
  );

// Validate array of inputs
const validateAll = (inputs: string[]): E.Either<string, number[]> =>
  pipe(
    inputs,
    A.traverse(E.Applicative)(validateNumber)
  );
```

## Best Practices

1. **Always use pipe** - Left-to-right data flow improves readability
2. **Use Do notation** - Makes sequential operations clearer
3. **Choose specific types** - TaskEither for async+errors, Option for nullability
4. **Prefer traverse** - Use `traverse` and `sequence` over manual loops
5. **Type errors explicitly** - Use discriminated unions for error types
6. **Parallel when possible** - Use `ApplicativePar` for independent operations
7. **Compose with flow** - Create reusable function compositions
8. **Avoid nesting** - Flatten with `flatMap`
9. **Use type classes** - Leverage Eq, Ord, Semigroup for generic operations
10. **Extract value at boundaries** - Keep effects internal, unwrap at program edges

## Converting Imperative Code

### Null/Undefined to Option

```typescript
// Before
const value = arr[0];
if (value !== undefined) {
  return value * 2;
}
return 0;

// After
pipe(
  arr,
  A.head,
  O.map(n => n * 2),
  O.getOrElse(() => 0)
);
```

### Try/Catch to Either

```typescript
// Before
try {
  const data = JSON.parse(json);
  return data;
} catch (e) {
  return null;
}

// After
pipe(
  E.tryCatch(
    () => JSON.parse(json),
    e => new Error(`Parse error: ${e}`)
  )
);
```

### Promise to TaskEither

```typescript
// Before
async function fetchUser(id: number): Promise<User> {
  const response = await fetch(`/api/users/${id}`);
  if (!response.ok) throw new Error('Not found');
  return response.json();
}

// After
const fetchUser = (id: number): TE.TaskEither<Error, User> =>
  TE.tryCatch(
    () => fetch(`/api/users/${id}`).then(r => {
      if (!r.ok) throw new Error('Not found');
      return r.json();
    }),
    reason => new Error(`Fetch failed: ${reason}`)
  );
```

## Reference Materials

For detailed information on specific fp-ts features, consult the reference files:

### Core Types
**`references/core-types.md`** - Comprehensive guide to Option, Either, Task, and TaskEither with all operations, patterns, and examples.

### Advanced Types
**`references/advanced-types.md`** - Reader, ReaderTaskEither, State, and IO monads for dependency injection and state management.

### Collections
**`references/collections.md`** - Array and Record operations including filtering, mapping, traversing, and effect handling.

### Optics
**`references/optics.md`** - Lenses, Prisms, and Traversals for immutable nested data access and modification.

### Practical Patterns
**`references/patterns.md`** - Real-world patterns including API pipelines, form validation, dependency injection, error recovery, caching, and resource management.

## Process for Writing fp-ts Code

1. **Identify the effect type needed** - Use the "When to Use Which Type" section
2. **Start with pipe** - Build compositions left-to-right
3. **Use Do notation for clarity** - When binding multiple values
4. **Consult references** - Read relevant reference files for detailed operations
5. **Prefer traverse** - For collections with effects
6. **Handle errors explicitly** - Type errors as discriminated unions
7. **Execute at boundaries** - Keep effects internal, unwrap at program edges

## Integration Notes

fp-ts works well with:
- **monocle-ts** - Optics library (lenses, prisms)
- **io-ts** - Runtime type validation
- **Effect-TS** - Modern effect system (consider for new projects)
- **fast-check** - Property-based testing

For advanced effect handling, structured concurrency, and fiber-based concurrency, consider Effect-TS for new projects. fp-ts remains excellent for standard functional patterns.
