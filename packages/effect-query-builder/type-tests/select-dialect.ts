import { Schema, SchemaTransformation } from "effect";
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

const jsonRows = Table.fromSchema(
  "json_rows",
  Schema.Struct({
    integer: Schema.NullOr(Schema.Int),
    payload: Schema.Json,
    text: Schema.NullOr(Schema.String),
  })
);

const jsonbInteger = pg.jsonbGet(jsonRows.c.payload, "number", Schema.Int);

const sqliteInteger = sqlite.jsonExtract(
  documents.c.payload,
  "$.number",
  Schema.NumberFromString
);

const unknownEncoding = Schema.Unknown.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transform<number, unknown>({
      decode: Number,
      encode: (value) => value,
    })
  )
);

const sqliteUnknown = sqlite.jsonExtract(
  jsonRows.c.payload,
  "$.number",
  unknownEncoding
);

export const jsonbDecodedResult = pg
  .from(jsonRows)
  .select({ value: jsonbInteger });

export const jsonbAssignment = pg
  .update(jsonRows)
  .set({ payload: jsonbInteger });

export const sqliteTextCopy = sqlite
  .insertInto(
    Table.fromSchema(
      "text_copy",
      Schema.Struct({ value: Schema.NullOr(Schema.String) })
    )
  )
  .fromSelect(sqlite.from(documents).select({ value: sqliteInteger }));

const integerCopy = Table.fromSchema(
  "integer_copy",
  Schema.Struct({ value: Schema.NullOr(Schema.Int) })
);

export const rejectIncorrectJsonStorage = () => {
  // @ts-expect-error PostgreSQL JSONB extraction returns JSONB to the database.
  pg.update(jsonRows).set({ integer: jsonbInteger });
  sqlite.insertInto(integerCopy).fromSelect(
    // @ts-expect-error SQLite yields text before the extraction decoder runs.
    sqlite.from(documents).select({ value: sqliteInteger })
  );
  // @ts-expect-error Unknown input to a decoder does not guarantee integer SQL storage.
  sqlite.update(jsonRows).set({ integer: sqliteUnknown });
};

export const checkConditionalDialectTypes = (flag: boolean) => {
  const portable = from(documents);
  const operand = flag ? pgQuery : mysqlQuery;
  const source = flag ? pgQuery.as("source") : mysqlQuery.as("source");

  const projection:
    | { matched: typeof pgPredicate }
    | {
        isObject: typeof sqlitePredicate;
      } = flag ? { matched: pgPredicate } : { isObject: sqlitePredicate };

  // @ts-expect-error A conditional SELECT source must work on PostgreSQL in both branches.
  pg.from(source);
  // @ts-expect-error A conditional set operand must work on PostgreSQL in both branches.
  pgQuery.unionAll(operand);
  // @ts-expect-error A conditional CTE must work on PostgreSQL in both branches.
  pg.withCte("source", operand);
  // @ts-expect-error A conditional INSERT source must work on PostgreSQL in both branches.
  pg.insertInto(documents).fromSelect(operand);
  // @ts-expect-error Both alternative projection shapes need a common dialect.
  select(projection);
  // @ts-expect-error Either branch of a predicate must work on PostgreSQL.
  pg.from(documents).where(flag ? pgPredicate : sqlitePredicate);
  // @ts-expect-error Either branch of a predicate must work on PostgreSQL.
  pg.deleteFrom(documents).where(flag ? pgPredicate : sqlitePredicate);
  // @ts-expect-error Either branch of a RETURNING projection must work on PostgreSQL.
  pg.deleteFrom(documents).returning({
    value: flag ? pgPredicate : sqlitePredicate,
  });
  // @ts-expect-error Either branch of SET must work on PostgreSQL.
  pg.update(jsonRows).set({
    text: flag
      ? pg.jsonbText(jsonRows.c.payload, "v")
      : sqlite.jsonType(jsonRows.c.payload),
  });

  pg.withCte("source", flag ? pgQuery : portable);
  pg.from(flag ? pgQuery.as("source") : portable.as("source"));
};
