import { Schema } from "effect";
import type { Effect, Types } from "effect";
import { add, insertInto, Table } from "effect-query-builder";
import * as mysql from "effect-query-builder/mysql";
import * as pg from "effect-query-builder/pg";
import * as sqlite from "effect-query-builder/sqlite";
import type { SqlClient } from "effect/sql";

const totals = Table.fromSchema(
  "totals",
  Schema.Struct({
    id: Schema.Int,
    hitCount: Schema.Int,
    match: Schema.Boolean,
    label: Schema.String,
  })
);

const row = { id: 1, hitCount: 2, match: true, label: "bob" };
const insert = insertInto(totals).values(row);

const pgUpsert = insert.onConflictDoUpdate("id", ({ target, incoming }) => ({
  hitCount: add(incoming("hitCount"), target.c.hitCount),
  match: pg.ilike(target.c.label, "b%"),
}));

const mysqlUpsert = insert.onDuplicateKeyUpdate({ hitCount: 3 });

const strictMysqlInsert = mysql.insertInto(totals).values(row);
const postgresInsert = pg.insertInto(totals).values(row);
const sqliteInsert = sqlite.insertInto(totals).values(row);
const pgPredicate = pg.ilike(totals.c.label, "b%");
const returnedInsert = insert.returning();
const returnedPgUpsert = pgUpsert.returning();

const mariaUpsert = mysql.mariadb
  .insertInto(totals)
  .values(row)
  .returning({ hits: totals.c.hitCount })
  .onDuplicateKeyUpdate(({ incoming }) => ({ hitCount: incoming("hitCount") }));

type Verify<Condition extends true> = Condition;

export type PostgresPatchNarrowsDialect = Verify<
  Types.Equals<Parameters<typeof pgUpsert.compile>[0], "pg">
>;

export type MysqlPatchNarrowsDialect = Verify<
  Types.Equals<Parameters<typeof mysqlUpsert.compile>[0], "mysql">
>;

export type MariaUpsertRow = Verify<
  Types.Equals<
    Effect.Success<typeof mariaUpsert>,
    readonly { readonly hits: number }[]
  >
>;

export type MariaUpsertService = Verify<
  Types.Equals<Effect.Services<typeof mariaUpsert>, SqlClient.SqlClient>
>;

type HasMethod<Q, Key extends string> = Key extends keyof Q ? true : false;

export type NoMysqlConflict = Verify<
  Types.Equals<
    HasMethod<typeof strictMysqlInsert, "onConflictDoNothing">,
    false
  >
>;

export type NoPostgresDuplicateKey = Verify<
  Types.Equals<HasMethod<typeof postgresInsert, "onDuplicateKeyUpdate">, false>
>;

export type NoDuplicateKeyWithReturning = Verify<
  Types.Equals<HasMethod<typeof returnedInsert, "onDuplicateKeyUpdate">, false>
>;

export type NoReturningOnStrictMysql = Verify<
  Types.Equals<HasMethod<typeof mysqlUpsert, "returning">, false>
>;

export type NoSecondConflictClause = Verify<
  Types.Equals<HasMethod<typeof returnedPgUpsert, "onConflictDoNothing">, false>
>;

export const rejectIncompatibleUpserts = () => {
  // @ts-expect-error PostgreSQL expressions cannot be used in a SQLite patch.
  sqliteInsert.onConflictDoUpdate("id", { match: pgPredicate });
  // @ts-expect-error Use logical column keys in the conflict target.
  insert.onConflictDoNothing("missing");
  // @ts-expect-error DO UPDATE needs a target column.
  insert.onConflictDoUpdate([], { hitCount: 5 });
  // @ts-expect-error SQL expression values must match the target encoding.
  insert.onConflictDoUpdate("id", ({ incoming }) => ({
    hitCount: incoming("label"),
  }));
};
