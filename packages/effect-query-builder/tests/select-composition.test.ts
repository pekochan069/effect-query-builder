import { Database } from "bun:sqlite";
import { expect, expectTypeOf, test } from "bun:test";

import { Effect, Exit, Option, Result, Schema, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError, Statement } from "effect/sql";
import type { SqlConnection } from "effect/sql";

import {
  add,
  alias,
  count,
  desc,
  eq,
  from,
  gt,
  max,
  min,
  neq,
  raw,
  select,
  Table,
  withCte,
} from "../src/index.ts";

const authors = Table.fromSchema(
  "authors",
  Schema.Struct({ id: Schema.Int, name: Schema.String })
);

const books = Table.fromSchema(
  "books",
  Schema.Struct({
    authorId: Schema.Int,
    note: Schema.OptionFromNullOr(Schema.String),
  }),
  { naming: "snake_case" }
);

const makeClient = (database: Database) => {
  const execute: SqlConnection.Connection["execute"] = (
    sql,
    params,
    transform
  ) =>
    Effect.try({
      catch: (cause) =>
        new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
      try: () => {
        const binds = [
          ...Schema.decodeUnknownSync(
            Schema.Array(
              Schema.Union([Schema.String, Schema.Number, Schema.Null])
            )
          )(params),
        ];

        const rows = database
          .query<SqlConnection.Row, typeof binds>(sql)
          .all(...binds);

        return transform === undefined ? rows : transform(rows);
      },
    });

  const executeValues: SqlConnection.Connection["executeValues"] = (
    sql,
    params
  ) =>
    Effect.map(execute(sql, params, undefined), (rows) =>
      rows.map(Object.values)
    );

  return Effect.runSync(
    SqlClient.make({
      acquirer: Effect.succeed({
        execute,
        executeRaw: (sql, params) => execute(sql, params, undefined),
        executeStream: (sql, params, transform) =>
          Stream.unwrap(
            Effect.map(execute(sql, params, transform), Stream.fromIterable)
          ),
        executeUnprepared: execute,
        executeValues,
        executeValuesUnprepared: executeValues,
      }),
      compiler: Statement.makeCompilerSqlite(),
      driver: "sqlite-bun",
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer))
  );
};

const fixture = (db: Database) => {
  db.run("CREATE TABLE authors (id INTEGER, name TEXT)");
  db.run("CREATE TABLE books (author_id INTEGER, note TEXT)");
  db.run("INSERT INTO authors VALUES (1, 'Ada'), (2, 'Lin'), (3, 'Mae')");
  db.run("INSERT INTO books VALUES (1, NULL), (2, 'reviewed')");

  return makeClient(db);
};

test("preserves a joined field's presence marker through aliased subqueries", () => {
  using db = new Database(":memory:");

  const sql = fixture(db);

  const joined = from(authors)
    .leftJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ author: authors, id: authors.c.id, note: books.c.note })
    .as("joined");

  const forwarded = from(joined)
    .select({ id: joined.c.id, note: joined.c.note })
    .as("forwarded");

  const query = from(forwarded).orderBy(forwarded.c.id);

  expectTypeOf<Effect.Success<typeof query>>().toEqualTypeOf<
    readonly {
      readonly id: number;
      readonly note: Option.Option<string> | null;
    }[]
  >();
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([
    { id: 1, note: Option.none() },
    { id: 2, note: Option.some("reviewed") },
    { id: 3, note: null },
  ]);
  expect(
    Effect.runSync(
      Effect.provideService(
        from(joined).orderBy(joined.c.id).findOne(),
        SqlClient.SqlClient,
        sql
      )
    )
  ).toEqual({ author: { id: 1, name: "Ada" }, id: 1, note: Option.none() });
});

