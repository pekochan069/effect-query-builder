# effect-query-builder

A query builder for Effect SQL. The compiler kernel emits SQL and bind values for PostgreSQL, SQLite, and MySQL without opening a connection.

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

The Dafny proof checks the kernel functions the compiler calls. Identifier delimiters are paired inside quotes, bind tokens produce one placeholder and one parameter in order, and distinct projection indices produce distinct aliases. The capability proof checks the supported clauses for each dialect profile.

SQLite `RIGHT JOIN` and `FULL OUTER JOIN` require version 3.39 or later. [SQLite 3.39 release notes](https://sqlite.org/releaselog/3_39_0.html)

The MariaDB opt-in allows `INSERT ... RETURNING` and `DELETE ... RETURNING` on version 10.5 or later. [MariaDB 10.5 release notes](https://mariadb.com/docs/release-notes/community-server/old-releases/10.5/what-is-mariadb-105)

After editing the annotated TypeScript, use `lsc regen --backend=dafny --extra-flags=--isolate-assertions packages/effect-query-builder/src/kernel/invariants.ts` to update the generated Dafny while carrying over the proof.
