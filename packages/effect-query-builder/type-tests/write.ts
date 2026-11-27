import { Schema } from "effect";
import type { Effect, Types } from "effect";
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
} from "effect-query-builder";
import * as mysql from "effect-query-builder/mysql";
import * as pg from "effect-query-builder/pg";
import * as sqlite from "effect-query-builder/sqlite";
import { Model } from "effect/schema";
import { Statement } from "effect/sql";
import type { SqlClient } from "effect/sql";

const UserId = Schema.Int.pipe(Schema.brand("UserId"));

const accounts = Table.fromSchema(
  "accounts",
  Schema.Struct({ id: UserId, label: Schema.String, count: Schema.Int })
);

const shadow = Table.fromSchema(
  "shadow",
  Schema.Struct({ id: UserId, label: Schema.String, count: Schema.Int })
);

class Account extends Model.Class<Account>("Account")({
  id: UserId,
  label: Schema.String,
  count: Schema.Int,
}) {
  describe() {
    return this.label;
  }
}

const modelAccount = Table.fromModel("model_account", Account);

export const modelCopy = insertInto(accounts).fromSelect(from(modelAccount));

export const derivedModelCopy = insertInto(accounts).fromSelect(
  from(alias(from(modelAccount).as("derived_account"), "aliased_account"))
);

const optionalCounts = Table.fromSchema(
  "optional_counts",
  Schema.Struct({ id: UserId, label: Schema.String, count: Schema.Int }),
  { columns: { count: { default: "0" } } }
);

const nullableSource = Table.fromSchema(
  "nullable",
  Schema.Struct({
    id: UserId,
    label: Schema.NullOr(Schema.String),
    count: Schema.Int,
  })
);

const item = { id: UserId.make(1), label: "name", count: 1 };
const rows = [item, { ...item, id: UserId.make(2) }].map((row) => row);
const scoped = alias(accounts, "scope");
const pgOnly = pg.ilike(accounts.c.label, "name%");
const portableCopy = insertInto(accounts).fromSelect(from(shadow)).returning();
const nullableCopy = from(nullableSource);

const incompatibleCopy = from(shadow).select({
  ...shadow.c,
  label: shadow.c.count,
});

const incompleteCopy = from(shadow).select({ count: shadow.c.count });

const nestedCopy = from(shadow).select({ ...shadow.c, nested: shadow });
const derivedNestedCopy = from(nestedCopy.as("derived_nested"));

const numberFromText = raw(
  Schema.NumberFromString,
  Statement.fragment([Statement.literal("'42'")])
);

const textAsCountCopy = from(shadow).select({
  ...shadow.c,
  count: numberFromText,
});

const pgCopy = pg.from(shadow);

export const textWrite = update(accounts).set({ label: numberFromText });

const sqliteCopiedWithDefault = sqlite
  .insertInto(optionalCounts)
  .fromSelect(from(shadow).select({ label: shadow.c.label, id: shadow.c.id }));

const bulkReturned = insertInto(accounts).values(rows).returning();

const updated = update(scoped)
  .set({ count: add(scoped.c.count, 1) })
  .where((table) => eq(table.c.id, 1))
  .returning({ label: scoped.c.label });

const mariaInserted = mysql.mariadb
  .insertInto(accounts)
  .values(item)
  .returning();

const mariaDeleted = mysql.mariadb
  .deleteFrom(scoped)
  .returning({ count: scoped.c.count });

const pgFiltered = deleteFrom(accounts).where(pgOnly).returning();

type Verify<Condition extends true> = Condition;

type HasReturning<Q> = "returning" extends keyof Q ? true : false;

const mysqlInsert = mysql.insertInto(accounts).values(item);
const mysqlUpdate = mysql.update(accounts).set({ label: "name" });
const mysqlDelete = mysql.deleteFrom(accounts);
const mariaUpdate = mysql.mariadb.update(accounts).set({ label: "name" });

export type NoMysqlInsertReturning = Verify<
  Types.Equals<HasReturning<typeof mysqlInsert>, false>
>;

