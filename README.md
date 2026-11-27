# effect-query-builder

A query builder for Effect SQL. The compiler kernel emits SQL and bind values for PostgreSQL, SQLite, and MySQL without opening a connection.

## Write queries

Build writes with `insertInto(table).values(rowOrRows)`, `update(table).set(patch)`, and `deleteFrom(table)`. Use `.where(predicate)` on updates and deletes. Writes are Effects that use `SqlClient`. Running `.compile(dialect)` as an Effect encodes the inputs and returns SQL and binds without a client.

```ts
import { Schema } from "effect";
import { add, Table } from "effect-query-builder";
import { insertInto } from "effect-query-builder/pg";

const counters = Table.fromSchema(
  "counters",
  Schema.Struct({ id: Schema.Int, hits: Schema.Int }),
  { primaryKey: "id" }
);

const upsert = insertInto(counters)
  .values({ id: 1, hits: 3 })
  .onConflictDoUpdate("id", ({ target, incoming }) => ({
    hits: add(target.c.hits, incoming("hits")),
  }))
  .returning({ hits: counters.c.hits });
```

For `INSERT … SELECT`, call `.fromSelect(query)` and give each scalar projection the logical key of its destination column. In SQLite, every row in a bulk batch must supply the same nonempty set of columns. SQLite rejects `DEFAULT VALUES` with `ON CONFLICT`. [SQLite `INSERT` syntax](https://www.sqlite.org/lang_insert.html)

The `/pg`, `/sqlite`, and `/mysql` entry points scope builders to those dialects. PostgreSQL and SQLite support `.onConflictDoNothing()` and `.onConflictDoUpdate(target, patch)`. MySQL supports `.onDuplicateKeyUpdate(patch)`. Use `.returning()` to decode the full table row or pass a projection to decode selected fields. The `mariadb` export from `/mysql` enables `INSERT … RETURNING` and `DELETE … RETURNING` on MariaDB 10.5 or later. [MariaDB 10.5 release notes](https://mariadb.com/docs/release-notes/community-server/old-releases/10.5/what-is-mariadb-105)

## Development

```bash
bun install
bun run check-types
bun run check
bun test
```

## Verify the compiler kernel

Install Node.js and [Dafny 4.11.0](https://github.com/dafny-lang/dafny/releases/tag/v4.11.0), then run these commands from the repository root.

```bash
npm install --global lemmascript@0.6.14
lsc check --backend=dafny
```

The Dafny proof checks the kernel functions the compiler calls. Identifier delimiters are paired inside quotes, bind tokens produce one placeholder and one parameter in order, and distinct projection indices produce distinct aliases. The capability proof checks `FULL OUTER JOIN` and `RETURNING` for each dialect profile.

SQLite `RIGHT JOIN` and `FULL OUTER JOIN` require version 3.39 or later. [SQLite 3.39 release notes](https://sqlite.org/releaselog/3_39_0.html)

After editing the annotated TypeScript, use `lsc regen --backend=dafny --extra-flags=--isolate-assertions packages/effect-query-builder/src/kernel/invariants.ts` to update the generated Dafny while carrying over the proof.
