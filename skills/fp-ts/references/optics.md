# Optics (Lenses, Prisms, Traversals)

Reference for monocle-ts optics for immutable nested data access and modification.

## Installation

```bash
npm install monocle-ts
```

Optics require monocle-ts, which builds on fp-ts.

## Lens - Focus on a Field

A Lens focuses on a field within a structure, allowing you to get and set immutably.

### Basic Lens Usage

```typescript
import { pipe } from 'fp-ts/function';
import { Lens } from 'monocle-ts';

type Address = {
  street: string;
  city: string;
  zipCode: string;
};

type Person = {
  name: string;
  age: number;
  address: Address;
};

// Create lenses
const addressLens = Lens.fromProp<Person>()('address');
const cityLens = Lens.fromProp<Address>()('city');

// Compose lenses
const personCityLens = pipe(addressLens, Lens.compose(cityLens));

const person: Person = {
  name: 'John',
  age: 30,
  address: { street: '123 Main', city: 'NYC', zipCode: '10001' }
};

// Get
personCityLens.get(person); // 'NYC'

// Set
const updated = personCityLens.set('LA')(person);
// { ..., address: { ..., city: 'LA' } }

// Modify
const capitalized = personCityLens.modify(city => city.toUpperCase())(person);
// { ..., address: { ..., city: 'NYC' } } -> city becomes 'NYC'
```

### Lens Composition

```typescript
type Company = {
  name: string;
  ceo: Person;
};

const ceoLens = Lens.fromProp<Company>()('ceo');
const ceoAddressLens = pipe(ceoLens, Lens.compose(addressLens));
const ceoCityLens = pipe(ceoAddressLens, Lens.compose(cityLens));

const company: Company = {
  name: 'Acme Corp',
  ceo: person
};

// Deep get
ceoCityLens.get(company); // 'NYC'

// Deep set
const relocated = ceoCityLens.set('SF')(company);
```

### Lens Laws

Lenses must satisfy three laws:

```typescript
// 1. Get-Put: Setting what you get changes nothing
const value = lens.get(obj);
lens.set(value)(obj) === obj;

// 2. Put-Get: You get what you set
const newValue = 'new';
lens.get(lens.set(newValue)(obj)) === newValue;

// 3. Put-Put: Last set wins
lens.set(value2)(lens.set(value1)(obj)) === lens.set(value2)(obj);
```

## Optional - For Nullable Fields

An Optional is like a Lens for fields that might not exist.

### Basic Optional Usage

```typescript
import { Optional } from 'monocle-ts';
import * as O from 'fp-ts/Option';

type User = {
  name: string;
  email?: string;
};

const emailOptional = Optional.fromNullableProp<User>()('email');

const user: User = { name: 'John', email: 'john@example.com' };
const userNoEmail: User = { name: 'Jane' };

// Get as Option
emailOptional.getOption(user); // Some('john@example.com')
emailOptional.getOption(userNoEmail); // None

// Set
emailOptional.set('new@example.com')(user);
// { name: 'John', email: 'new@example.com' }

emailOptional.set('new@example.com')(userNoEmail);
// { name: 'Jane', email: 'new@example.com' }

// Modify only if present
emailOptional.modify(email => email.toUpperCase())(user);
// { name: 'John', email: 'JOHN@EXAMPLE.COM' }

emailOptional.modify(email => email.toUpperCase())(userNoEmail);
// { name: 'Jane' } - unchanged
```

### Optional Composition

```typescript
type Profile = {
  bio?: string;
};

type UserWithProfile = {
  name: string;
  profile?: Profile;
};

const profileOptional = Optional.fromNullableProp<UserWithProfile>()('profile');
const bioOptional = Optional.fromNullableProp<Profile>()('bio');

const userBioOptional = pipe(
  profileOptional,
  Optional.compose(bioOptional)
);

const user: UserWithProfile = {
  name: 'John',
  profile: { bio: 'Software developer' }
};

userBioOptional.getOption(user); // Some('Software developer')
userBioOptional.modify(bio => bio.toUpperCase())(user);
```

## Prism - For Sum Types

A Prism focuses on one variant of a sum type.

### Basic Prism Usage

