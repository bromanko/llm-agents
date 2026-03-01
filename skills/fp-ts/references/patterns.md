# Practical fp-ts Patterns

Real-world patterns for common programming tasks using fp-ts.

## API Request Pipeline

Build type-safe API request pipelines with proper error handling.

### Basic API Request

```typescript
import * as TE from 'fp-ts/TaskEither';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

type ApiError =
  | { type: 'NetworkError'; message: string }
  | { type: 'ParseError'; message: string }
  | { type: 'ValidationError'; errors: string[] };

const request = <A>(
  url: string,
  options?: RequestInit
): TE.TaskEither<ApiError, A> =>
  pipe(
    TE.tryCatch(
      () => fetch(url, options),
      reason => ({
        type: 'NetworkError' as const,
        message: String(reason)
      })
    ),
    TE.flatMap(response =>
      TE.tryCatch(
        () => response.json(),
        reason => ({
          type: 'ParseError' as const,
          message: String(reason)
        })
      )
    )
  );

const validateUser = (data: unknown): E.Either<ApiError, User> => {
  if (isValidUser(data)) {
    return E.right(data as User);
  }
  return E.left({
    type: 'ValidationError',
    errors: ['Invalid user data']
  });
};

const fetchUser = (id: number): TE.TaskEither<ApiError, User> =>
  pipe(
    request<unknown>(`/api/users/${id}`),
    TE.flatMapEither(validateUser)
  );
```

### Authenticated Requests

```typescript
type AuthToken = string;

const authenticatedRequest = <A>(token: AuthToken) => (
  url: string,
  options?: RequestInit
): TE.TaskEither<ApiError, A> =>
  request<A>(url, {
    ...options,
    headers: {
      ...options?.headers,
      'Authorization': `Bearer ${token}`
    }
  });

// Use with Reader for DI
import * as RTE from 'fp-ts/ReaderTaskEither';

type Deps = { token: AuthToken };

const fetchUserAuth = (id: number): RTE.ReaderTaskEither<Deps, ApiError, User> =>
  pipe(
    RTE.ask<Deps>(),
    RTE.flatMap(({ token }) =>
      RTE.fromTaskEither(
        authenticatedRequest<unknown>(token)(`/api/users/${id}`)
      )
    ),
    RTE.flatMapEither(validateUser)
  );
```

### Parallel Requests

```typescript
import { sequenceT } from 'fp-ts/Apply';

const fetchUserProfile = (id: number): TE.TaskEither<ApiError, UserProfile> =>
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
```

### Request with Timeout

```typescript
import * as T from 'fp-ts/Task';

const timeout = <E, A>(
  ms: number,
  onTimeout: E
) => (te: TE.TaskEither<E, A>): TE.TaskEither<E, A> => {
  const timeoutTask: TE.TaskEither<E, A> = pipe(
    T.delay(ms)(T.of(undefined)),
    TE.fromTask,
    TE.flatMap(() => TE.left(onTimeout))
  );

  return pipe(
    te,
    TE.alt(() => timeoutTask)
  );
};

const fetchUserWithTimeout = (id: number): TE.TaskEither<ApiError, User> =>
  pipe(
    fetchUser(id),
    timeout(5000, {
      type: 'NetworkError' as const,
      message: 'Request timed out'
    })
  );
```

## Form Validation

Validate forms with error accumulation.

### Basic Validation

```typescript
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

type ValidationError = {
  field: string;
  message: string;
};

type Validation<A> = E.Either<ValidationError[], A>;

const validateRequired = (field: string) => (value: string): Validation<string> =>
  value.length > 0
    ? E.right(value)
    : E.left([{ field, message: 'Required' }]);

const validateEmail = (value: string): Validation<string> =>
  value.includes('@')
    ? E.right(value)
    : E.left([{ field: 'email', message: 'Invalid email' }]);

const validateAge = (value: number): Validation<number> =>
  value >= 18
    ? E.right(value)
    : E.left([{ field: 'age', message: 'Must be 18+' }]);

const validateLength = (field: string, min: number, max: number) =>
  (value: string): Validation<string> =>
    value.length >= min && value.length <= max
      ? E.right(value)
      : E.left([{
          field,
          message: `Must be between ${min} and ${max} characters`
        }]);
```

### Applicative Validation (Accumulate Errors)

