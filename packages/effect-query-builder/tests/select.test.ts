import { Database } from "bun:sqlite";
import { expect, expectTypeOf, test } from "bun:test";

import { Cause, Effect, Option, Schema, Stream } from "effect";
import { map } from "effect/Effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError, Statement } from "effect/sql";
import type { SqlConnection } from "effect/sql";

import {
  alias,
  count,
  desc,
  eq,
  from,
  gt,
  raw,
  select,
  Table,
} from "../src/index.ts";

const people = Table.withNaming("snake_case").fromSchema(
  "people",
  Schema.Struct({ displayName: Schema.String, id: Schema.Int }),
  { primaryKey: "id" }
);

const posts = Table.fromSchema(
  "posts",
  Schema.Struct({
    id: Schema.NullOr(Schema.Int),
    note: Schema.OptionFromNullOr(Schema.String),
  }),
  { columns: { note: { name: "__eqb_0" } } }
);

const decodeFixtureBinds = Schema.decodeUnknownSync(
  Schema.mutable(
    Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))
  )
);

const makeClient = (database: Database) => {
  const execute = (
    text: string,
    params: readonly unknown[],
    transform: Parameters<SqlConnection.Connection["execute"]>[2]
  ) =>
    Effect.try({
      catch: (cause) =>
        new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
      try: () => {
        const binds = decodeFixtureBinds(params);

        const rows = database
          .query<SqlConnection.Row, typeof binds>(text)
          .all(...binds);

        return transform === undefined ? rows : transform(rows);
      },
    });

  const executeValues: SqlConnection.Connection["executeValues"] = (
    text,
    params
  ) =>
    map(execute(text, params, undefined), (rows) =>
      rows.map((row) => Object.values(row))
    );

  return Effect.runSync(
    SqlClient.make({
      acquirer: Effect.succeed({
        execute,
        executeRaw: (text, params) => execute(text, params, undefined),
        executeStream: (text, params, transform) =>
          Stream.unwrap(
            map(execute(text, params, transform), Stream.fromIterable)
          ),
        executeUnprepared: execute,
        executeValues,
        executeValuesUnprepared: executeValues,
      }),
      compiler: Statement.makeCompilerSqlite((name) => `driver_${name}`),
      driver: "sqlite-bun",
      spanAttributes: [],
      transformRows: Statement.defaultTransforms((name) => `driver_${name}`)
        .array,
    }).pipe(Effect.provide(Reactivity.layer))
  );
};

const fixture = (database: Database) => {
  database.run(
    "CREATE TABLE people (display_name TEXT NOT NULL, id INTEGER PRIMARY KEY)"
  );
  database.run("CREATE TABLE posts (id INTEGER, __eqb_0 TEXT)");
  database.run("INSERT INTO people VALUES ('Ada', 1), ('Lin', 2)");
  database.run("INSERT INTO posts VALUES (NULL, NULL), (42, 'note')");

  return makeClient(database);
};

test("compiles table shorthand with physical names and independent aliases", () => {
  expect(from(people).compile("pg")).toEqual({
    params: [],
    sql: 'SELECT "people"."display_name" AS "__eqb_0", "people"."id" AS "__eqb_1" FROM "people"',
  });
});

