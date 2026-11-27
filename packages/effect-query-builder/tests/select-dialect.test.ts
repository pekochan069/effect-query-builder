import { Database } from "bun:sqlite";
import { expect, expectTypeOf, test } from "bun:test";

import { Effect, Schema } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient, SqlError, Statement } from "effect/sql";

import { desc, eq, from, Table } from "../src/index.ts";
import * as mysql from "../src/mysql.ts";
import * as pg from "../src/pg.ts";
import * as sqlite from "../src/sqlite.ts";

const documents = Table.fromSchema(
  "documents",
  Schema.Struct({ id: Schema.Int, name: Schema.String, payload: Schema.String })
);

test("compiles PostgreSQL DISTINCT ON, ILIKE, and JSONB operators with ordered binds", () => {
  const query = pg
    .from(documents)
    .select({
      text: pg.jsonbText(documents.c.payload, "label"),
      value: pg.jsonbGet(documents.c.payload, "items", Schema.Json),
    })
    .distinctOn(documents.c.id)
    .where(pg.ilike(documents.c.name, "doc%"))
    .where(pg.jsonbContains(documents.c.payload, { enabled: true }))
    .where(pg.jsonbHasKey(documents.c.payload, "label"))
    .orderBy(documents.c.id);

  expect(query.compile("pg")).toEqual({
    params: ["label", "items", "doc%", '{"enabled":true}', "label"],
    sql: 'SELECT DISTINCT ON ("documents"."id") ("documents"."payload" ->> $1) AS "__eqb_0", ("documents"."payload" -> $2) AS "__eqb_1" FROM "documents" WHERE ((("documents"."name" ILIKE $3) AND ("documents"."payload" @> $4)) AND ("documents"."payload" ? $5)) ORDER BY "documents"."id" ASC',
  });
});

test("executes SQLite JSON expressions with bound paths", () => {
  using database = new Database(":memory:");
  database.run("CREATE TABLE documents (id INTEGER, name TEXT, payload TEXT)");
  database.run("INSERT INTO documents VALUES (?, ?, ?)", [
    1,
    "a",
    '{"items":[1,2],"label":"example"}',
  ]);

  const query = sqlite.from(documents).select({
    kind: sqlite.jsonType(documents.c.payload, "$.label"),
    label: sqlite.jsonExtract(documents.c.payload, "$.label", Schema.String),
    length: sqlite.jsonArrayLength(documents.c.payload, "$.items"),
  });

  const { params, sql } = query.compile("sqlite");
  const binds = Schema.decodeUnknownSync(Schema.Array(Schema.String))(params);

  expect([sql, binds]).toEqual([
    'SELECT json_type("documents"."payload", ?) AS "__eqb_0", json_extract("documents"."payload", ?) AS "__eqb_1", json_array_length("documents"."payload", ?) AS "__eqb_2" FROM "documents"',
    ["$.label", "$.label", "$.items"],
  ]);

  expect(database.query(sql).all(...binds)).toEqual([
    { __eqb_0: "text", __eqb_1: "example", __eqb_2: 2 },
  ]);
});

test("locks SELECT rows after ORDER BY and LIMIT in PostgreSQL and MySQL", () => {
  const query = from(documents)
    .where(eq(documents.c.id, 1))
    .orderBy(desc(documents.c.name))
    .limit(1)
    .forUpdate();

  expectTypeOf<Parameters<typeof query.compile>[0]>().toEqualTypeOf<
    "pg" | "mysql"
  >();
  expect(query.compile("pg").sql).toEndWith(
    'ORDER BY "documents"."name" DESC LIMIT 1 FOR UPDATE'
  );
  expect(mysql.from(documents).forUpdate().compile("mysql").sql).toEndWith(
    "FROM `documents` FOR UPDATE"
  );
});

test("rejects a PostgreSQL query on a SQLite client before acquiring a connection", () => {
  const client = Effect.runSync(
    SqlClient.make({
      acquirer: Effect.fail(
        new SqlError.SqlError({
          reason: new SqlError.UnknownError({
            cause: "unexpected acquisition",
            message: "unexpected acquisition",
          }),
        })
      ),
      compiler: Statement.makeCompilerSqlite(),
      driver: "sqlite-test",
      spanAttributes: [],
    }).pipe(Effect.provide(Reactivity.layer))
  );

  const queries = [
    pg.from(documents),
    from(documents).where(pg.ilike(documents.c.name, "d%")),
    from(documents).distinctOn(documents.c.id),
    from(documents).forUpdate(),
  ];

  const messages = queries.map(
    (query) =>
      Effect.runSync(
        Effect.flip(Effect.provideService(query, SqlClient.SqlClient, client))
      ).message
  );

  expect(messages).toEqual([
    "SELECT scoped to pg is unsupported by the sqlite dialect profile",
    "ILIKE is unsupported by the sqlite dialect profile",
    "DISTINCT ON is unsupported by the sqlite dialect profile",
    "FOR UPDATE is unsupported by the sqlite dialect profile",
  ]);
});
