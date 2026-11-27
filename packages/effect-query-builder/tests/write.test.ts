import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { DateTime, Effect, Schema, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { Model } from "effect/schema";
import { SqlClient, SqlError, Statement } from "effect/sql";
import type { SqlConnection } from "effect/sql";

import {
  add,
  alias,
  deleteFrom,
  eq,
  from,
  insertInto,
  raw,
  Table,
  update,
} from "../src/index.ts";
import * as mysql from "../src/mysql.ts";
import * as pg from "../src/pg.ts";

const UserId = Schema.Int.pipe(Schema.brand("UserId"));

class User extends Model.Class<User>("User")({
  active: Model.BooleanSqlite,
  count: Schema.Int,
  createdAt: Model.DateTimeInsert,
  id: UserId,
  profile: Model.JsonFromString(Schema.Struct({ tag: Schema.String })),
  updatedAt: Model.DateTimeUpdate,
}) {}

const users = Table.withNaming("snake_case").fromModel("users", User, {
  primaryKey: "id",
});

const bindings = Schema.decodeUnknownSync(
  Schema.mutable(
    Schema.Array(Schema.Union([Schema.String, Schema.Number, Schema.Null]))
  )
);

const makeClient = (
  database: Database,
  onQuery: (text: string, params: readonly unknown[]) => void = () => {}
) => {
  const execute: SqlConnection.Connection["execute"] = (
    text,
    params,
    transform
  ) =>
    Effect.try({
      catch: (cause) =>
        new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause }) }),
      try: () => {
        onQuery(text, params);

        const rows = database
          .query<SqlConnection.Row, ReturnType<typeof bindings>>(text)
          .all(...bindings(params));

        return transform === undefined ? rows : transform(rows);
      },
    });

  const executeValues: SqlConnection.Connection["executeValues"] = (
    text,
    params
  ) =>
    Effect.map(execute(text, params, undefined), (rows) =>
      rows.map((row: SqlConnection.Row) => Object.values(row))
    );

  return Effect.runSync(
    SqlClient.make({
      acquirer: Effect.succeed({
        execute,
        executeRaw: (text, params) => execute(text, params, undefined),
        executeStream: (text, params, transform) =>
          Stream.unwrap(
            Effect.map(execute(text, params, transform), Stream.fromIterable)
          ),
        executeUnprepared: execute,
        executeValues,
        executeValuesUnprepared: executeValues,
      }),
      compiler: Statement.makeCompilerSqlite((name) => `driver_${name}`),
      driver: "sqlite-test",
      spanAttributes: [],
      transformRows: Statement.defaultTransforms((name) => `driver_${name}`)
        .array,
    }).pipe(Effect.provide(Reactivity.layer))
  );
};

const setupUsers = (database: Database) =>
  database.run(
    "CREATE TABLE users (id INTEGER PRIMARY KEY, active INTEGER NOT NULL, count INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, profile TEXT NOT NULL)"
  );

const iso = "2025-05-01T10:00:00.000Z";
const time = Model.Override(DateTime.makeUnsafe(iso));

test("encodes bulk model inserts, then decodes RETURNING through the model", () => {
  using database = new Database(":memory:");
  setupUsers(database);
  const received: (readonly unknown[])[] = [];

  const sql = makeClient(database, (_, params) => {
    received.push(params);
  });

  const row = {
    active: true,
    count: 3,
    createdAt: time,
    id: UserId.make(1),
    profile: { tag: "staff" },
    updatedAt: time,
  };

  const query = insertInto(users)
    .values([row, { ...row, active: false, id: UserId.make(2) }])
    .returning();

  const rows = Effect.runSync(
    Effect.provideService(query, SqlClient.SqlClient, sql)
  );

  expect(received).toEqual([
    [
      1,
      3,
      iso,
      1,
      '{"tag":"staff"}',
      iso,
      0,
      3,
      iso,
      2,
      '{"tag":"staff"}',
      iso,
    ],
  ]);
  expect(rows).toEqual([
    new User({
      ...row,
      createdAt: DateTime.makeUnsafe(iso),
      updatedAt: DateTime.makeUnsafe(iso),
    }),
    new User({
      ...row,
      active: false,
      createdAt: DateTime.makeUnsafe(iso),
      id: UserId.make(2),
      updatedAt: DateTime.makeUnsafe(iso),
    }),
  ]);
});

