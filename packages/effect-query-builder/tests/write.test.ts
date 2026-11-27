import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { DateTime, Effect, Result, Schema, Stream } from "effect";
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
  select,
  Table,
  update,
} from "../src/index.ts";
import type { Expression } from "../src/index.ts";
import * as mysql from "../src/mysql.ts";
import * as pg from "../src/pg.ts";
import * as sqlite from "../src/sqlite.ts";

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
    sql: 'INSERT INTO "destination" ("object_id", "payload_text") SELECT ("source"."item" + $1) AS "__eqb_0", "source"."payload" AS "__eqb_1" FROM "source" WHERE ("source"."item" = $2) RETURNING "destination"."object_id" AS "__eqb_0", "destination"."payload_text" AS "__eqb_1"',
  });
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, sql))
  ).toEqual([{ objectId: 5, payloadText: "copy" }]);
});

test("lets PostgreSQL infer an INSERT SELECT parameter from its destination column", () => {
  const numbers = Table.fromSchema(
    "numbers",
    Schema.Struct({ value: Schema.Int })
  );

  const value = raw(Schema.Int, Statement.fragment([Statement.parameter(42)]));
  const query = pg.insertInto(numbers).fromSelect(select({ value }));

  expect(Effect.runSync(query.compile("pg"))).toEqual({
    params: [42],
    sql: 'INSERT INTO "numbers" ("value") SELECT ($1) AS "__eqb_0"',
  });
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

test("rejects INSERT SELECT that would bypass a whole-row check before sending SQL", () => {
  using database = new Database(":memory:");
  const received: string[] = [];

  const sql = makeClient(database, (text) => {
    received.push(text);
  });

  const fields = Schema.Struct({ first: Schema.Int, last: Schema.Int });
  const source = Table.fromSchema("source", fields);

  const destination = Table.fromSchema(
    "destination",
    fields.check(Schema.makeFilter(({ first, last }) => first <= last))
  );

  database.run("CREATE TABLE source (first INTEGER, last INTEGER)");
  database.run("CREATE TABLE destination (first INTEGER, last INTEGER)");
  database.run("INSERT INTO source VALUES (10, 7)");

  const query = insertInto(destination).fromSelect(from(source));

  const result = Effect.runSync(
    Effect.result(Effect.provideService(query, SqlClient.SqlClient, sql))
  );

  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "WriteInputError" },
  });
  expect(received).toEqual([]);
  expect(database.query("SELECT * FROM destination").all()).toEqual([]);
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

test("omits undefined optional encodings and rejects undefined required encodings", () => {
  using database = new Database(":memory:");
  const client = makeClient(database);

  const settings = Table.fromSchema(
    "settings",
    Schema.Struct({ id: Schema.Int, label: Schema.optional(Schema.String) })
  );

  database.run("CREATE TABLE settings (id INTEGER, label TEXT DEFAULT 'base')");

  const query = insertInto(settings).values({ id: 1, label: undefined });

  expect(
    Effect.runSync(
      Effect.result(Effect.provideService(query, SqlClient.SqlClient, client))
    )
  ).toEqual(Result.succeed(undefined));
  expect(database.query("SELECT * FROM settings").all()).toEqual([
    { id: 1, label: "base" },
  ]);

  const unsafe = Table.fromSchema(
    "unsafe",
    Schema.Struct({ value: Schema.Undefined })
  );

  expect(
    Effect.runSync(
      Effect.result(
        insertInto(unsafe).values({ value: undefined }).compile("pg")
      )
    )
  ).toMatchObject({
    _tag: "Failure",
    failure: {
      _tag: "WriteInputError",
      message: "Column value cannot bind undefined",
    },
  });
});

const totals = Table.withNaming("snake_case").fromSchema(
  "totals",
  Schema.Struct({ itemId: Schema.Int, hitCount: Schema.Int })
);

test("snapshots rows, patches, and conflict keys when composing a write", () => {
  const row = { itemId: 1, hitCount: 2 };
  const batch = [row];
  const patch = { hitCount: 3 };
  const target: ["itemId" | "hitCount"] = ["itemId"];

  const insertQuery = insertInto(totals).values(row);
  const batchQuery = insertInto(totals).values(batch);
  const updateQuery = update(totals).set(patch);
  const upsert = insertQuery.onConflictDoUpdate(target, patch);
  const duplicate = insertQuery.onDuplicateKeyUpdate(patch);

  row.hitCount = 20;
  batch.push({ itemId: 2, hitCount: 30 });
  patch.hitCount = 40;
  target[0] = "hitCount";

  expect(Effect.runSync(insertQuery.compile("pg")).params).toEqual([1, 2]);
  expect(Effect.runSync(batchQuery.compile("pg")).params).toEqual([1, 2]);
  expect(Effect.runSync(updateQuery.compile("pg")).params).toEqual([3]);
  expect(Effect.runSync(upsert.compile("pg"))).toEqual({
    params: [1, 2, 3],
    sql: 'INSERT INTO "totals" ("item_id", "hit_count") VALUES ($1, $2) ON CONFLICT ("item_id") DO UPDATE SET "hit_count" = $3',
  });
  expect(Effect.runSync(duplicate.compile("mysql")).params).toEqual([1, 2, 3]);
});

test("ignores existing rows by logical conflict target and returns only inserted rows", () => {
  using database = new Database(":memory:");
  database.run(
    "CREATE TABLE totals (item_id INTEGER PRIMARY KEY, hit_count INTEGER NOT NULL)"
  );
  database.run("INSERT INTO totals VALUES (1, 2)");
  const client = makeClient(database);

  const query = sqlite
    .insertInto(totals)
    .values([
      { itemId: 1, hitCount: 7 },
      { itemId: 2, hitCount: 9 },
    ])
    .onConflictDoNothing("itemId")
    .returning();

  expect(Effect.runSync(query.compile("sqlite")).sql).toContain(
    'ON CONFLICT ("item_id") DO NOTHING RETURNING'
  );
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, client))
  ).toEqual([{ itemId: 2, hitCount: 9 }]);
  expect(database.query("SELECT * FROM totals ORDER BY item_id").all()).toEqual(
    [
      { item_id: 1, hit_count: 2 },
      { item_id: 2, hit_count: 9 },
    ]
  );
});