```typescript
import * as Ap from 'fp-ts/Apply';
import { sequenceT } from 'fp-ts/Apply';

const getValidationApplicative = <E>(): Ap.Applicative2C<'Either', E[]> => ({
  ...E.Applicative,
  ap: (fab, fa) =>
    pipe(
      E.isLeft(fab),
      (leftFab) => leftFab
        ? pipe(
            E.isLeft(fa),
            (leftFa) => leftFa
              ? E.left([...fab.left, ...fa.left])
              : fab
          )
        : pipe(
            fa,
            E.map(a => fab.right(a))
          )
    )
});

const validateForm = (
  email: string,
  password: string,
  age: number
): Validation<{ email: string; password: string; age: number }> =>
  pipe(
    sequenceT(getValidationApplicative<ValidationError>())(
      pipe(
        email,
        validateRequired('email'),
        E.flatMap(validateEmail)
      ),
      pipe(
        password,
        validateRequired('password'),
        E.flatMap(validateLength('password', 8, 100))
      ),
      validateAge(age)
    ),
    E.map(([email, password, age]) => ({ email, password, age }))
  );

// Returns all errors at once
validateForm('', 'short', 15);
// Left([
//   { field: 'email', message: 'Required' },
//   { field: 'password', message: 'Must be between 8 and 100 characters' },
//   { field: 'age', message: 'Must be 18+' }
// ])
```

### Monadic Validation (Fail Fast)

```typescript
const validateFormMonadic = (
  email: string,
  password: string,
  age: number
): Validation<{ email: string; password: string; age: number }> =>
  pipe(
    E.Do,
    E.bind('email', () =>
      pipe(
        email,
        validateRequired('email'),
        E.flatMap(validateEmail)
      )
    ),
    E.bind('password', () =>
      pipe(
        password,
        validateRequired('password'),
        E.flatMap(validateLength('password', 8, 100))
      )
    ),
    E.bind('age', () => validateAge(age))
  );

// Returns first error only
validateFormMonadic('', 'short', 15);
// Left([{ field: 'email', message: 'Required' }])
```

## Dependency Injection

Use Reader and ReaderTaskEither for clean dependency injection.

### Service Layer with DI

```typescript
import * as RTE from 'fp-ts/ReaderTaskEither';
import { pipe } from 'fp-ts/function';

type Services = {
  userRepo: UserRepository;
  emailService: EmailService;
  logger: Logger;
  config: Config;
};

class UserService {
  getUser(id: number): RTE.ReaderTaskEither<Services, Error, User> {
    return pipe(
      RTE.ask<Services>(),
      RTE.flatMap(({ userRepo, logger }) =>
        RTE.tryCatch(
          async () => {
            logger.info(`Fetching user ${id}`);
            const user = await userRepo.findById(id);
            logger.info(`Found user ${user.name}`);
            return user;
          },
          e => new Error(`Failed to fetch user: ${e}`)
        )
      )
    );
  }

  createUser(data: UserData): RTE.ReaderTaskEither<Services, Error, User> {
    return pipe(
      RTE.Do,
      RTE.bind('services', () => RTE.ask<Services>()),
      RTE.bind('user', ({ services }) =>
        RTE.tryCatch(
          () => services.userRepo.create(data),
          e => new Error(`Failed to create user: ${e}`)
        )
      ),
      RTE.chainFirst(({ services, user }) =>
        RTE.fromTask(() =>
          services.emailService.sendWelcome(user.email)
        )
      ),
      RTE.chainFirst(({ services, user }) =>
        RTE.fromIO(() => services.logger.info(`Created user ${user.id}`))
      ),
      RTE.map(({ user }) => user)
    );
  }

  updateUser(
    id: number,
    updates: Partial<User>
  ): RTE.ReaderTaskEither<Services, Error, User> {
    return pipe(
      this.getUser(id),
      RTE.flatMap(user =>
        pipe(
          RTE.ask<Services>(),
          RTE.flatMap(({ userRepo }) =>
            RTE.tryCatch(
              () => userRepo.update(id, { ...user, ...updates }),
              e => new Error(`Failed to update user: ${e}`)
            )
          )
        )
      )
    );
  }
}

// Usage
const services: Services = {
  userRepo: new UserRepository(),
  emailService: new EmailService(),
  logger: new Logger(),
  config: loadConfig()
};

const userService = new UserService();

userService.createUser(userData)(services)()
  .then(E.fold(
    error => console.error(error),
    user => console.log('Created:', user)
  ));
```