test("encodes a partial patch alongside SQL expressions on an aliased target", () => {
  using database = new Database(":memory:");
  setupUsers(database);
  database.run("INSERT INTO users VALUES (1, 1, 3, ?, ?, ?)", [
    iso,
    iso,
    '{"tag":"staff"}',
  ]);
  const received: (readonly unknown[])[] = [];

  const sql = makeClient(database, (_, params) => {
    received.push(params);
  });

  const person = alias(users, "person");
  const timestamp = "2025-05-02T12:00:00.000Z";

  const query = update(person)
    .set({
      count: add(person.c.count, 2),
      active: false,
      profile: { tag: "admin" },
      updatedAt: Model.Override(DateTime.makeUnsafe(timestamp)),
    })
    .returning({
      active: person.c.active,
      next: add(person.c.count, 1),
      updated: person.c.updatedAt,
    })
    .where((target) => eq(target.c.id, 1));

  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([
    { active: false, next: 6, updated: DateTime.makeUnsafe(timestamp) },
  ]);
  expect(received).toEqual([[0, 2, '{"tag":"admin"}', timestamp, 1, 1]]);
});

test("copies the named scalar SELECT outputs while preserving the source binds", () => {
  using database = new Database(":memory:");
  const sql = makeClient(database);

  const source = Table.fromSchema(
    "source",
    Schema.Struct({
      item: Schema.Int,
      payload: Schema.String,
    })
  );

  const destination = Table.withNaming("snake_case").fromSchema(
    "destination",
    Schema.Struct({
      objectId: Schema.Int,
      payloadText: Schema.String,
    })
  );

  database.run("CREATE TABLE source (item INTEGER, payload TEXT)");
  database.run(
    "CREATE TABLE destination (object_id INTEGER, payload_text TEXT)"
  );
  database.run("INSERT INTO source VALUES (3, 'copy'), (9, 'skip')");

  const query = insertInto(destination)
    .fromSelect(
      from(source)
        .select({
          payloadText: source.c.payload,
          objectId: add(source.c.item, 2),
        })
        .where(eq(source.c.item, 3))
    )
    .returning();

  expect(Effect.runSync(query.compile("pg"))).toEqual({
    params: [2, 3],
    sql: 'INSERT INTO "destination" ("object_id", "payload_text") SELECT "__eqb_insert_source"."__eqb_0" AS "__eqb_0", "__eqb_insert_source"."__eqb_1" AS "__eqb_1" FROM (SELECT ("source"."item" + $1) AS "__eqb_0", "source"."payload" AS "__eqb_1" FROM "source" WHERE ("source"."item" = $2)) AS "__eqb_insert_source" RETURNING "destination"."object_id" AS "__eqb_0", "destination"."payload_text" AS "__eqb_1"',
  });
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ objectId: 5, payloadText: "copy" }]);
});

test("deletes through an alias and decodes only the matching SQLite row", () => {
  using database = new Database(":memory:");
  setupUsers(database);
  database.run(
    "INSERT INTO users VALUES (1, 1, 3, ?, ?, ?), (2, 0, 3, ?, ?, ?), (3, 0, 3, ?, ?, ?)",
    [
      iso,
      iso,
      '{"tag":"staff"}',
      iso,
      iso,
      '{"tag":"guest"}',
      iso,
      iso,
      '{"tag":"guest"}',
    ]
  );
  const sql = makeClient(database);
  const person = alias(users, "person");

  const query = deleteFrom(person)
    .where(eq(person.c.id, 2))
    .where(eq(person.c.active, 0))
    .returning({ profile: person.c.profile });

  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ profile: { tag: "guest" } }]);
  expect(database.query("SELECT id FROM users ORDER BY id").all()).toEqual([
    { id: 1 },
    { id: 3 },
  ]);
});