test("updates conflicts from INSERT SELECT with existing and incoming values", () => {
  using database = new Database(":memory:");
  database.run(
    "CREATE TABLE totals (item_id INTEGER PRIMARY KEY, hit_count INTEGER NOT NULL)"
  );
  database.run("INSERT INTO totals VALUES (1, 2)");
  database.run("CREATE TABLE stage (item_id INTEGER, hit_count INTEGER)");
  database.run("INSERT INTO stage VALUES (1, 7), (2, 9)");
  const client = makeClient(database);

  const stage = Table.withNaming("snake_case").fromSchema(
    "stage",
    totals.select
  );

  const source = from(stage).select({
    itemId: stage.c.itemId,
    hitCount: add(stage.c.hitCount, 3),
  });

  const query = insertInto(totals)
    .fromSelect(source)
    .returning({ hits: totals.c.hitCount })
    .onConflictDoUpdate(["itemId"], ({ incoming, target }) => ({
      hitCount: add(add(target.c.hitCount, incoming("hitCount")), 5),
    }));

  expect(Effect.runSync(query.compile("pg"))).toEqual({
    params: [3, 5],
    sql: 'INSERT INTO "totals" ("hit_count", "item_id") SELECT ("stage"."hit_count" + $1) AS "__eqb_0", "stage"."item_id" AS "__eqb_1" FROM "stage" ON CONFLICT ("item_id") DO UPDATE SET "hit_count" = (("totals"."hit_count" + "excluded"."hit_count") + $2) RETURNING "totals"."hit_count" AS "__eqb_0"',
  });
  expect(
    Effect.runSync(
      query.pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.map((rows) =>
          rows.map(({ hits }) => hits).toSorted((left, right) => left - right)
        ),
        Effect.result
      )
    )
  ).toEqual(Result.succeed([12, 17]));
  expect(database.query("SELECT * FROM totals ORDER BY item_id").all()).toEqual(
    [
      { item_id: 1, hit_count: 17 },
      { item_id: 2, hit_count: 12 },
    ]
  );
});