test("composes CTEs with typed prior references, aliases, and bind order", () => {
  using db = new Database(":memory:");

  const sql = fixture(db);

  const query = withCte("active", from(authors).where(gt(authors.c.id, 0)))
    .with("recent", ({ active }) => from(active).where(gt(active.c.id, 1)))
    .from(({ recent }) => recent)
    .innerJoin(
      ({ recent }) => alias(recent, "copy"),
      ({ recent, copy }) => eq(recent.c.id, copy.c.id)
    )
    .where(({ recent }) => eq(recent.c.id, 2))
    .select(({ recent, copy }) => ({
      left: recent.c.name,
      right: copy.c.name,
    }));

  expectTypeOf<Effect.Success<typeof query>>().toEqualTypeOf<
    readonly {
      readonly left: string;
      readonly right: string;
    }[]
  >();
  expect(query.compile("pg").params).toEqual([0, 1, 2]);
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ left: "Lin", right: "Lin" }]);
});

test("groups a derived Option field without selecting an ungrouped presence column", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);

  const joined = from(authors)
    .leftJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ note: books.c.note })
    .as("joined");

  const query = from(joined)
    .select({ note: joined.c.note, records: count() })
    .groupBy(joined.c.note)
    .orderBy(joined.c.note);

  expect(query.compile("pg").sql).toContain(
    'COUNT(CASE WHEN "joined"."__eqb_0" THEN 1 END)'
  );
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([
    { note: Option.none(), records: 2 },
    { note: Option.some("reviewed"), records: 1 },
  ]);
});

test("uses a named scalar subquery and decodes an empty scalar as null", () => {
  using db = new Database(":memory:");

  const sql = fixture(db);
  const base = from(authors).select({ id: authors.c.id, name: authors.c.name });
  const first = base.where(eq(authors.c.id, 1)).scalar("name");
  const missing = base.where(eq(authors.c.id, 0)).scalar("id");

  const query = select({ first, missing });

  expectTypeOf<Effect.Success<typeof query>>().toEqualTypeOf<
    readonly {
      readonly first: string | null;
      readonly missing: number | null;
    }[]
  >();
  expect(query.compile("pg").params).toEqual([1, 0]);
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ first: "Ada", missing: null }]);
});

test("decodes SQL NULL before the scalar field's Option codec", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);

  const base = from(books);

  const note = (id: number) =>
    base.where(eq(books.c.authorId, id)).scalar("note");

  const query = select({
    missing: note(0),
    nullNote: note(1),
    present: note(2),
  });

  expectTypeOf<
    Effect.Success<typeof query>[number]["present"]
  >().toEqualTypeOf<Option.Option<string> | null>();
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([
    { missing: null, nullNote: null, present: Option.some("reviewed") },
  ]);
});

test("decodes SQL NULL before the MIN and MAX operand's Option codec", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);

  const extrema = from(books).select({
    minimum: min(books.c.note),
    maximum: max(books.c.note),
  });

  const run = (id: number) =>
    Effect.runSync(
      Effect.provideService(
        extrema.where(eq(books.c.authorId, id)).findOne(),
        SqlClient.SqlClient,
        sql
      )
    );

  expect(run(0)).toEqual({ minimum: null, maximum: null });
  expect(run(1)).toEqual({ minimum: null, maximum: null });
  expect(run(2)).toEqual({
    minimum: Option.some("reviewed"),
    maximum: Option.some("reviewed"),
  });
});

test("compares scalar subqueries and extrema using the operands' SQL values", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);

  const branded = Table.fromSchema(
    "authors",
    Schema.Struct({ id: Schema.Int.pipe(Schema.brand("AuthorId")) })
  );

  const { id } = branded.c;
  const { note, authorId } = books.c;
  const selectedId = from(branded).where(eq(id, 2)).scalar("id");
  const selectedNote = from(books).where(eq(authorId, 2)).scalar("note");

  const brandedMatch = from(branded)
    .where(eq(id, selectedId))
    .where(eq(selectedId, id))
    .select({ minimum: eq(min(id), id), maximum: eq(id, max(id)) })
    .groupBy(id);

  const optionalMatch = from(books)
    .where(eq(note, selectedNote))
    .where(eq(selectedNote, note))
    .select({ minimum: eq(note, min(note)), maximum: eq(max(note), note) })
    .groupBy(note);

  const provided = Effect.provideService(SqlClient.SqlClient, sql);

  for (const query of [brandedMatch, optionalMatch]) {
    expect(Effect.runSync(query.pipe(provided))).toEqual([
      { minimum: true, maximum: true },
    ]);
  }
});