test("compiles aliased DELETE for strict MySQL and opt-in MariaDB", () => {
  const person = alias(users, "person");

  expect(
    Effect.runSync(
      mysql.deleteFrom(person).where(eq(person.c.id, 9)).compile("mysql")
    )
  ).toEqual({
    params: [9],
    sql: "DELETE `person` FROM `users` AS `person` WHERE (`person`.`id` = ?)",
  });
  expect(
    Effect.runSync(
      mysql.mariadb
        .deleteFrom(person)
        .where(eq(person.c.id, 9))
        .returning({ id: person.c.id })
        .compile("mysql")
    )
  ).toEqual({
    params: [9],
    sql: "DELETE FROM `users` WHERE (`users`.`id` = ?) RETURNING `users`.`id` AS `__eqb_0`",
  });
  expect(
    Effect.runSync(
      mysql.mariadb
        .insertInto(users)
        .values({
          active: false,
          count: 1,
          createdAt: time,
          id: UserId.make(9),
          profile: { tag: "guest" },
          updatedAt: time,
        })
        .returning({ id: users.c.id })
        .compile("mysql")
    )
  ).toEqual({
    params: [0, 1, iso, 9, '{"tag":"guest"}', iso],
    sql: "INSERT INTO `users` (`active`, `count`, `created_at`, `id`, `profile`, `updated_at`) VALUES (?, ?, ?, ?, ?, ?) RETURNING `users`.`id` AS `__eqb_0`",
  });
});

test("uses database defaults and encodes decoded values beside INSERT expressions", () => {
  using database = new Database(":memory:");
  const sql = makeClient(database);

  const settings = Table.fromSchema(
    "settings",
    Schema.Struct({
      id: Schema.Int,
      hits: Schema.Int,
      label: Schema.String,
    }),
    {
      columns: {
        hits: { default: "7" },
        id: { generated: true },
        label: { default: "'base'" },
      },
    }
  );

  database.run(
    "CREATE TABLE settings (id INTEGER PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 7, label TEXT NOT NULL DEFAULT 'base')"
  );

  const result = Effect.runSync(
    Effect.gen(function* writes() {
      const omitted = yield* insertInto(settings).values({}).returning();

      const expressed = yield* insertInto(settings)
        .values({
          hits: raw(Schema.Int, sql`${8} + ${1}`),
          label: "expression",
        })
        .returning();

      return [...omitted, ...expressed];
    }).pipe(Effect.provideService(SqlClient.SqlClient, sql))
  );

  expect(result).toEqual([
    { id: 1, hits: 7, label: "base" },
    { id: 2, hits: 9, label: "expression" },
  ]);
});

test("rejects a scoped write on a mismatched client before it sends SQL", () => {
  using database = new Database(":memory:");
  const received: string[] = [];

  const sql = makeClient(database, (text) => {
    received.push(text);
  });

  const error = Effect.runSync(
    Effect.flip(
      Effect.provideService(pg.deleteFrom(users), SqlClient.SqlClient, sql)
    )
  );

  expect(error.message).toContain(
    "DELETE scoped to pg is unsupported by the sqlite dialect"
  );
  expect(received).toEqual([]);
});

test("checks decoded insert rows and rejects a SQL expression that would bypass a whole-row check", () => {
  using database = new Database(":memory:");
  const received: string[] = [];

  const sql = makeClient(database, (text) => {
    received.push(text);
  });

  const ranges = Table.fromSchema(
    "ranges",
    Schema.Struct({
      first: Schema.Int,
      last: Schema.Int,
    }).check(
      Schema.makeFilter(
        ({ first, last }) => first <= last || "Range is reversed"
      )
    )
  );

  const invalid = insertInto(ranges).values({ first: 10, last: 7 });

  const expression = insertInto(ranges).values({
    first: raw(Schema.Int, sql`${10}`),
    last: 7,
  });

  expect(
    Effect.runSync(
      Effect.flip(Effect.provideService(invalid, SqlClient.SqlClient, sql))
    )._tag
  ).toBe("SchemaError");
  expect(
    Effect.runSync(
      Effect.flip(Effect.provideService(expression, SqlClient.SqlClient, sql))
    )._tag
  ).toBe("WriteInputError");
  expect(received).toEqual([]);
});

test("preserves separate database defaults in bulk on PostgreSQL and reports the SQLite limitation", () => {
  const settings = Table.fromSchema(
    "settings",
    Schema.Struct({
      id: Schema.Int,
      hits: Schema.Int,
    }),
    { columns: { hits: { default: "7" } } }
  );

  const batch = [{ id: 1 }, { id: 2, hits: 10 }];
  const query = insertInto(settings).values(batch);
  expect(Effect.runSync(query.compile("pg"))).toEqual({
    params: [1, 2, 10],
    sql: 'INSERT INTO "settings" ("id", "hits") VALUES ($1, DEFAULT), ($2, $3)',
  });
  expect(
    Effect.runSync(Effect.flip(query.compile("sqlite"))).message
  ).toContain("DEFAULT in VALUES is unsupported");
});
