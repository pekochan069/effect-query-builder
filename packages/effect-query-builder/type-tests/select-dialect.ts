import { Schema } from "effect";
import type { Effect } from "effect";
import { and, desc, eq, from, select, Table } from "effect-query-builder";
import * as mysql from "effect-query-builder/mysql";
import * as pg from "effect-query-builder/pg";
import * as sqlite from "effect-query-builder/sqlite";
import type { SqlClient } from "effect/sql";

const documents = Table.fromSchema(
  "documents",
  Schema.Struct({
    id: Schema.Int,
    name: Schema.String,
    payload: Schema.String,
  })
);

const folders = Table.fromSchema("folders", Schema.Struct({ id: Schema.Int }));

const pgPredicate = pg.ilike(documents.c.name, "d%");
const sqlitePredicate = eq(sqlite.jsonType(documents.c.payload), "object");

const inferService = <
  Query extends Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
>(
  query: Query
) => query;

export const pgQuery = inferService(from(documents).where(pgPredicate));
export const mysqlQuery = inferService(mysql.from(documents).forUpdate());

export const sqliteQuery = inferService(
  sqlite.from(documents).where(sqlitePredicate)
);

export const checkDialectTypes = () => {
  // @ts-expect-error MySQL queries do not accept PostgreSQL expressions.
  mysql.from(documents).where(pgPredicate);
  // @ts-expect-error PostgreSQL queries do not accept SQLite ordering expressions.
  pg.from(documents).orderBy(desc(sqlite.jsonType(documents.c.payload)));
  // @ts-expect-error A predicate cannot combine PostgreSQL and SQLite expressions.
  and(pgPredicate, sqlitePredicate);
  // @ts-expect-error A projection cannot combine PostgreSQL and SQLite expressions.
  select({ left: pgPredicate, right: sqlitePredicate });
  // @ts-expect-error A join cannot combine PostgreSQL and SQLite expressions.
  sqlite.from(documents).innerJoin(folders, pgPredicate);
  // @ts-expect-error MySQL does not support FULL OUTER JOIN.
  mysql.from(documents).fullJoin(folders, eq(documents.c.id, folders.c.id));
  // @ts-expect-error CTEs must be compatible with the outer dialect.
  mysql.withCte("pg_documents", pgQuery);
  // @ts-expect-error Set operands must have a common dialect.
  pgQuery.unionAll(mysqlQuery);
  // @ts-expect-error SQLite does not support FOR UPDATE.
  sqlite.from(documents).forUpdate();
  // @ts-expect-error FROM cannot introduce an incompatible source.
  mysql.from(pgQuery.as("pg_documents"));
  // @ts-expect-error A PostgreSQL expression narrows a portable SELECT to PostgreSQL.
  pgQuery.compile("mysql");
};