### Testing with Mock Dependencies

```typescript
// Production dependencies
const prodServices: Services = {
  userRepo: new DatabaseUserRepository(),
  emailService: new SendGridEmailService(),
  logger: new ConsoleLogger(),
  config: loadConfig()
};

// Test dependencies
const testServices: Services = {
  userRepo: new InMemoryUserRepository(),
  emailService: new MockEmailService(),
  logger: new NoOpLogger(),
  config: testConfig
};

// Same service code, different dependencies
const service = new UserService();

service.getUser(1)(testServices)(); // Uses test deps
service.getUser(1)(prodServices)(); // Uses prod deps
```

## Error Recovery

Handle errors with fallbacks and retries.

### Retry with Exponential Backoff

```typescript
const retry = <E, A>(
  maxRetries: number,
  delayMs: number = 1000
) => (te: TE.TaskEither<E, A>): TE.TaskEither<E, A> => {
  const go = (n: number): TE.TaskEither<E, A> =>
    pipe(
      te,
      TE.orElse(error =>
        n > 0
          ? pipe(
              T.delay(delayMs * (maxRetries - n + 1))(T.of(undefined)),
              TE.fromTask,
              TE.flatMap(() => go(n - 1))
            )
          : TE.left(error)
      )
    );

  return go(maxRetries);
};

const fetchUserWithRetry = (id: number): TE.TaskEither<ApiError, User> =>
  pipe(
    fetchUser(id),
    retry(3, 1000)
  );
```

### Fallback Chain

```typescript
const fetchUserWithFallback = (id: number): TE.TaskEither<ApiError, User> =>
  pipe(
    fetchUser(id),
    TE.orElse(error => fetchUserFromCache(id)),
    TE.orElse(error => TE.right(getDefaultUser(id)))
  );
```

### Circuit Breaker Pattern

```typescript
type CircuitState = 'Closed' | 'Open' | 'HalfOpen';

class CircuitBreaker<E, A> {
  private state: CircuitState = 'Closed';
  private failures = 0;
  private threshold = 5;
  private timeout = 60000;
  private lastFailTime = 0;

  execute(te: TE.TaskEither<E, A>): TE.TaskEither<E | { type: 'CircuitOpen' }, A> {
    if (this.state === 'Open') {
      if (Date.now() - this.lastFailTime > this.timeout) {
        this.state = 'HalfOpen';
      } else {
        return TE.left({ type: 'CircuitOpen' } as any);
      }
    }

    return pipe(
      te,
      TE.map(result => {
        this.onSuccess();
        return result;
      }),
      TE.orElse(error => {
        this.onFailure();
        return TE.left(error);
      })
    );
  }

  private onSuccess() {
    this.failures = 0;
    this.state = 'Closed';
  }

  private onFailure() {
    this.failures++;
    this.lastFailTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = 'Open';
    }
  }
}
```

## Caching

Implement caching with fp-ts.

### Simple Cache

```typescript
import * as O from 'fp-ts/Option';

class Cache<K, V> {
  private cache: Map<K, V> = new Map();

  get(key: K): O.Option<V> {
    return O.fromNullable(this.cache.get(key));
  }

  set(key: K, value: V): void {
    this.cache.set(key, value);
  }

  delete(key: K): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }
}

const cached = <K, E, A>(
  cache: Cache<K, A>,
  key: K
) => (fetch: TE.TaskEither<E, A>): TE.TaskEither<E, A> =>
  pipe(
    cache.get(key),
    O.fold(
      () =>
        pipe(
          fetch,
          TE.map(value => {
            cache.set(key, value);
            return value;
          })
        ),
      value => TE.right(value)
    )
  );

// Usage
const userCache = new Cache<number, User>();

const fetchUserCached = (id: number): TE.TaskEither<ApiError, User> =>
  cached(userCache, id)(fetchUser(id));
```

### Cache with TTL

