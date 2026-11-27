import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { Effect } from "effect";
import { Statement } from "effect/sql";

import type { SelectStatement } from "../src/kernel/ast.ts";
import { compileSelect, toSelectFragment } from "../src/select-compiler.ts";

const sql = Statement.make(
  Effect.die("Offline constructor"),
  Statement.makeCompilerSqlite(),
  [],
  undefined
);

test("interleaves raw, subquery, and typed binds in native fragments", () => {
  const query: SelectStatement<Statement.Fragment> = {
    kind: "select",
    projections: [
      { alias: "before", expression: { kind: "parameter", value: "before" } },
      {
        alias: "raw",
        expression: { kind: "raw", value: sql`${"inner"} || '?' || ${"raw"}` },
      },
      {
        alias: "after",
        expression: {
          kind: "subquery",
          query: {
            kind: "select",
            projections: [
              { expression: { kind: "parameter", value: "after" } },
            ],
          },
        },
      },
    ],
  };

  expect(compileSelect(query, "pg")).toEqual({
    params: ["before", "inner", "raw", "after"],
    sql: `SELECT $1 AS "before", $2 || '?' || $3 AS "raw", (SELECT $4 AS "__eqb_0") AS "after"`,
  });

  expect(
    sql`SELECT ${"prefix"}, e.* FROM (${toSelectFragment(query)}) e WHERE ${"suffix"}`.compile()
  ).toEqual([
    `SELECT ?, e.* FROM (SELECT ? AS "before", ? || '?' || ? AS "raw", (SELECT ? AS "__eqb_0") AS "after") e WHERE ?`,
    ["prefix", "before", "inner", "raw", "after", "suffix"],
  ]);
});

test("compiles empty IN and NOT IN as portable boolean predicates", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [
      {
        expression: {
          kind: "in",
          operand: { kind: "parameter", value: null },
          values: [],
        },
      },
      {
        expression: {
          kind: "in",
          operand: { kind: "parameter", value: null },
          values: [],
          negate: true,
        },
      },
    ],
  };

  for (const dialect of ["pg", "sqlite", "mysql"] as const) {
    const { params, sql: compiled } = compileSelect(query, dialect);
    expect(params).toEqual([]);
    expect(compiled).toContain("(1 = 0)");
    expect(compiled).toContain("(1 = 1)");
  }
});

test("executes chained sets with operand limits and stable output names", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [
      {
        alias: "value",
        expression: { kind: "column", name: "id", table: "items" },
      },
    ],
    from: { relation: { kind: "table", name: { name: "items" } } },
    orderBy: [
      {
        direction: "asc",
        expression: { kind: "column", name: "id", table: "items" },
      },
    ],
    offset: 1,
    sets: [
      {
        operator: "UNION",
        query: {
          kind: "select",
          projections: [{ expression: { kind: "numberLiteral", value: 4 } }],
        },
      },
      {
        operator: "INTERSECT",
        query: {
          kind: "select",
          projections: [{ expression: { kind: "numberLiteral", value: 3 } }],
        },
      },
    ],
  };

  using db = new Database(":memory:");
  db.run("CREATE TABLE items (id INTEGER)");
  db.run("INSERT INTO items VALUES (1), (2), (3)");
  expect(db.query(compileSelect(query, "sqlite").sql).all()).toEqual([
    { value: 3 },
  ]);
});

test("marks present rows including null-only rows with quoted names", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [
      {
        alias: "present",
        expression: {
          kind: "column",
          name: "present_marker",
          table: "present_marker",
        },
      },
      {
        alias: "missing",
        expression: {
          kind: "column",
          name: "missing_marker",
          table: "missing_marker",
        },
      },
      {
        alias: "value",
        expression: {
          kind: "column",
          name: "value.dot",
          table: 'posts."new`',
        },
      },
    ],
    from: {
      relation: {
        kind: "table",
        name: { name: 'posts."new`' },
        presence: "present_marker",
      },
      joins: [
        {
          kind: "left",
          relation: {
            kind: "subquery",
            query: {
              kind: "select",
              projections: [{ expression: { kind: "nullLiteral" } }],
            },
            alias: "missing",
            presence: "missing_marker",
          },
          on: { kind: "booleanLiteral", value: false },
        },
      ],
    },
  };

  using db = new Database(":memory:");
  db.run('CREATE TABLE "posts.""new`" ("value.dot" INTEGER)');
  db.run('INSERT INTO "posts.""new`" VALUES (NULL)');
  expect(db.query(compileSelect(query, "sqlite").sql).all()).toEqual([
    { missing: null, present: 1, value: null },
  ]);
  expect(compileSelect(query, "mysql").sql).toContain(
    '`posts."new```.`value.dot`'
  );
});