export type NoMysqlUpdateReturning = Verify<
  Types.Equals<HasReturning<typeof mysqlUpdate>, false>
>;

export type NoMysqlDeleteReturning = Verify<
  Types.Equals<HasReturning<typeof mysqlDelete>, false>
>;

export type NoMariaUpdateReturning = Verify<
  Types.Equals<HasReturning<typeof mariaUpdate>, false>
>;

export type Services = Verify<
  Types.Equals<Effect.Services<typeof updated>, SqlClient.SqlClient>
>;

export type CompileServices = Verify<
  Types.Equals<Effect.Services<ReturnType<typeof bulkReturned.compile>>, never>
>;

export type Selected = Verify<
  Types.Equals<
    Effect.Success<typeof updated>,
    readonly { readonly label: string }[]
  >
>;

export type PortableCopy = Verify<
  Types.Equals<
    Effect.Success<typeof portableCopy>,
    Effect.Success<typeof bulkReturned>
  >
>;

export type SqliteCopyWithDefault = Verify<
  Types.Equals<Parameters<typeof sqliteCopiedWithDefault.compile>[0], "sqlite">
>;

export type MariaInsert = Verify<
  Types.Equals<
    Effect.Success<typeof mariaInserted>,
    Effect.Success<typeof portableCopy>
  >
>;

export type MariaDelete = Verify<
  Types.Equals<
    Effect.Success<typeof mariaDeleted>,
    readonly { readonly count: number }[]
  >
>;

export type PgFiltered = Verify<
  Types.Equals<Parameters<typeof pgFiltered.compile>[0], "pg">
>;

export const rejectedWrites = () => {
  // @ts-expect-error Branded inputs cannot be replaced by unbranded numbers.
  insertInto(accounts).values({ ...item, id: 2 });
  // @ts-expect-error A static empty tuple cannot produce an INSERT.
  insertInto(accounts).values([]);
  // @ts-expect-error An UPDATE expression must produce a value compatible with its target.
  update(accounts).set({ label: add(accounts.c.count, 1) });
  // @ts-expect-error An INSERT value cannot reference the target as a source.
  insertInto(accounts).values({ ...item, count: accounts.c.count });
  // @ts-expect-error An UPDATE cannot address columns outside the target scope.
  update(accounts).set({ count: shadow.c.count });
  // @ts-expect-error A DELETE predicate cannot address columns outside the target scope.
  deleteFrom(accounts).where(eq(shadow.c.id, 1));
  // @ts-expect-error A RETURNING expression cannot address columns outside the target scope.
  deleteFrom(accounts).returning({ id: shadow.c.id });
  // @ts-expect-error A MySQL write cannot use a PostgreSQL predicate.
  mysql.deleteFrom(accounts).where(pgOnly);
  // @ts-expect-error The SELECT and INSERT have incompatible dialects.
  mysql.insertInto(accounts).fromSelect(pgCopy);
  // @ts-expect-error SELECT must provide the required insert columns.
  insertInto(accounts).fromSelect(incompleteCopy);
  // @ts-expect-error SELECT has to contain only scalar projections.
  insertInto(accounts).fromSelect(nestedCopy);
  // @ts-expect-error A derived SELECT has to contain only scalar projections.
  insertInto(accounts).fromSelect(derivedNestedCopy);
  // @ts-expect-error SELECT cannot send a nullable value to a required non-nullable column.
  insertInto(accounts).fromSelect(nullableCopy);
  // @ts-expect-error SELECT cannot send values with incompatible encodings.
  insertInto(accounts).fromSelect(incompatibleCopy);
  // @ts-expect-error SQL emits text even though the raw projection decodes to a number.
  insertInto(accounts).fromSelect(textAsCountCopy);
  // @ts-expect-error SQL emits text even though the raw expression decodes to a number.
  update(accounts).set({ count: numberFromText });
  insertInto(accounts)
    .values(item)
    .onConflictDoUpdate("id", ({ incoming }) => {
      const count = incoming("count");
      // @ts-expect-error An incoming column belongs to its own write target.
      insertInto(shadow).values(item).onConflictDoUpdate("id", { count });

      return { count };
    });
};
