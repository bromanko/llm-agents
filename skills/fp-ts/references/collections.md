# Collection Operations

Reference for fp-ts Array and Record operations with effect handling.

## Array Operations

fp-ts provides powerful, type-safe array utilities.

### Safe Access

```typescript
import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import { pipe } from 'fp-ts/function';

// Safe head and tail
pipe([1, 2, 3], A.head); // Some(1)
pipe([], A.head);        // None
pipe([1, 2, 3], A.tail); // Some([2, 3])

// Safe lookup by index
pipe(
  [1, 2, 3],
  A.lookup(1)
); // Some(2)

pipe(
  [1, 2, 3],
  A.lookup(10)
); // None

// Safe last
pipe([1, 2, 3], A.last); // Some(3)
pipe([], A.last);        // None
```

### Filtering and Partitioning

```typescript
// filter
pipe(
  [1, 2, 3, 4, 5],
  A.filter(n => n % 2 === 0)
); // [2, 4]

// partition - split into two arrays
pipe(
  [1, 2, 3, 4, 5],
  A.partition(n => n % 2 === 0)
); // { left: [1, 3, 5], right: [2, 4] }

// filterMap - filter and transform in one pass
pipe(
  ['1', 'foo', '2', 'bar', '3'],
  A.filterMap(s => {
    const n = parseInt(s);
    return isNaN(n) ? O.none : O.some(n);
  })
); // [1, 2, 3]

// compact - remove None values
pipe(
  [O.some(1), O.none, O.some(2), O.none, O.some(3)],
  A.compact
); // [1, 2, 3]

// separate - split Either array
pipe(
  [E.right(1), E.left('a'), E.right(2), E.left('b')],
  A.separate
); // { left: ['a', 'b'], right: [1, 2] }
```

### Transformation

```typescript
// map
pipe(
  [1, 2, 3],
  A.map(n => n * 2)
); // [2, 4, 6]

// flatMap (chain)
pipe(
  [1, 2, 3],
  A.flatMap(n => [n, n * 2])
); // [1, 2, 2, 4, 3, 6]

// mapWithIndex
pipe(
  ['a', 'b', 'c'],
  A.mapWithIndex((i, s) => `${i}:${s}`)
); // ['0:a', '1:b', '2:c']

// reduce
pipe(
  [1, 2, 3, 4, 5],
  A.reduce(0, (acc, n) => acc + n)
); // 15

// reduceRight
pipe(
  [1, 2, 3],
  A.reduceRight([], (n, acc) => [n, ...acc])
); // [3, 2, 1]
```

### Search and Query

```typescript
// findFirst and findLast
pipe(
  [1, 2, 3, 4, 5],
  A.findFirst(n => n > 3)
); // Some(4)

pipe(
  [1, 2, 3, 4, 5],
  A.findLast(n => n > 3)
); // Some(5)

// findIndex
pipe(
  [1, 2, 3, 4, 5],
  A.findIndex(n => n > 3)
); // Some(3)

// elem - check if element exists
import * as Eq from 'fp-ts/Eq';

pipe(
  [1, 2, 3],
  A.elem(Eq.eqNumber)(2)
); // true

// some and every
pipe(
  [1, 2, 3],
  A.some(n => n > 2)
); // true

pipe(
  [1, 2, 3],
  A.every(n => n > 0)
); // true
```

### Unique and Sorting

```typescript
import * as Ord from 'fp-ts/Ord';

// uniq - remove duplicates
pipe(
  [1, 2, 2, 3, 3, 3, 4],
  A.uniq(Eq.eqNumber)
); // [1, 2, 3, 4]

// sort
pipe(
  [3, 1, 4, 1, 5],
  A.sort(Ord.ordNumber)
); // [1, 1, 3, 4, 5]

// sortBy - sort by multiple fields
type Person = { name: string; age: number };

const byName = pipe(
  Ord.ordString,
  Ord.contramap((p: Person) => p.name)
);

const byAge = pipe(
  Ord.ordNumber,
  Ord.contramap((p: Person) => p.age)
);

pipe(
  people,
  A.sortBy([byAge, byName])
);
```

### Grouping and Combining

```typescript
// groupBy
pipe(
  ['foo', 'bar', 'baz', 'qux'],
  A.groupBy(s => s[0])
); // { f: ['foo'], b: ['bar', 'baz'], q: ['qux'] }

// zip
pipe(
  A.zip([1, 2, 3], ['a', 'b', 'c'])
); // [[1, 'a'], [2, 'b'], [3, 'c']]

// chunksOf
pipe(
  [1, 2, 3, 4, 5, 6, 7],
  A.chunksOf(3)
); // [[1, 2, 3], [4, 5, 6], [7]]

// splitAt
pipe(
  [1, 2, 3, 4, 5],
  A.splitAt(2)
); // [[1, 2], [3, 4, 5]]

// append and prepend
pipe(
  [2, 3],
  A.prepend(1),
  A.append(4)
); // [1, 2, 3, 4]
```

