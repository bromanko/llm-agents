# Advanced fp-ts Types

Reference for Reader, ReaderTaskEither, State, and IO monads for dependency injection, state management, and side effects.

## Reader Monad

Thread configuration/dependencies through computations.

### Basic Usage

```typescript
import * as R from 'fp-ts/Reader';
import { pipe } from 'fp-ts/function';

type Config = {
  apiUrl: string;
  timeout: number;
};

// Create Reader
const getApiUrl: R.Reader<Config, string> =
  config => config.apiUrl;

const getTimeout: R.Reader<Config, number> =
  config => config.timeout;

// map
const getFullUrl = (path: string): R.Reader<Config, string> =>
  pipe(
    getApiUrl,
    R.map(url => `${url}${path}`)
  );

// flatMap (chain)
const fetchWithTimeout = (path: string): R.Reader<Config, Promise<Response>> =>
  pipe(
    R.Do,
    R.bind('url', () => getFullUrl(path)),
    R.bind('timeout', () => getTimeout),
    R.map(({ url, timeout }) =>
      fetch(url, { signal: AbortSignal.timeout(timeout) })
    )
  );

// ask - get the environment
const logConfig: R.Reader<Config, void> =
  pipe(
    R.ask<Config>(),
    R.map(config => console.log(config))
  );

// local - modify environment locally
const withDifferentUrl = <A>(
  reader: R.Reader<Config, A>
): R.Reader<Config, A> =>
  pipe(
    reader,
    R.local((config: Config) => ({
      ...config,
      apiUrl: 'https://api-v2.example.com'
    }))
  );

// Execute Reader
const config: Config = {
  apiUrl: 'https://api.example.com',
  timeout: 5000
};

const result = fetchWithTimeout('/users')(config);
```

### Common Patterns

```typescript
// Compose multiple Readers
const getUserEndpoint = (id: number): R.Reader<Config, string> =>
  pipe(
    getFullUrl(`/users/${id}`),
    R.map(url => url)
  );

// Chain Reader operations
const makeRequest = (endpoint: string): R.Reader<Config, Promise<Response>> =>
  pipe(
    R.Do,
    R.bind('url', () => getFullUrl(endpoint)),
    R.bind('timeout', () => getTimeout),
    R.map(({ url, timeout }) =>
      fetch(url, { signal: AbortSignal.timeout(timeout) })
    )
  );
```

## ReaderTaskEither

Combine Reader, Task, and Either for dependency injection with async error handling.

### Basic Usage

```typescript
import * as RTE from 'fp-ts/ReaderTaskEither';
import { pipe } from 'fp-ts/function';

type Deps = {
  db: Database;
  logger: Logger;
  config: Config;
};

// Create RTE
const getUser = (id: number): RTE.ReaderTaskEither<Deps, Error, User> =>
  pipe(
    RTE.ask<Deps>(),
    RTE.flatMap(({ db, logger }) =>
      RTE.tryCatch(
        async () => {
          logger.info(`Fetching user ${id}`);
          return db.users.findById(id);
        },
        reason => new Error(`Failed to fetch user: ${reason}`)
      )
    )
  );

// Compose operations
const getUserWithPosts = (
  id: number
): RTE.ReaderTaskEither<Deps, Error, UserWithPosts> =>
  pipe(
    RTE.Do,
    RTE.bind('user', () => getUser(id)),
    RTE.bind('posts', ({ user }) => getPosts(user.id)),
    RTE.map(({ user, posts }) => ({ ...user, posts }))
  );

// Execute
const deps: Deps = {
  db: createDatabase(),
  logger: createLogger(),
  config: loadConfig()
};

getUserWithPosts(1)(deps)()
  .then(E.fold(
    error => console.error(error),
    user => console.log(user)
  ));

// local - modify dependencies
const withTestDb = <A>(
  rte: RTE.ReaderTaskEither<Deps, Error, A>
): RTE.ReaderTaskEither<Deps, Error, A> =>
  pipe(
    rte,
    RTE.local((deps: Deps) => ({
      ...deps,
      db: createTestDatabase()
    }))
  );
```

