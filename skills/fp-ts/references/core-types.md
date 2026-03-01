# Core fp-ts Types

Comprehensive reference for Option, Either, Task, and TaskEither - the most commonly used fp-ts types.

## Option Type

Represents optional values without null/undefined.

### Construction

```typescript
import * as O from 'fp-ts/Option';

// Create Option values
const some = O.some(42);           // Some(42)
const none = O.none;                // None
const fromNullable = O.fromNullable(maybeValue); // Some or None
const fromPredicate = O.fromPredicate((n: number) => n > 0)(5); // Some(5)

// Type: Option<number>
```

### Core Operations

```typescript
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';

// map - transform the value
pipe(
  O.some(5),
  O.map(n => n * 2)
); // Some(10)

// flatMap (chain) - sequencing operations that return Option
pipe(
  O.some(5),
  O.flatMap(n => n > 0 ? O.some(n * 2) : O.none)
); // Some(10)

// getOrElse - extract value with default
pipe(
  O.none,
  O.getOrElse(() => 0)
); // 0

// fold (match) - handle both cases
pipe(
  O.some(5),
  O.fold(
    () => 'No value',
    n => `Value: ${n}`
  )
); // "Value: 5"

// filter
pipe(
  O.some(5),
  O.filter(n => n > 3)
); // Some(5)

// alt - provide alternative Option
pipe(
  O.none,
  O.alt(() => O.some(42))
); // Some(42)
```

### Advanced Patterns

```typescript
// Traverse array of Options
import * as A from 'fp-ts/Array';

const options = [O.some(1), O.some(2), O.some(3)];

pipe(
  options,
  A.sequence(O.Applicative)
); // Some([1, 2, 3])

pipe(
  [O.some(1), O.none, O.some(3)],
  A.sequence(O.Applicative)
); // None

// Do notation for imperative-style sequencing
pipe(
  O.Do,
  O.bind('x', () => O.some(5)),
  O.bind('y', () => O.some(3)),
  O.map(({ x, y }) => x + y)
); // Some(8)

// exists and every
pipe(
  O.some(5),
  O.exists(n => n > 3)
); // true

// toNullable and toUndefined
pipe(
  O.some(5),
  O.toNullable
); // 5

pipe(
  O.none,
  O.toNullable
); // null
```

### Common Use Cases

```typescript
// Safe array access
const head = <A>(arr: readonly A[]): O.Option<A> =>
  pipe(arr, A.head);

// Safe property access
const getProp = <K extends string>(key: K) =>
  <T extends Record<K, unknown>>(obj: T): O.Option<T[K]> =>
    O.fromNullable(obj[key]);

// Safe parsing
const parseNumber = (s: string): O.Option<number> =>
  pipe(
    O.tryCatch(() => {
      const n = parseFloat(s);
      return isNaN(n) ? null : n;
    })
  );

// Chaining optional operations
type User = { name: string; address?: { city?: string } };

const getCity = (user: User): O.Option<string> =>
  pipe(
    user.address,
    O.fromNullable,
    O.flatMap(addr => O.fromNullable(addr.city))
  );
```

## Either Type

Represents computations that can fail.

### Construction

```typescript
import * as E from 'fp-ts/Either';

// Create Either values
const right = E.right(42);               // Right(42)
const left = E.left('error');            // Left('error')
const fromPredicate = E.fromPredicate(
  (n: number) => n > 0,
  n => `${n} is not positive`
)(5); // Right(5)

// Type: Either<string, number>
```

### Core Operations

```typescript
import { pipe } from 'fp-ts/function';
import * as E from 'fp-ts/Either';

// map - transform right value
pipe(
  E.right(5),
  E.map(n => n * 2)
); // Right(10)

// mapLeft - transform left value
pipe(
  E.left('error'),
  E.mapLeft(e => e.toUpperCase())
); // Left('ERROR')

// flatMap (chain) - sequence Either-returning operations
pipe(
  E.right(5),
  E.flatMap(n => n > 0 ? E.right(n * 2) : E.left('negative'))
); // Right(10)

// fold (match) - handle both cases
pipe(
  E.right(5),
  E.fold(
    error => `Error: ${error}`,
    value => `Success: ${value}`
  )
); // "Success: 5"

// getOrElse - extract value with default
pipe(
  E.left('error'),
  E.getOrElse(() => 0)
); // 0

// orElse - provide alternative Either
pipe(
  E.left('error'),
  E.orElse(() => E.right(42))
); // Right(42)

// swap - exchange left and right
pipe(
  E.right(5),
  E.swap
); // Left(5)

// bimap - map both sides
pipe(
  E.right<string, number>(5),
  E.bimap(
    e => e.toUpperCase(),
    n => n * 2
  )
); // Right(10)
```

### Error Handling Patterns

```typescript
// tryCatch - wrap throwing code
const safeParse = (json: string): E.Either<Error, unknown> =>
  E.tryCatch(
    () => JSON.parse(json),
    reason => new Error(`Parse error: ${reason}`)
  );

// Validation with Either
const validateEmail = (email: string): E.Either<string, string> =>
  email.includes('@')
    ? E.right(email)
    : E.left('Invalid email');

const validateAge = (age: number): E.Either<string, number> =>
  age >= 18
    ? E.right(age)
    : E.left('Must be 18 or older');

// Chain validations
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

// Do notation for cleaner syntax
const validateUserDo = (email: string, age: number): E.Either<string, User> =>
  pipe(
    E.Do,
    E.bind('email', () => validateEmail(email)),
    E.bind('age', () => validateAge(age))
  );
```