### Traversing with Effects

The most powerful feature of fp-ts arrays is effect traversal.

```typescript
// Traverse with Option
const parseNumbers = (strs: string[]): O.Option<number[]> =>
  pipe(
    strs,
    A.traverse(O.Applicative)(s => {
      const n = parseInt(s);
      return isNaN(n) ? O.none : O.some(n);
    })
  );

parseNumbers(['1', '2', '3']); // Some([1, 2, 3])
parseNumbers(['1', 'foo', '3']); // None

// Traverse with Either
const validateAll = (
  users: UnvalidatedUser[]
): E.Either<string, User[]> =>
  pipe(
    users,
    A.traverse(E.Applicative)(validateUser)
  );

// Traverse with TaskEither (parallel)
const fetchAllUsers = (ids: number[]): TE.TaskEither<Error, User[]> =>
  pipe(
    ids,
    A.traverse(TE.ApplicativePar)(fetchUser)
  );

// Traverse with TaskEither (sequential)
const fetchAllUsersSeq = (ids: number[]): TE.TaskEither<Error, User[]> =>
  pipe(
    ids,
    A.traverse(TE.ApplicativeSeq)(fetchUser)
  );

// sequence - convert array of effects to effect of array
const options: O.Option<number>[] = [O.some(1), O.some(2), O.some(3)];

pipe(
  options,
  A.sequence(O.Applicative)
); // Some([1, 2, 3])

pipe(
  [O.some(1), O.none, O.some(3)],
  A.sequence(O.Applicative)
); // None
```

### Advanced Array Patterns

```typescript
// Cartesian product
const product = <A, B>(as: A[], bs: B[]): Array<[A, B]> =>
  pipe(
    as,
    A.flatMap(a => pipe(bs, A.map(b => [a, b] as [A, B])))
  );

product([1, 2], ['a', 'b']); // [[1, 'a'], [1, 'b'], [2, 'a'], [2, 'b']]

// Take while predicate holds
pipe(
  [1, 2, 3, 4, 1, 2],
  A.takeLeftWhile(n => n < 4)
); // [1, 2, 3]

// Drop while predicate holds
pipe(
  [1, 2, 3, 4, 5],
  A.dropLeftWhile(n => n < 3)
); // [3, 4, 5]

// Span - split at first element that doesn't match
pipe(
  [1, 2, 3, 4, 1, 2],
  A.spanLeft(n => n < 4)
); // { init: [1, 2, 3], rest: [4, 1, 2] }
```

## Record Operations

Work with objects functionally.

### Basic Operations

```typescript
import * as R from 'fp-ts/Record';
import { pipe } from 'fp-ts/function';

// map - transform all values
pipe(
  { a: 1, b: 2, c: 3 },
  R.map(n => n * 2)
); // { a: 2, b: 4, c: 6 }

// mapWithIndex
pipe(
  { a: 1, b: 2, c: 3 },
  R.mapWithIndex((k, v) => `${k}:${v}`)
); // { a: 'a:1', b: 'b:2', c: 'c:3' }

// filter
pipe(
  { a: 1, b: 2, c: 3 },
  R.filter(n => n > 1)
); // { b: 2, c: 3 }

// filterMap
pipe(
  { a: '1', b: 'foo', c: '2' },
  R.filterMap(s => {
    const n = parseInt(s);
    return isNaN(n) ? O.none : O.some(n);
  })
); // { a: 1, c: 2 }

// partition
pipe(
  { a: 1, b: 2, c: 3, d: 4 },
  R.partition(n => n % 2 === 0)
); // { left: { a: 1, c: 3 }, right: { b: 2, d: 4 } }
```

### Access and Query

```typescript
// lookup - safe property access
pipe(
  { a: 1, b: 2 },
  R.lookup('a')
); // Some(1)

pipe(
  { a: 1, b: 2 },
  R.lookup('c')
); // None

// has - check key existence
pipe(
  { a: 1, b: 2 },
  R.has('c')
); // false

// elem - check value existence
pipe(
  { a: 1, b: 2, c: 3 },
  R.elem(Eq.eqNumber)(2)
); // true

// size
R.size({ a: 1, b: 2, c: 3 }); // 3

// isEmpty
R.isEmpty({}); // true
```

### Keys and Values

```typescript
// keys
R.keys({ a: 1, b: 2, c: 3 }); // ['a', 'b', 'c']

// collect - map to array
pipe(
  { a: 1, b: 2, c: 3 },
  R.collect((k, v) => [k, v])
); // [['a', 1], ['b', 2], ['c', 3]]

// toArray
R.toArray({ a: 1, b: 2 }); // [['a', 1], ['b', 2]]

// reduce
pipe(
  { a: 1, b: 2, c: 3 },
  R.reduce(0, (acc, n) => acc + n)
); // 6

// reduceWithIndex
pipe(
  { a: 1, b: 2, c: 3 },
  R.reduceWithIndex('', (k, acc, v) => `${acc}${k}:${v},`)
); // 'a:1,b:2,c:3,'
```