test("uses the same SQL number type for a built-in result through a scalar subquery", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);
  const { id } = authors.c;
  const counts = from(books).select({ total: count() });
  const stats = counts.as("stats");

  const query = from(authors)
    .where(eq(id, counts.scalar("total")))
    .where(eq(from(stats).scalar("total"), id))
    .select({ id, unchanged: eq(id, add(add(id, 0), 0)) });

  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ id: 2, unchanged: true }]);
});

test("carries numeric projection keys into derived columns and scalars", () => {
  using db = new Database(":memory:");
  const sql = makeClient(db);
  const codes = Table.fromSchema("codes", Schema.Struct({ 1: Schema.String }));

  db.run('CREATE TABLE codes ("1" TEXT)');
  db.run("INSERT INTO codes VALUES ('A')");

  const derived = from(codes).as("derived_codes");
  const projected = from(derived).select({ 2: derived.c[1] });
  const query = select({ code: projected.scalar("2") });

  expectTypeOf<Effect.Success<typeof query>[number]["code"]>().toEqualTypeOf<
    string | null
  >();
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ code: "A" }]);
});

test("combines set operands by canonical projection order and checks their layouts", () => {
  using db = new Database(":memory:");

  const sql = fixture(db);
  const base = from(authors).select({ id: authors.c.id, name: authors.c.name });
  const first = base.where(eq(authors.c.id, 1));

  const second = from(authors)
    .select({ name: authors.c.name, id: authors.c.id })
    .where(eq(authors.c.id, 2));

  const union = first
    .union(second)
    .unionAll(first)
    .intersect(base)
    .except(second)
    .as("results");

  const query = from(union).orderBy(union.c.id);

  expectTypeOf<Effect.Success<typeof query>>().toEqualTypeOf<
    readonly {
      readonly id: number;
      readonly name: string;
    }[]
  >();
  expect(query.compile("pg").params).toEqual([1, 2, 1, 2]);
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ id: 1, name: "Ada" }]);

  const joined = from(authors)
    .leftJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ note: books.c.note })
    .as("joined");

  const inferred = from(joined).select({ note: joined.c.note });

  const incompatible = select({
    note: raw(Schema.NullOr(Schema.OptionFromNullOr(Schema.String)), sql`NULL`),
  });

  expect(() => inferred.union(incompatible).compile("sqlite")).toThrow(
    "Set operation operands must have the same SQL projection layout"
  );
});

test("carries restricted dialects through derived sources, joins, CTEs, and sets", () => {
  const left = from(authors).select({ id: authors.c.id });

  const full = from(authors)
    .fullJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ id: authors.c.id });

  const derived = full.as("full");
  const joined = left.crossJoin(derived);
  const cte = withCte("full", full).from(({ full: source }) => source);
  const union = cte.union(full);

  expectTypeOf<Parameters<typeof joined.compile>[0]>().toEqualTypeOf<
    "pg" | "sqlite"
  >();
  expectTypeOf<Parameters<typeof cte.compile>[0]>().toEqualTypeOf<
    "pg" | "sqlite"
  >();
  expectTypeOf<Parameters<typeof union.compile>[0]>().toEqualTypeOf<
    "pg" | "sqlite"
  >();
  expect(joined.compile("sqlite").sql).toContain("FULL OUTER JOIN");
  expect(union.compile("pg").sql).toContain("FULL OUTER JOIN");
});

test("carries a scalar subquery's restricted dialect into projections", () => {
  const id = from(authors)
    .fullJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ id: authors.c.id })
    .scalar("id");

  const embedded = select({ id });
  const compared = from(authors).select({ matches: eq(id, authors.c.id) });

  expectTypeOf<Parameters<typeof embedded.compile>[0]>().toEqualTypeOf<
    "pg" | "sqlite"
  >();
  expectTypeOf<Parameters<typeof compared.compile>[0]>().toEqualTypeOf<
    "pg" | "sqlite"
  >();
  expect(embedded.compile("pg").sql).toContain("FULL OUTER JOIN");
  expect(compared.compile("sqlite").sql).toContain("FULL OUTER JOIN");
});