```typescript
import { Prism } from 'monocle-ts';

type Shape =
  | { type: 'circle'; radius: number }
  | { type: 'rectangle'; width: number; height: number };

const circlePrism = Prism.fromPredicate(
  (s: Shape): s is Extract<Shape, { type: 'circle' }> =>
    s.type === 'circle'
);

const rectanglePrism = Prism.fromPredicate(
  (s: Shape): s is Extract<Shape, { type: 'rectangle' }> =>
    s.type === 'rectangle'
);

const circle: Shape = { type: 'circle', radius: 5 };
const rect: Shape = { type: 'rectangle', width: 10, height: 20 };

// Get as Option
circlePrism.getOption(circle); // Some({ type: 'circle', radius: 5 })
circlePrism.getOption(rect);   // None

// Modify
circlePrism.modify(c => ({ ...c, radius: c.radius * 2 }))(circle);
// { type: 'circle', radius: 10 }

circlePrism.modify(c => ({ ...c, radius: c.radius * 2 }))(rect);
// { type: 'rectangle', width: 10, height: 20 } - unchanged
```

### Prism with Either

```typescript
import * as E from 'fp-ts/Either';

type Result = E.Either<string, number>;

const rightPrism = Prism.fromPredicate(E.isRight);
const leftPrism = Prism.fromPredicate(E.isLeft);

const success: Result = E.right(42);
const failure: Result = E.left('error');

rightPrism.getOption(success); // Some(Right(42))
rightPrism.modify(e => E.right((e as any).right * 2))(success);
```

## Traversal - For Collections

A Traversal allows you to focus on multiple elements.

### Basic Traversal Usage

```typescript
import { Traversal } from 'monocle-ts';
import * as A from 'fp-ts/Array';
import { pipe } from 'fp-ts/function';

const arrayTraversal = <A>() => Traversal.fromTraversable(A.Traversable)<A>();

const numbers = [1, 2, 3, 4, 5];

// Modify all elements
pipe(
  numbers,
  arrayTraversal<number>().modify(n => n * 2)
); // [2, 4, 6, 8, 10]

// Compose with lens to modify nested arrays
type Todo = { id: number; title: string; completed: boolean };
type TodoList = { name: string; todos: Todo[] };

const todosLens = Lens.fromProp<TodoList>()('todos');
const todosTraversal = pipe(
  todosLens,
  Lens.composeTraversal(arrayTraversal<Todo>())
);

const completedLens = Lens.fromProp<Todo>()('completed');
const allCompletedTraversal = pipe(
  todosTraversal,
  Traversal.composeLens(completedLens)
);

const todoList: TodoList = {
  name: 'My Todos',
  todos: [
    { id: 1, title: 'Task 1', completed: false },
    { id: 2, title: 'Task 2', completed: false }
  ]
};

// Mark all as completed
allCompletedTraversal.modify(() => true)(todoList);
```

## Iso - Isomorphism

An Iso represents a lossless conversion between two types.

### Basic Iso Usage

```typescript
import { Iso } from 'monocle-ts';

// Celsius <-> Fahrenheit
const celsiusToFahrenheit = (c: number) => (c * 9) / 5 + 32;
const fahrenheitToCelsius = (f: number) => ((f - 32) * 5) / 9;

const celsiusFahrenheitIso = new Iso(
  celsiusToFahrenheit,
  fahrenheitToCelsius
);

celsiusFahrenheitIso.get(0);    // 32
celsiusFahrenheitIso.reverseGet(32); // 0

// String <-> Array of chars
const stringCharsIso = new Iso<string, string[]>(
  s => s.split(''),
  chars => chars.join('')
);

stringCharsIso.get('hello'); // ['h', 'e', 'l', 'l', 'o']
stringCharsIso.reverseGet(['h', 'i']); // 'hi'
```

## Practical Patterns

### Deep Updates in Redux/State Management

```typescript
import { Lens } from 'monocle-ts';
import { pipe } from 'fp-ts/function';

type AppState = {
  user: {
    profile: {
      name: string;
      email: string;
    };
    settings: {
      theme: 'light' | 'dark';
      notifications: boolean;
    };
  };
  data: {
    items: Array<{ id: number; value: string }>;
  };
};

// Define lenses
const userLens = Lens.fromProp<AppState>()('user');
const profileLens = Lens.fromProp<AppState['user']>()('profile');
const nameLens = Lens.fromProp<AppState['user']['profile']>()('name');

// Compose deeply
const userNameLens = pipe(
  userLens,
  Lens.compose(profileLens),
  Lens.compose(nameLens)
);

// Update deeply nested state immutably
const state: AppState = {
  user: {
    profile: { name: 'John', email: 'john@example.com' },
    settings: { theme: 'light', notifications: true }
  },
  data: { items: [] }
};

const newState = userNameLens.set('Jane')(state);
```