test("encodes duplicate-key patches for MySQL and keeps MariaDB INSERT RETURNING", () => {
  const counters = Table.withNaming("snake_case").fromSchema(
    "counters",
    Schema.Struct({
      itemId: Schema.Int,
      enabled: Schema.BooleanFromBit,
      hitCount: Schema.Int,
    })
  );

  const row = { itemId: 1, enabled: true, hitCount: 4 };

  const strict = mysql
    .insertInto(counters)
    .values(row)
    .onDuplicateKeyUpdate(({ incoming, target }) => ({
      enabled: false,
      hitCount: add(target.c.hitCount, incoming("hitCount")),
    }));

  const maria = mysql.mariadb
    .insertInto(counters)
    .values(row)
    .onDuplicateKeyUpdate(({ incoming }) => ({
      hitCount: incoming("hitCount"),
      enabled: false,
    }))
    .returning({ enabled: counters.c.enabled });

  expect(Effect.runSync(strict.compile("mysql"))).toEqual({
    params: [1, 1, 4, 0],
    sql: "INSERT INTO `counters` (`item_id`, `enabled`, `hit_count`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `enabled` = ?, `hit_count` = (`counters`.`hit_count` + VALUES(`hit_count`))",
  });
  expect(Effect.runSync(maria.compile("mysql"))).toEqual({
    params: [1, 1, 4, 0],
    sql: "INSERT INTO `counters` (`item_id`, `enabled`, `hit_count`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `enabled` = ?, `hit_count` = VALUES(`hit_count`) RETURNING `counters`.`enabled` AS `__eqb_0`",
  });
});

test("distinguishes the incoming row from a table named excluded", () => {
  using database = new Database(":memory:");
  database.run(
    "CREATE TABLE excluded (item_id INTEGER PRIMARY KEY, hit_count INTEGER)"
  );
  database.run("INSERT INTO excluded VALUES (1, 2)");
  const client = makeClient(database);

  const excluded = Table.withNaming("snake_case").fromSchema(
    "excluded",
    totals.select
  );

  const query = insertInto(excluded)
    .values({ itemId: 1, hitCount: 8 })
    .onConflictDoUpdate("itemId", ({ incoming, target }) => ({
      hitCount: add(target.c.hitCount, incoming("hitCount")),
    }))
    .returning({ hits: excluded.c.hitCount });

  expect(Effect.runSync(query.compile("pg")).sql).toBe(
    'INSERT INTO "excluded" AS "__eqb_insert_target" ("item_id", "hit_count") VALUES ($1, $2) ON CONFLICT ("item_id") DO UPDATE SET "hit_count" = ("__eqb_insert_target"."hit_count" + "excluded"."hit_count") RETURNING "__eqb_insert_target"."hit_count" AS "__eqb_0"'
  );
  expect(
    Effect.runSync(Effect.provideService(query, SqlClient.SqlClient, client))
  ).toEqual([{ hits: 10 }]);
});

test("fails invalid conflict input before sending a statement", () => {
  const generated = Table.fromSchema(
    "generated",
    Schema.Struct({ id: Schema.Int }),
    {
      columns: { id: { generated: true } },
    }
  );

  const defaultOnly = sqlite
    .insertInto(generated)
    .values({})
    .onConflictDoNothing();

  const duplicateTarget = pg
    .insertInto(totals)
    .values({ itemId: 1, hitCount: 2 })
    .onConflictDoNothing(["itemId", "itemId"]);

  const noAssignments = pg
    .insertInto(totals)
    .values({ itemId: 1, hitCount: 2 })
    .onConflictDoUpdate("itemId", {});

  expect(
    Effect.runSync(Effect.result(defaultOnly.compile("sqlite")))
  ).toMatchObject({
    _tag: "Failure",
    failure: {
      message:
        "Upsert with default-only INSERT is unsupported by the sqlite dialect profile",
    },
  });
  expect(
    Effect.runSync(Effect.result(duplicateTarget.compile("pg")))
  ).toMatchObject({
    _tag: "Failure",
    failure: { message: "A conflict target needs distinct columns" },
  });
  expect(
    Effect.runSync(Effect.result(noAssignments.compile("pg")))
  ).toMatchObject({
    _tag: "Failure",
    failure: { message: "DO UPDATE requires at least one assignment" },
  });
});