test("rejects an unsupported scalar in a predicate with a typed SQL error", () => {
  const client = Effect.runSync(
    SqlClient.make({
      acquirer: Effect.die(
        "The compiler must reject the query before acquisition"
      ),
      compiler: Statement.makeCompiler({
        dialect: "mysql",
        onCustom: () => ["", []],
        onIdentifier: Statement.defaultEscape("`"),
        onRecordUpdate: () => ["", []],
        placeholder: () => "?",
      }),
      driver: "mysql-test",
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer))
  );

  const id = from(authors)
    .fullJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ id: authors.c.id })
    .scalar("id");

  const authorsQuery = from(authors);
  const filtered = authorsQuery.where(eq(authors.c.id, id));

  expectTypeOf<typeof filtered>().toEqualTypeOf<typeof authorsQuery>();

  const result = Effect.runSync(
    Effect.flip(Effect.provideService(filtered, SqlClient.SqlClient, client))
  );

  expect(result).toBeInstanceOf(SqlError.SqlError);
  expect(result.message).toContain("FULL OUTER JOIN is unsupported");
});

test("rejects set operands with incompatible encoded projections", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);
  const left = select({ value: raw(Schema.NumberFromString, sql`'42'`) });
  const right = select({ value: raw(Schema.Int, sql`43`) });

  expect(() => left.unionAll(right).compile("sqlite")).toThrow(
    "Set operation operands must have compatible encoded projections"
  );
});

test("combines numeric expressions with columns in either set operand", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);
  const column = from(authors).select({ value: authors.c.id });
  const total = from(books).select({ value: count() });

  const incremented = from(books).select({
    value: add(books.c.authorId, 2),
  });

  const run = (
    query: Effect.Effect<
      Effect.Success<typeof column>,
      Effect.Error<typeof column>,
      SqlClient.SqlClient
    >
  ) =>
    Effect.runSync(
      query.pipe(
        Effect.map((rows) =>
          rows.map(({ value }) => value).toSorted((left, right) => left - right)
        ),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.exit
      )
    );

  expect(run(total.union(column).union(incremented))).toEqual(
    Exit.succeed([1, 2, 3, 4])
  );
  expect(run(column.union(total).union(incremented))).toEqual(
    Exit.succeed([1, 2, 3, 4])
  );
});

test("combines predicates with columns that decode SQLite boolean bits", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);
  db.run("CREATE TABLE flags (value INTEGER)");
  db.run("INSERT INTO flags VALUES (0)");

  const flags = Table.fromSchema(
    "flags",
    Schema.Struct({ value: Schema.BooleanFromBit })
  );

  const column = from(flags).select({ value: flags.c.value });
  const predicate = from(authors).select({ value: eq(authors.c.id, 1) });

  const run = (
    query: Effect.Effect<
      Effect.Success<typeof column>,
      Effect.Error<typeof column>,
      SqlClient.SqlClient
    >
  ) =>
    Effect.runSync(
      query.pipe(
        Effect.map((rows) => new Set(rows.map(({ value }) => value))),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.exit
      )
    );

  expect(run(predicate.union(column))).toEqual(
    Exit.succeed(new Set([false, true]))
  );
  expect(run(column.union(predicate))).toEqual(
    Exit.succeed(new Set([false, true]))
  );
});