```typescript
type CacheEntry<V> = {
  value: V;
  expiry: number;
};

class TTLCache<K, V> {
  private cache: Map<K, CacheEntry<V>> = new Map();

  get(key: K): O.Option<V> {
    const entry = this.cache.get(key);
    if (!entry) return O.none;

    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      return O.none;
    }

    return O.some(entry.value);
  }

  set(key: K, value: V, ttlMs: number): void {
    this.cache.set(key, {
      value,
      expiry: Date.now() + ttlMs
    });
  }
}

const cachedWithTTL = <K, E, A>(
  cache: TTLCache<K, A>,
  key: K,
  ttlMs: number
) => (fetch: TE.TaskEither<E, A>): TE.TaskEither<E, A> =>
  pipe(
    cache.get(key),
    O.fold(
      () =>
        pipe(
          fetch,
          TE.map(value => {
            cache.set(key, value, ttlMs);
            return value;
          })
        ),
      value => TE.right(value)
    )
  );
```

## Resource Management

Safely manage resources with bracket pattern.

### Basic Bracket

```typescript
const bracket = <R, E, A>(
  acquire: TE.TaskEither<E, R>,
  use: (r: R) => TE.TaskEither<E, A>,
  release: (r: R) => TE.TaskEither<E, void>
): TE.TaskEither<E, A> =>
  pipe(
    acquire,
    TE.flatMap(resource =>
      pipe(
        use(resource),
        TE.chainFirst(() => release(resource)),
        TE.orElse(error =>
          pipe(
            release(resource),
            TE.flatMap(() => TE.left(error))
          )
        )
      )
    )
  );
```

### File Operations

```typescript
import * as fs from 'fs/promises';

type FileHandle = { fd: number };

const openFile = (path: string): TE.TaskEither<Error, FileHandle> =>
  TE.tryCatch(
    async () => {
      const fd = await fs.open(path, 'r');
      return { fd: fd.fd };
    },
    e => new Error(`Failed to open file: ${e}`)
  );

const closeFile = (handle: FileHandle): TE.TaskEither<Error, void> =>
  TE.tryCatch(
    async () => {
      await fs.close(handle.fd);
    },
    e => new Error(`Failed to close file: ${e}`)
  );

const readFile = (handle: FileHandle): TE.TaskEither<Error, string> =>
  TE.tryCatch(
    async () => {
      const buffer = await fs.readFile(handle.fd);
      return buffer.toString();
    },
    e => new Error(`Failed to read file: ${e}`)
  );

const processFile = (path: string): TE.TaskEither<Error, string> =>
  bracket(
    openFile(path),
    readFile,
    closeFile
  );
```

### Database Connection Pool

```typescript
type Connection = { id: number };

class ConnectionPool {
  private available: Connection[] = [];
  private inUse: Set<number> = new Set();

  acquire(): TE.TaskEither<Error, Connection> {
    return TE.tryCatch(
      async () => {
        if (this.available.length === 0) {
          throw new Error('No connections available');
        }
        const conn = this.available.pop()!;
        this.inUse.add(conn.id);
        return conn;
      },
      e => new Error(`Failed to acquire connection: ${e}`)
    );
  }

  release(conn: Connection): TE.TaskEither<Error, void> {
    return TE.tryCatch(
      async () => {
        this.inUse.delete(conn.id);
        this.available.push(conn);
      },
      e => new Error(`Failed to release connection: ${e}`)
    );
  }
}

const withConnection = <A>(
  pool: ConnectionPool,
  use: (conn: Connection) => TE.TaskEither<Error, A>
): TE.TaskEither<Error, A> =>
  bracket(
    pool.acquire(),
    use,
    conn => pool.release(conn)
  );

// Usage
const pool = new ConnectionPool();

const queryUser = (id: number): TE.TaskEither<Error, User> =>
  withConnection(pool, conn =>
    TE.tryCatch(
      () => executeQuery(conn, `SELECT * FROM users WHERE id = ${id}`),
      e => new Error(`Query failed: ${e}`)
    )
  );
```

## Best Practices Summary

1. **Use TaskEither for async operations** - Most real-world code
2. **Apply progressive enhancement** - Start simple, add complexity as needed
3. **Prefer traverse over loops** - More declarative and type-safe
4. **Use Do notation** - Makes sequential operations readable
5. **Type errors explicitly** - Discriminated unions for error types
6. **Parallel when possible** - Use ApplicativePar for independent operations
7. **Cache strategically** - Avoid repeated expensive operations
8. **Handle errors properly** - Use retries, fallbacks, circuit breakers
9. **Manage resources safely** - Use bracket pattern
10. **Test with mock dependencies** - Use Reader/ReaderTaskEither for DI