### Construction

```typescript
// fromFoldable - create from iterable
import * as A from 'fp-ts/Array';

pipe(
  [['a', 1], ['b', 2], ['c', 3]],
  R.fromFoldable(
    { concat: (x, y) => y }, // last value wins
    A.Foldable
  )
); // { a: 1, b: 2, c: 3 }

// fromFoldableMap
pipe(
  ['apple', 'banana', 'apricot'],
  R.fromFoldableMap(
    { concat: (x, y) => y },
    A.Foldable
  )(s => [s[0], s])
); // { a: 'apricot', b: 'banana' }

// upsertAt
pipe(
  { a: 1, b: 2 },
  R.upsertAt('c', 3)
); // { a: 1, b: 2, c: 3 }

// deleteAt
pipe(
  { a: 1, b: 2, c: 3 },
  R.deleteAt('b')
); // { a: 1, c: 3 }

// modifyAt
pipe(
  { a: 1, b: 2, c: 3 },
  R.modifyAt('b', n => n * 10)
); // Some({ a: 1, b: 20, c: 3 })
```

### Traversing with Effects

```typescript
// traverse with Either
const validateRecord = (
  record: Record<string, string>
): E.Either<string, Record<string, number>> =>
  pipe(
    record,
    R.traverse(E.Applicative)(s => {
      const n = parseInt(s);
      return isNaN(n)
        ? E.left(`Invalid number: ${s}`)
        : E.right(n);
    })
  );

validateRecord({ a: '1', b: '2' }); // Right({ a: 1, b: 2 })
validateRecord({ a: '1', b: 'foo' }); // Left('Invalid number: foo')

// traverse with TaskEither
const fetchRecord = (
  ids: Record<string, number>
): TE.TaskEither<Error, Record<string, User>> =>
  pipe(
    ids,
    R.traverse(TE.ApplicativePar)(fetchUser)
  );

// sequence
const records: Record<string, O.Option<number>> = {
  a: O.some(1),
  b: O.some(2),
  c: O.some(3)
};

pipe(
  records,
  R.sequence(O.Applicative)
); // Some({ a: 1, b: 2, c: 3 })

pipe(
  { a: O.some(1), b: O.none, c: O.some(3) },
  R.sequence(O.Applicative)
); // None
```

### Combining Records

```typescript
// union
import * as Eq from 'fp-ts/Eq';

const union = <A>(eq: Eq.Eq<A>) => (
  first: Record<string, A>,
  second: Record<string, A>
): Record<string, A> => ({
  ...first,
  ...second
});

// intersection
const intersection = <A>(eq: Eq.Eq<A>) => (
  first: Record<string, A>,
  second: Record<string, A>
): Record<string, A> =>
  pipe(
    first,
    R.filterWithIndex((k, a) =>
      pipe(
        second,
        R.lookup(k),
        O.exists(b => eq.equals(a, b))
      )
    )
  );

// difference
const difference = <A>() => (
  first: Record<string, A>,
  second: Record<string, A>
): Record<string, A> =>
  pipe(
    first,
    R.filterWithIndex((k, _) => !R.has(k)(second))
  );
```

## Type Classes for Collections

### Eq - Equality

```typescript
import * as Eq from 'fp-ts/Eq';

// Array equality
const eqArray = A.getEq(Eq.eqNumber);
eqArray.equals([1, 2, 3], [1, 2, 3]); // true

// Record equality
const eqRecord = R.getEq(Eq.eqNumber);
eqRecord.equals({ a: 1, b: 2 }, { a: 1, b: 2 }); // true
```

### Ord - Ordering

```typescript
import * as Ord from 'fp-ts/Ord';

// Sort array of arrays
const ordArray = A.getOrd(Ord.ordNumber);
pipe(
  [[3, 1], [1, 2], [2, 1]],
  A.sort(ordArray)
); // [[1, 2], [2, 1], [3, 1]]
```

### Semigroup - Combining

```typescript
import * as S from 'fp-ts/Semigroup';

// Concatenate arrays
const semigroupArray = A.getSemigroup<number>();
S.concatAll(semigroupArray)([])([[1, 2], [3, 4], [5]]);
// [1, 2, 3, 4, 5]

// Merge records (last wins)
const semigroupRecord = R.getSemigroup(S.last<number>());
semigroupRecord.concat({ a: 1, b: 2 }, { b: 3, c: 4 });
// { a: 1, b: 3, c: 4 }
```

## Performance Tips

1. **Use filterMap** instead of separate filter + map
2. **Use traverse** for effectful operations instead of map + sequence
3. **Use ApplicativePar** for parallel TaskEither operations
4. **Avoid unnecessary conversions** between Array and Record
5. **Use type classes** (Eq, Ord) for generic operations