### Combining Multiple Eithers

```typescript
import * as A from 'fp-ts/Array';
import { sequenceT } from 'fp-ts/Apply';

// Sequence array of Eithers (fails on first error)
const eithers: E.Either<string, number>[] = [
  E.right(1),
  E.right(2),
  E.right(3)
];

pipe(
  eithers,
  A.sequence(E.Applicative)
); // Right([1, 2, 3])

// Parallel validation with sequenceT
pipe(
  sequenceT(E.Applicative)(
    validateEmail('test@example.com'),
    validateAge(25)
  )
); // Right(['test@example.com', 25])

// Convert to Option
pipe(
  E.right(5),
  E.toOption
); // Some(5)

pipe(
  E.left('error'),
  E.toOption
); // None
```

## Task and TaskEither

Handle asynchronous operations.

### Task

Lazy Promise (only executes when called).

```typescript
import * as T from 'fp-ts/Task';
import { pipe } from 'fp-ts/function';

// Create Task
const delay = (ms: number): T.Task<void> =>
  () => new Promise(resolve => setTimeout(resolve, ms));

const fetchData = (): T.Task<Data> =>
  () => fetch('/api/data').then(r => r.json());

// map
pipe(
  fetchData(),
  T.map(data => data.items.length)
); // Task<number>

// flatMap (chain)
pipe(
  fetchData(),
  T.flatMap(data =>
    pipe(
      delay(1000),
      T.map(() => data)
    )
  )
); // Task<Data>

// Execute
const task = fetchData();
task().then(data => console.log(data));
```

### TaskEither

Asynchronous operations that can fail.

```typescript
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';

// Create TaskEither
const fetchUser = (id: number): TE.TaskEither<Error, User> =>
  TE.tryCatch(
    () => fetch(`/api/users/${id}`).then(r => {
      if (!r.ok) throw new Error('Not found');
      return r.json();
    }),
    reason => new Error(`Fetch failed: ${reason}`)
  );

// map - transform success value
pipe(
  fetchUser(1),
  TE.map(user => user.name)
); // TaskEither<Error, string>

// mapLeft - transform error
pipe(
  fetchUser(1),
  TE.mapLeft(error => ({ message: error.message, code: 500 }))
); // TaskEither<{message: string, code: number}, User>

// flatMap (chain) - sequence async operations
pipe(
  fetchUser(1),
  TE.flatMap(user => fetchPosts(user.id))
); // TaskEither<Error, Post[]>

// fold (match)
pipe(
  fetchUser(1),
  TE.fold(
    error => T.of(`Error: ${error.message}`),
    user => T.of(`User: ${user.name}`)
  )
)(); // Promise<string>

// getOrElse
pipe(
  fetchUser(1),
  TE.getOrElse(error => T.of(defaultUser))
)(); // Promise<User>

// orElse - provide alternative
pipe(
  fetchUser(1),
  TE.orElse(error => fetchUserFromCache(1))
); // TaskEither<Error, User>
```

### Do Notation with TaskEither

```typescript
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

### Parallel Execution

```typescript
import { sequenceT } from 'fp-ts/Apply';
import { sequenceArray } from 'fp-ts/Array';

// Execute in parallel with sequenceT
const fetchUserData = (id: number): TE.TaskEither<Error, UserData> =>
  pipe(
    sequenceT(TE.ApplicativePar)(
      fetchUser(id),
      fetchPosts(id),
      fetchComments(id)
    ),
    TE.map(([user, posts, comments]) => ({
      user,
      posts,
      comments
    }))
  );

// Execute array in parallel
const fetchUsers = (ids: number[]): TE.TaskEither<Error, User[]> =>
  pipe(
    ids.map(fetchUser),
    TE.sequenceArray  // or A.sequence(TE.ApplicativePar)
  );

// Execute array sequentially
const fetchUsersSeq = (ids: number[]): TE.TaskEither<Error, User[]> =>
  pipe(
    ids.map(fetchUser),
    A.sequence(TE.ApplicativeSeq)
  );
```

## Type Conversions

```typescript
// Option to Either
pipe(
  O.some(5),
  E.fromOption(() => 'No value')
); // Right(5)

// Either to Option
pipe(
  E.right(5),
  E.toOption
); // Some(5)

// TaskEither to Task
pipe(
  fetchUser(1),
  TE.fold(
    error => T.of(null),
    user => T.of(user)
  )
); // Task<User | null>
```

## Common Patterns

### Chaining Operations

```typescript
// Chain multiple async operations
const getUserProfile = (id: number): TE.TaskEither<Error, Profile> =>
  pipe(
    fetchUser(id),
    TE.flatMap(user =>
      pipe(
        fetchPosts(user.id),
        TE.map(posts => ({ ...user, posts }))
      )
    )
  );
```

### Error Recovery

```typescript
// Provide fallback on error
pipe(
  fetchUser(1),
  TE.orElse(error => fetchUserFromCache(1)),
  TE.orElse(error => TE.right(defaultUser))
); // Always succeeds
```

### Conditional Logic

```typescript
// Filter and flatMap
pipe(
  fetchUser(id),
  TE.filterOrElse(
    user => user.active,
    user => new Error('User not active')
  ),
  TE.flatMap(user => processActiveUser(user))
);
```