### Dependency Injection Pattern

```typescript
type Services = {
  userRepo: UserRepository;
  emailService: EmailService;
  logger: Logger;
};

class UserService {
  getUser(id: number): RTE.ReaderTaskEither<Services, Error, User> {
    return pipe(
      RTE.ask<Services>(),
      RTE.flatMap(({ userRepo, logger }) =>
        RTE.tryCatch(
          async () => {
            logger.info(`Fetching user ${id}`);
            return userRepo.findById(id);
          },
          e => new Error(`Failed: ${e}`)
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
          e => new Error(`Failed: ${e}`)
        )
      ),
      RTE.chainFirst(({ services, user }) =>
        RTE.fromTask(() =>
          services.emailService.sendWelcome(user.email)
        )
      ),
      RTE.map(({ user }) => user)
    );
  }
}

// Usage
const services: Services = {
  userRepo: new UserRepository(),
  emailService: new EmailService(),
  logger: new Logger()
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
const prodDeps: Deps = {
  db: createDatabase(),
  logger: createLogger(),
  config: loadConfig()
};

// Test dependencies
const testDeps: Deps = {
  db: createMockDatabase(),
  logger: createMockLogger(),
  config: createTestConfig()
};

// Same code, different dependencies
getUserWithPosts(1)(testDeps)(); // Uses test dependencies
getUserWithPosts(1)(prodDeps)(); // Uses production dependencies
```

## State Monad

Thread state through computations.

### Basic Usage

```typescript
import * as S from 'fp-ts/State';
import { pipe } from 'fp-ts/function';

type Counter = { count: number };

// Create State
const increment: S.State<Counter, number> =
  state => [state.count + 1, { count: state.count + 1 }];

const decrement: S.State<Counter, number> =
  state => [state.count - 1, { count: state.count - 1 }];

// get and put
const getCount: S.State<Counter, number> =
  state => [state.count, state];

const setCount = (count: number): S.State<Counter, void> =>
  _state => [undefined, { count }];

// modify
const multiplyCount = (factor: number): S.State<Counter, void> =>
  S.modify((state: Counter) => ({ count: state.count * factor }));

// Compose operations
const complexOperation: S.State<Counter, string> =
  pipe(
    S.Do,
    S.bind('initial', () => getCount),
    S.bind('after1', () => increment),
    S.bind('after2', () => increment),
    S.bind('multiplied', () => {
      multiplyCount(2);
      return getCount;
    }),
    S.map(({ initial, after1, after2, multiplied }) =>
      `${initial} -> ${after1} -> ${after2} -> ${multiplied}`
    )
  );

// Execute State
const initialState: Counter = { count: 0 };
const [result, finalState] = complexOperation(initialState);
```

### Practical State Examples

```typescript
// Stack implementation
type Stack<A> = { items: A[] };

const push = <A>(item: A): S.State<Stack<A>, void> =>
  S.modify(stack => ({ items: [...stack.items, item] }));

const pop = <A>(): S.State<Stack<A>, O.Option<A>> =>
  state => {
    const items = state.items;
    if (items.length === 0) {
      return [O.none, state];
    }
    return [O.some(items[items.length - 1]), { items: items.slice(0, -1) }];
  };

const peek = <A>(): S.State<Stack<A>, O.Option<A>> =>
  state => [pipe(state.items, A.last), state];

// Use the stack
const stackProgram: S.State<Stack<number>, O.Option<number>> =
  pipe(
    S.Do,
    S.chainFirst(() => push(1)),
    S.chainFirst(() => push(2)),
    S.chainFirst(() => push(3)),
    S.flatMap(() => pop())
  );

const result = stackProgram({ items: [] });
// result: [Some(3), { items: [1, 2] }]
```

### State Machine Pattern