test("rejects an incoming column inside a MySQL scalar subquery", () => {
  const maybeTotals = Table.fromSchema(
    "maybe_totals",
    Schema.Struct({
      itemId: Schema.Int,
      hitCount: Schema.NullOr(Schema.Int),
    })
  );

  const query = mysql
    .insertInto(maybeTotals)
    .values({ itemId: 1, hitCount: 7 })
    .onDuplicateKeyUpdate(({ incoming }) => ({
      hitCount: from(maybeTotals)
        .select({ hits: incoming("hitCount") })
        .scalar("hits"),
    }));

  expect(Effect.runSync(Effect.result(query.compile("mysql")))).toMatchObject({
    _tag: "Failure",
    failure: { message: "Incoming columns require an upsert assignment" },
  });
});

test("rejects an incoming column captured from an upsert targeting a different table", () => {
  using database = new Database(":memory:");
  const statements: string[] = [];

  const sql = makeClient(database, (text) => {
    statements.push(text);
  });

  const other = Table.withNaming("snake_case").fromSchema(
    "other",
    totals.select
  );

  database.run(
    "CREATE TABLE other (item_id INTEGER PRIMARY KEY, hit_count INTEGER)"
  );
  database.run("INSERT INTO other VALUES (1, 17)");

  let captured: Expression<typeof Schema.Int> | undefined;

  const origin = sqlite
    .insertInto(totals)
    .values({ itemId: 1, hitCount: 2 })
    .onConflictDoUpdate("itemId", ({ incoming }) => {
      const value = incoming("hitCount");
      captured = value;

      return { hitCount: value };
    });

  Effect.runSync(origin.compile("sqlite"));

  if (captured === undefined) {
    throw new Error("Expected the upsert callback to run");
  }

  const query = sqlite
    .insertInto(other)
    .values({ itemId: 1, hitCount: 3 })
    // @ts-expect-error Bypass static scope checks to exercise the runtime guard.
    .onConflictDoUpdate("itemId", { hitCount: captured });

  expect(
    Effect.runSync(
      Effect.result(Effect.provideService(query, SqlClient.SqlClient, sql))
    )
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "WriteInputError" } });
  expect(statements).toEqual([]);
  expect(database.query("SELECT * FROM other").all()).toEqual([
    { item_id: 1, hit_count: 17 },
  ]);
});

test("rejects case-insensitive write column collisions on SQLite and MySQL", () => {
  using database = new Database(":memory:");
  const statements: string[] = [];

  const sql = makeClient(database, (text) => {
    statements.push(text);
  });

  const collision = Table.fromSchema(
    "totals",
    Schema.Struct({ first: Schema.Int, second: Schema.Int }),
    { columns: { first: { name: "Hits" }, second: { name: "HITS" } } }
  );

  database.run('CREATE TABLE totals ("hits" INTEGER)');
  database.run("INSERT INTO totals VALUES (2)");

  const query = update(collision).set({ first: 8, second: 9 });

  expect(
    Effect.runSync(
      Effect.result(Effect.provideService(query, SqlClient.SqlClient, sql))
    )
  ).toMatchObject({ _tag: "Failure", failure: { _tag: "WriteInputError" } });
  expect(statements).toEqual([]);
  expect(database.query("SELECT * FROM totals").all()).toEqual([{ hits: 2 }]);
  expect(Effect.runSync(Effect.result(query.compile("mysql")))).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "WriteInputError" },
  });
  expect(Effect.runSync(query.compile("pg"))).toEqual({
    params: [8, 9],
    sql: 'UPDATE "totals" SET "Hits" = $1, "HITS" = $2',
  });
});