test("deduplicates NULL across joined and nullable scalar set operands", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);
  db.run("CREATE TABLE nullable_books (id INTEGER)");
  db.run("INSERT INTO nullable_books VALUES (NULL), (2), (8)");

  const nullableBooks = Table.fromSchema(
    "nullable_books",
    Schema.Struct({ id: Schema.NullOr(Schema.Int) })
  );

  const nullable = from(nullableBooks).select({ value: nullableBooks.c.id });

  const joined = from(authors)
    .leftJoin(books, eq(authors.c.id, books.c.authorId))
    .select({ value: books.c.authorId });

  const run = (
    query: Effect.Effect<
      Effect.Success<typeof joined>,
      Effect.Error<typeof joined>,
      SqlClient.SqlClient
    >
  ) =>
    Effect.runSync(
      query.pipe(
        Effect.map((rows) =>
          rows
            .map(({ value }) => value)
            .toSorted((left, right) => (left ?? -1) - (right ?? -1))
        ),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.exit
      )
    );

  expect(run(joined.union(nullable))).toEqual(Exit.succeed([null, 1, 2, 8]));
  expect(run(nullable.union(joined))).toEqual(Exit.succeed([null, 1, 2, 8]));
  expect(run(joined.intersect(nullable))).toEqual(Exit.succeed([null, 2]));
  expect(run(joined.except(nullable))).toEqual(Exit.succeed([1]));
  expect(
    run(
      joined.union(nullable.except(nullable.where(eq(nullableBooks.c.id, 8))))
    )
  ).toEqual(Exit.succeed([null, 1, 2]));
});

test("deduplicates missing derived rows against nullable scalar set operands", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);

  const inner = from(authors)
    .leftJoin(books, eq(authors.c.id, books.c.authorId))
    .where(neq(authors.c.id, 2))
    .select({ id: authors.c.id, value: books.c.authorId })
    .as("joined_books");

  const joined = from(authors)
    .leftJoin(inner, eq(authors.c.id, inner.c.id))
    .select({ value: inner.c.value });

  const nullable = select({ value: raw(Schema.NullOr(Schema.Int), sql`NULL`) });
  const query = joined.union(nullable);

  expect(
    Effect.runSync(
      query.pipe(
        Effect.map((rows) =>
          rows
            .map(({ value }) => value)
            .toSorted((left, right) => (left ?? -1) - (right ?? -1))
        ),
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.exit
      )
    )
  ).toEqual(Exit.succeed([null, 1]));
});

test("keeps a malformed matched row visible to the left set operand's codec", () => {
  using db = new Database(":memory:");
  const sql = fixture(db);
  db.run("CREATE TABLE invalid_books (author_id INTEGER, value INTEGER)");
  db.run("INSERT INTO invalid_books VALUES (1, NULL)");

  const invalidBooks = Table.fromSchema(
    "invalid_books",
    Schema.Struct({ authorId: Schema.Int, value: Schema.Int }),
    { naming: "snake_case" }
  );

  const joined = from(authors)
    .leftJoin(invalidBooks, eq(authors.c.id, invalidBooks.c.authorId))
    .select({ value: invalidBooks.c.value });

  const nullable = select({ value: raw(Schema.NullOr(Schema.Int), sql`NULL`) });

  expect(
    Effect.runSync(
      joined
        .union(nullable)
        .pipe(Effect.provideService(SqlClient.SqlClient, sql), Effect.result)
    )
  ).toMatchObject({ failure: { _tag: "SchemaError" } });
});

test("rejects set operands whose fields use different shared presence markers", () => {
  const left = alias(books, "left_books");
  const right = alias(books, "right_books");

  const joined = from(authors)
    .leftJoin(left, eq(authors.c.id, left.c.authorId))
    .leftJoin(right, eq(authors.c.id, right.c.authorId));

  const first = joined.select({
    a: left.c.note,
    b: right.c.note,
    c: left.c.note,
  });

  const second = joined.select({
    a: left.c.note,
    b: right.c.note,
    c: right.c.note,
  });

  expect(() => first.unionAll(second).compile("sqlite")).toThrow(
    "Set operation operands must have the same SQL projection layout"
  );
});