```typescript
type TrafficLight = 'Red' | 'Yellow' | 'Green';

type TrafficState = {
  current: TrafficLight;
  history: TrafficLight[];
};

const transition: S.State<TrafficState, TrafficLight> =
  state => {
    const next = state.current === 'Red' ? 'Green'
                : state.current === 'Green' ? 'Yellow'
                : 'Red';
    return [next, {
      current: next,
      history: [...state.history, state.current]
    }];
  };

const runCycle = (times: number): S.State<TrafficState, TrafficLight[]> =>
  pipe(
    A.replicate(times, transition),
    A.sequence(S.Applicative)
  );
```

## IO Monad

Encapsulate side effects.

### Basic Usage

```typescript
import * as IO from 'fp-ts/IO';
import { pipe } from 'fp-ts/function';

// Create IO
const log = (message: string): IO.IO<void> =>
  () => console.log(message);

const random: IO.IO<number> =
  () => Math.random();

const now: IO.IO<Date> =
  () => new Date();

// map
pipe(
  random,
  IO.map(n => n * 100)
); // IO<number>

// flatMap (chain)
pipe(
  random,
  IO.flatMap(n => log(`Random: ${n}`))
); // IO<void>

// Do notation
const program: IO.IO<string> =
  pipe(
    IO.Do,
    IO.bind('time', () => now),
    IO.bind('rand', () => random),
    IO.chainFirst(({ time }) => log(`Time: ${time}`)),
    IO.map(({ time, rand }) => `${time}: ${rand}`)
  );

// Execute at program boundary
program();
```

### Practical IO Examples

```typescript
// Read environment variable
const getEnv = (key: string): IO.IO<O.Option<string>> =>
  () => O.fromNullable(process.env[key]);

// Write to console with timestamp
const logWithTime = (message: string): IO.IO<void> =>
  pipe(
    now,
    IO.flatMap(time =>
      log(`[${time.toISOString()}] ${message}`)
    )
  );

// Generate unique ID
const generateId: IO.IO<string> =
  pipe(
    now,
    IO.flatMap(time =>
      pipe(
        random,
        IO.map(rand => `${time.getTime()}-${rand}`)
      )
    )
  );

// Compose IO operations
const setupApplication: IO.IO<void> =
  pipe(
    IO.Do,
    IO.chainFirst(() => logWithTime('Starting application')),
    IO.bind('id', () => generateId),
    IO.chainFirst(({ id }) => logWithTime(`App ID: ${id}`)),
    IO.chainFirst(() => logWithTime('Application ready'))
  );

// Execute
setupApplication();
```

### IO with Error Handling (IOEither)

```typescript
import * as IOE from 'fp-ts/IOEither';

// Wrap IO operations that can fail
const readEnvRequired = (key: string): IOE.IOEither<Error, string> =>
  pipe(
    getEnv(key),
    IOE.fromIO,
    IOE.flatMap(opt =>
      pipe(
        opt,
        E.fromOption(() => new Error(`Missing env var: ${key}`)),
        IOE.fromEither
      )
    )
  );

// Use it
const loadConfig: IOE.IOEither<Error, Config> =
  pipe(
    IOE.Do,
    IOE.bind('apiUrl', () => readEnvRequired('API_URL')),
    IOE.bind('port', () => readEnvRequired('PORT')),
    IOE.map(({ apiUrl, port }) => ({
      apiUrl,
      port: parseInt(port)
    }))
  );

// Execute and handle errors
pipe(
  loadConfig(),
  E.fold(
    error => console.error('Config error:', error),
    config => console.log('Config loaded:', config)
  )
);
```

## Choosing the Right Type

### Use Reader When:
- Threading configuration through pure computations
- Need to swap implementations (testing)
- Dependency injection without effects

### Use ReaderTaskEither When:
- Async operations with dependencies
- Application services layer
- Testing with mock dependencies
- Most real-world service implementations

### Use State When:
- Threading state through pure computations
- Implementing state machines
- Functional approach to mutable state

### Use IO When:
- Encapsulating simple side effects
- Delaying execution
- Keeping effects at program boundaries
- When you need lazy evaluation of side effects

### Use IOEither When:
- IO operations that can fail
- Need error handling with side effects
- Reading configuration that might be invalid
