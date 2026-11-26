import { Database } from "bun:sqlite";
import { expect, expectTypeOf, test } from "bun:test";

import { Effect, Schema } from "effect";
import { Statement } from "effect/sql";

import {
  add,
  and,
  avg,
  between,
  count,
  divide,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  max,
  min,
  multiply,
  neq,
  not,
  notInArray,
  or,
  raw,
  subtract,
  sum,
} from "../src/expression.ts";
import type { Expression, ExpressionReferences } from "../src/expression.ts";
import { compileSelect } from "../src/select-compiler.ts";
import { Table } from "../src/table.ts";

const entries = Table.fromSchema(
  "entries",
  Schema.Struct({
    amount: Schema.Int,
    label: Schema.String,
    notes: Schema.OptionFromNullOr(Schema.String),
  })
);

test("compares typed columns with SQL values and decodes projected predicates", () => {
  using db = new Database(":memory:");
  db.run("CREATE TABLE entries (amount INTEGER, label TEXT, notes TEXT)");
  db.run("INSERT INTO entries VALUES (8, 'A', NULL)");

  const matches = eq(entries.c.amount, 8);
  const nullable = eq(entries.c.notes, "test");

  const compiled = compileSelect(
    {
      kind: "select",
      from: { relation: { kind: "table", name: entries.identifier } },
      projections: [
        { alias: "matches", expression: matches.node },
        { alias: "nullable", expression: nullable.node },
      ],
    },
    "sqlite"
  );

  expect(compiled.params).toEqual([8, "test"]);

  const [first, second] = Schema.decodeUnknownSync(
    Schema.Tuple([Schema.Number, Schema.String])
  )(compiled.params);

  const row = db
    .query<{ matches: unknown; nullable: unknown }, [number, string]>(
      compiled.sql
    )
    .get(first, second);

  expect(Schema.decodeUnknownSync(matches.schema)(row?.matches)).toBe(true);
  expect(Schema.decodeUnknownSync(nullable.schema)(row?.nullable)).toBeNull();
  expectTypeOf<typeof matches.schema.Type>().toEqualTypeOf<boolean>();
  expectTypeOf<typeof nullable.schema.Type>().toEqualTypeOf<boolean | null>();
});

const sql = Statement.make(
  Effect.die("Offline SQL constructor"),
  Statement.makeCompilerSqlite(),
  [],
  undefined
);

const makeFixture = (db: Database) => {
  db.run("CREATE TABLE entries (amount INTEGER, label TEXT, notes TEXT)");
  db.run("INSERT INTO entries VALUES (8, 'A', NULL)");
};

type TestExpression = Expression<Schema.ConstraintDecoder<unknown>>;

const selectExpressions = (
  db: Database,
  [first, ...rest]: readonly [
    readonly [string, TestExpression],
    ...(readonly [string, TestExpression])[],
  ]
) => {
  const projection = ([alias, expression]: readonly [
    string,
    TestExpression,
  ]) => ({
    alias,
    expression: expression.node,
  });

  const compiled = compileSelect(
    {
      kind: "select",
      from: { relation: { kind: "table", name: entries.identifier } },
      projections: [projection(first), ...rest.map(projection)],
    },
    "sqlite"
  );

  const params = Schema.decodeUnknownSync(
    Schema.Array(Schema.Union([Schema.Number, Schema.String]))
  )(compiled.params);

  const row = db
    .query<Record<string, number | string | null>, (number | string)[]>(
      compiled.sql
    )
    .get(...params);

  return Object.fromEntries(
    [first, ...rest].map(([key, expression]) => [
      key,
      Schema.decodeUnknownSync(expression.schema)(row?.[key]),
    ])
  );
};