test.each(["subquery", "CTE"] as const)(
  "preserves outer join absence through a derived %s",
  (kind) => {
    using db = new Database(":memory:");
    const sql = fixture(db);

    const inner = from(authors)
      .leftJoin(books, eq(authors.c.id, books.c.authorId))
      .where(neq(authors.c.id, 2))
      .select({
        id: authors.c.id,
        bookAuthor: books.c.authorId,
        note: books.c.note,
      });

    const query = (
      kind === "subquery"
        ? from(authors).leftJoin(inner.as("joined"), ({ joined }) =>
            eq(authors.c.id, joined.c.id)
          )
        : withCte("joined", inner)
            .from(authors)
            .leftJoin(
              ({ joined }) => joined,
              ({ joined }) => eq(authors.c.id, joined.c.id)
            )
    )
      .select(({ joined }) => ({
        id: authors.c.id,
        joinedId: joined.c.id,
        bookAuthor: joined.c.bookAuthor,
        note: joined.c.note,
      }))
      .orderBy(authors.c.id);

    expect(
      Effect.runSync(
        Effect.result(Effect.provideService(query, SqlClient.SqlClient, sql))
      )
    ).toEqual(
      Result.succeed([
        { id: 1, joinedId: 1, bookAuthor: 1, note: Option.none() },
        { id: 2, joinedId: null, bookAuthor: null, note: null },
        { id: 3, joinedId: 3, bookAuthor: null, note: null },
      ])
    );
  }
);

const unexpectedClauseCallback = () => {
  throw new Error("Clause callback ran on a compound SELECT");
};

test.each(["union", "unionAll", "intersect", "except"] as const)(
  "requires wrapping %s before adding SELECT clauses",
  (operator) => {
    using db = new Database(":memory:");
    const sql = fixture(db);
    const base = from(authors).select({ id: authors.c.id });
    const first = base.orderBy(authors.c.id).limit(2);
    const second = base.orderBy(desc(authors.c.id)).limit(1);
    const compound = first[operator](second);

    // @ts-expect-error Compound queries do not expose single-SELECT clauses.
    const runtime: typeof first = compound;

    const modifiers = {
      limit: () => runtime.limit(1),
      offset: () => runtime.offset(1),
      where: () => runtime.where(unexpectedClauseCallback),
      orderBy: () => runtime.orderBy(unexpectedClauseCallback),
      groupBy: () => runtime.groupBy(unexpectedClauseCallback),
      having: () => runtime.having(unexpectedClauseCallback),
      distinct: () => runtime.distinct(),
      select: () => runtime.select(unexpectedClauseCallback),
      from: () => runtime.from(unexpectedClauseCallback),
      innerJoin: () =>
        runtime.innerJoin(unexpectedClauseCallback, unexpectedClauseCallback),
      leftJoin: () =>
        runtime.leftJoin(unexpectedClauseCallback, unexpectedClauseCallback),
      rightJoin: () =>
        runtime.rightJoin(unexpectedClauseCallback, unexpectedClauseCallback),
      fullJoin: () =>
        runtime.fullJoin(unexpectedClauseCallback, unexpectedClauseCallback),
      crossJoin: () => runtime.crossJoin(unexpectedClauseCallback),
    };

    expectTypeOf<
      Extract<keyof typeof compound, keyof typeof modifiers>
    >().toBeNever();

    for (const modify of Object.values(modifiers)) {
      expect(modify).toThrow("Wrap the compound SELECT with .as() and from()");
    }

    const configured = compound
      .with("available", base)
      .$narrow<{ readonly id: number }>()
      .$assertType<{ readonly id: number }>()
      .$if(true, (query) => {
        expectTypeOf<typeof query>().not.toHaveProperty("limit");

        return query;
      })
      .when(false, (query) => {
        expectTypeOf<typeof query>().not.toHaveProperty("limit");

        return query;
      });

    expectTypeOf<typeof configured>().not.toHaveProperty("limit");

    const derived = configured.as("combined");
    const query = from(derived).orderBy(desc(derived.c.id)).limit(1);

    const expected = {
      except: [{ id: 2 }],
      intersect: [],
      union: [{ id: 3 }],
      unionAll: [{ id: 3 }],
    };

    expect(
      Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
    ).toEqual(expected[operator]);
  }
);