### Form Field Updates

```typescript
type FormData = {
  personal: {
    firstName: string;
    lastName: string;
  };
  contact: {
    email: string;
    phone: string;
  };
};

const personalLens = Lens.fromProp<FormData>()('personal');
const firstNameLens = Lens.fromProp<FormData['personal']>()('firstName');
const formFirstNameLens = pipe(personalLens, Lens.compose(firstNameLens));

// Use in React/form handlers
const updateFirstName = (name: string) => (form: FormData) =>
  formFirstNameLens.set(name)(form);
```

### Array Element Updates

```typescript
import { Lens, Optional } from 'monocle-ts';
import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';

// Focus on array element by index
const indexOptional = <A>(i: number): Optional<A[], A> =>
  new Optional(
    (arr) => pipe(arr, A.lookup(i)),
    (a) => (arr) =>
      pipe(
        arr,
        A.modifyAt(i, () => a),
        O.getOrElse(() => arr)
      )
  );

const numbers = [1, 2, 3, 4, 5];
const secondOptional = indexOptional<number>(1);

secondOptional.getOption(numbers); // Some(2)
secondOptional.set(20)(numbers);   // [1, 20, 3, 4, 5]
```

### Filtering Traversals

```typescript
// Traverse only elements matching predicate
const completedTodosTraversal = pipe(
  todosLens,
  Lens.composeTraversal(arrayTraversal<Todo>()),
  Traversal.filter((todo: Todo) => todo.completed)
);

// Modify only completed todos
completedTodosTraversal.modify(todo => ({
  ...todo,
  title: `[DONE] ${todo.title}`
}))(todoList);
```

## Combining Optics

### Lens + Optional

```typescript
type Config = {
  api: {
    endpoint?: string;
    timeout?: number;
  };
};

const apiLens = Lens.fromProp<Config>()('api');
const endpointOptional = Optional.fromNullableProp<Config['api']>()('endpoint');

const apiEndpointOptional = pipe(
  apiLens,
  Lens.composeOptional(endpointOptional)
);
```

### Prism + Lens

```typescript
type Result<E, A> = E.Either<E, A>;

const rightPrism = Prism.fromPredicate(E.isRight);

type Success = { value: number; timestamp: Date };

const valueLens = Lens.fromProp<Success>()('value');

// Focus on successful result's value
const successValueOptional = pipe(
  rightPrism,
  Prism.composeLens(valueLens)
);
```

## When to Use Optics

### Use Optics When:
- Deep state updates in Redux/state management
- Complex nested data transformations
- Working with optional/nullable nested fields
- Need type-safe immutable updates
- Updating elements in collections

### Avoid Optics When:
- Simple shallow updates (use spread operator)
- One-off transformations
- Performance-critical hot paths (optics add overhead)
- Team unfamiliar with functional programming concepts

## Best Practices

1. **Define lenses at module level** - Reuse across components
2. **Compose optics** - Build complex from simple
3. **Use type inference** - Let TypeScript infer types when possible
4. **Prefer Lens for required fields** - Use Optional for nullable
5. **Use Prism for sum types** - Better than type guards
6. **Combine with fp-ts** - Use with pipe for clean code
7. **Test lens laws** - Ensure correctness in complex optics

## Type Classes for Optics

```typescript
import * as Eq from 'fp-ts/Eq';
import * as Ord from 'fp-ts/Ord';
import * as S from 'fp-ts/Semigroup';

// Eq for structures
const eqPerson = Eq.struct<Person>({
  name: Eq.eqString,
  age: Eq.eqNumber,
  address: Eq.struct({
    street: Eq.eqString,
    city: Eq.eqString,
    zipCode: Eq.eqString
  })
});

// Ord for ordering
const ordPerson = pipe(
  Ord.ordNumber,
  Ord.contramap((p: Person) => p.age)
);

// Semigroup for combining
type User = { name: string; age: number };

const userSemigroup: S.Semigroup<User> = {
  concat: (x, y) => ({
    name: `${x.name} & ${y.name}`,
    age: Math.max(x.age, y.age)
  })
};
```