test("evaluates predicate operators and preserves raw fragment precedence", () => {
  using db = new Database(":memory:");
  makeFixture(db);

  const { amount, label, notes } = entries.c;
  const match = eq(amount, 8);
  const different = neq(label, "A");
  const grouped = raw(Schema.BooleanFromBit, sql`1 = ${1} OR 1 = ${0}`);
  const falseSql = sql`${0} = 1`;

  const result = selectExpressions(db, [
    ["and", and(match, different)],
    ["between", between(amount, 7, 9)],
    ["greater", gt(amount, 8)],
    ["greaterOrEqual", gte(amount, 8)],
    ["in", inArray(amount, [4, 8])],
    ["inEmpty", inArray(amount, [])],
    ["isNotNull", isNotNull(notes)],
    ["isNull", isNull(notes)],
    ["less", lt(amount, 8)],
    ["lessOrEqual", lte(amount, 8)],
    ["like", like(label, "A%")],
    ["not", not(match)],
    ["notIn", notInArray(amount, [2, 8])],
    ["notInEmpty", notInArray(amount, [])],
    ["or", or(match, different)],
    ["raw", and(grouped, falseSql)],
  ]);

  expect(result).toEqual({
    and: false,
    between: true,
    greater: false,
    greaterOrEqual: true,
    in: true,
    inEmpty: false,
    isNotNull: false,
    isNull: true,
    less: false,
    lessOrEqual: true,
    like: true,
    not: false,
    notIn: false,
    notInEmpty: true,
    or: true,
    raw: false,
  });
});

test("executes arithmetic and aggregate expressions with SQL null behavior", () => {
  using db = new Database(":memory:");
  makeFixture(db);

  const { amount, label } = entries.c;
  expect(
    selectExpressions(db, [
      ["add", add(amount, 1)],
      ["divide", divide(amount, 2)],
      ["divisionByZero", divide(amount, 0)],
      ["multiply", multiply(amount, 2)],
      ["subtract", subtract(amount, 1)],
    ])
  ).toEqual({
    add: 9,
    divide: 4,
    divisionByZero: null,
    multiply: 16,
    subtract: 7,
  });

  db.run("INSERT INTO entries VALUES (12, 'B', NULL), (8, 'B', NULL)");

  const aggregates = [
    ["avg", avg(amount)],
    ["count", count()],
    ["distinct", count(amount, { distinct: true })],
    ["max", max(label)],
    ["min", min(label)],
    ["sum", sum(amount)],
  ] as const;

  expect(selectExpressions(db, aggregates)).toEqual({
    avg: 28 / 3,
    count: 3,
    distinct: 2,
    max: "B",
    min: "A",
    sum: 28,
  });

  db.run("DELETE FROM entries");
  expect(selectExpressions(db, aggregates)).toEqual({
    avg: null,
    count: 0,
    distinct: 0,
    max: null,
    min: null,
    sum: null,
  });

  const decodeCount = Schema.decodeUnknownSync(count().schema);
  expect(decodeCount("3")).toBe(3);
  expect(decodeCount(3n)).toBe(3);
  expect(() => decodeCount("9007199254740992")).toThrow();
});

test("preserves referenced column identities and rejects incompatible operands", () => {
  const other = Table.fromSchema(
    "other",
    Schema.Struct({ amount: Schema.Int })
  );

  const { amount, label, notes } = entries.c;
  const comparison = eq(add(amount, other.c.amount), 9);
  const compound = and(comparison, inArray(label, [notes, "A"]));

  expect(compound.references).toEqual([amount, other.c.amount, label, notes]);
  expectTypeOf<ExpressionReferences<typeof compound>>().toEqualTypeOf<
    typeof amount | typeof other.c.amount | typeof label | typeof notes
  >();

  expectTypeOf<Parameters<typeof eq<typeof amount, string>>[1]>().toBeNever();
  expectTypeOf<
    Parameters<typeof eq<typeof label, typeof amount>>[1]
  >().toBeNever();
  expectTypeOf<
    Parameters<typeof between<typeof amount, number, string>>[2]
  >().toBeNever();
  expectTypeOf<Parameters<typeof sum<typeof label>>[0]>().toBeNever();
  expectTypeOf<Parameters<typeof like<typeof amount, string>>[0]>().toBeNever();
});