test("decodes colliding joined columns and distinguishes an all-null row from an unmatched row", () => {
  using database = new Database(":memory:");
  const sql = fixture(database);

  const query = from(people)
    .leftJoin(posts, (scope) => eq(scope.people.c.id, 1))
    .select((scope) => ({
      note: scope.posts.c.note,
      person: scope.people,
      post: scope.posts,
    }))
    .orderBy(people.c.id, posts.c.id);

  expectTypeOf<Effect.Success<typeof query>>().toEqualTypeOf<
    readonly {
      readonly note: Option.Option<string> | null;
      readonly person: { readonly displayName: string; readonly id: number };
      readonly post: {
        readonly id: number | null;
        readonly note: Option.Option<string>;
      } | null;
    }[]
  >();

  const rows = Effect.runSync(
    Effect.gen(function* rows() {
      return yield* query;
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  );

  expect(rows).toEqual([
    {
      note: Option.none(),
      person: { displayName: "Ada", id: 1 },
      post: { id: null, note: Option.none() },
    },
    {
      note: Option.some("note"),
      person: { displayName: "Ada", id: 1 },
      post: { id: 42, note: Option.some("note") },
    },
    { note: null, person: { displayName: "Lin", id: 2 }, post: null },
  ]);
});

test("reuses filters via pipe while preserving a base query and accepting raw SQL fragments", () => {
  using database = new Database(":memory:");
  const sql = fixture(database).withoutTransforms();
  const base = select(people);

  const query = base.pipe((queryBuilder) =>
    queryBuilder
      .$if(true, (q) => q.where(sql`"people"."id" > ${0}`))
      .when(false, (q) => q.where(eq(people.c.id, 0)))
      .where((scope) => gt(scope.people.c.id, 1))
      .orderBy(desc(people.c.id))
      .limit(2)
      .offset(0)
      .distinct()
  );

  expectTypeOf<typeof query>().toEqualTypeOf<typeof base>();
  expect(base.compile("sqlite").params).toEqual([]);
  expect(query.compile("sqlite").params).toEqual([0, 1]);
  expect(
    sql`SELECT "__eqb_1" AS id FROM (${query}) WHERE "__eqb_1" < ${3}`.compile()
  ).toEqual([
    'SELECT "__eqb_1" AS id FROM (SELECT DISTINCT "people"."display_name" AS "__eqb_0", "people"."id" AS "__eqb_1" FROM "people" WHERE (("people"."id" > ?) AND ("people"."id" > ?)) ORDER BY "people"."id" DESC LIMIT 2 OFFSET 0) WHERE "__eqb_1" < ?',
    [0, 1, 3],
  ]);
  expect(Effect.runSync(sql`SELECT "__eqb_1" AS id FROM (${query})`)).toEqual([
    { id: 2 },
  ]);
});

test("supports cardinality, streaming, and native schema errors", () => {
  using database = new Database(":memory:");
  const sql = fixture(database);
  const base = from(people).select({ id: people.c.id }).orderBy(people.c.id);
  const empty = base.where(eq(people.c.id, 0));
  const invalid = select({ id: raw(Schema.Int, sql`'not-an-int'`) });

  const results = Effect.runSync(
    Effect.gen(function* results() {
      return {
        first: yield* base.findOne(),
        maybe: yield* empty.findOneOption(),
        nonEmpty: yield* base.findNonEmpty(),
        oneError: yield* Effect.flip(empty.findOne()),
        rowError: yield* Effect.flip(invalid.findOne()),
        rowsError: yield* Effect.flip(empty.findNonEmpty()),
        stream: yield* Stream.runCollect(base.stream()),
      };
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  );

  expect(results.first).toEqual({ id: 1 });
  expect(results.maybe).toEqual(Option.none());
  expect(results.nonEmpty).toEqual([{ id: 1 }, { id: 2 }]);
  expect(results.oneError).toBeInstanceOf(Cause.NoSuchElementError);
  expect(results.rowError._tag).toEqual("SchemaError");
  expect(results.rowsError).toBeInstanceOf(Cause.NoSuchElementError);
  expect(results.stream).toEqual([{ id: 1 }, { id: 2 }]);
});

test("tracks alias scope and nullability across right and full joins", () => {
  using database = new Database(":memory:");
  const sql = fixture(database);
  const prior = alias(people, "prior");

  const first = from(people)
    .innerJoin(prior, (scope) => eq(scope.people.c.id, scope.prior.c.id))
    .select(({ people: active, prior: previous }) => ({
      id: active.c.id,
      same: previous.c.id,
    }));

  const right = first.rightJoin(posts, (scope) =>
    eq(scope.people.c.id, scope.posts.c.id)
  );

  const full = first.fullJoin(posts, (scope) =>
    eq(scope.people.c.id, scope.posts.c.id)
  );

  expectTypeOf<Effect.Success<typeof right>>().toEqualTypeOf<
    readonly { readonly id: number | null; readonly same: number | null }[]
  >();
  expectTypeOf<Parameters<typeof full.compile>[0]>().toEqualTypeOf<
    "pg" | "sqlite"
  >();

  expect(
    Effect.runSync(right.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
  ).toEqual([
    { id: null, same: null },
    { id: null, same: null },
  ]);
  expect(full.compile("sqlite").sql).toContain("FULL OUTER JOIN");
  expect(from(people).crossJoin(posts).compile("pg").sql).toContain(
    "CROSS JOIN"
  );
});

test("groups, applies HAVING, and asserts the selected type", () => {
  using database = new Database(":memory:");
  const sql = fixture(database);

  database.run("INSERT INTO people VALUES ('Ada', 3)");

  const query = select({ name: people.c.displayName, records: count() })
    .from(people)
    .groupBy((scope) => scope.people.c.displayName)
    .having((scope) => gt(count(scope.people.c.id), 1))
    .orderBy(people.c.displayName)
    .$assertType<{ readonly name: string; readonly records: number }>();

  expect(
    Effect.runSync(query.pipe(Effect.provideService(SqlClient.SqlClient, sql)))
  ).toEqual([{ name: "Ada", records: 2 }]);
});
