import { expect, test } from "bun:test";

import type { Statement } from "../src/kernel/ast.ts";
import { compile } from "../src/kernel/compile.ts";
import type { CompileTarget } from "../src/kernel/compile.ts";

const insert: Statement = {
  kind: "insert",
  table: { schema: "library", name: "books" },
  columns: ["title", "edition"],
  rows: [
    [
      { kind: "parameter", value: "Kindred" },
      { kind: "parameter", value: 1 },
    ],
    [
      { kind: "parameter", value: "Parable of the Sower" },
      { kind: "parameter", value: 2 },
    ],
  ],
  returning: [{ expression: { kind: "column", name: "id" }, alias: "id" }],
};

const update: Statement = {
  kind: "update",
  table: { name: "books" },
  assignments: [
    { column: "title", value: { kind: "parameter", value: "Kindred" } },
    { column: "available", value: { kind: "booleanLiteral", value: true } },
  ],
  where: {
    kind: "not",
    operand: { kind: "nullCheck", operand: { kind: "column", name: "id" } },
  },
  returning: [{ expression: { kind: "parameter", value: "changed" } }],
};

const remove: Statement = {
  kind: "delete",
  table: { name: "books" },
  where: {
    kind: "binary",
    operator: "=",
    left: { kind: "column", name: "id" },
    right: { kind: "parameter", value: 7 },
  },
  returning: [{ expression: { kind: "column", name: "id" }, alias: "id" }],
};

test("compiles write statements and keeps values in bind order", () => {
  expect(compile("pg", insert)).toEqual({
    sql: 'INSERT INTO "library"."books" ("title", "edition") VALUES ($1, $2), ($3, $4) RETURNING "id" AS "id"',
    params: ["Kindred", 1, "Parable of the Sower", 2],
  });
  expect(compile("pg", update)).toEqual({
    sql: 'UPDATE "books" SET "title" = $1, "available" = TRUE WHERE (NOT ("id" IS NULL)) RETURNING $2 AS "__eqb_0"',
    params: ["Kindred", "changed"],
  });
  expect(compile("sqlite", remove)).toEqual({
    sql: 'DELETE FROM "books" WHERE ("id" = ?) RETURNING "id" AS "id"',
    params: [7],
  });
});

test("compiles a MySQL write without RETURNING", () => {
  const statement: Statement = {
    kind: "delete",
    table: { name: "books" },
    where: {
      kind: "binary",
      operator: "=",
      left: { kind: "column", name: "id" },
      right: { kind: "parameter", value: 7 },
    },
  };

  expect(compile("mysql", statement)).toEqual({
    sql: "DELETE FROM `books` WHERE (`id` = ?)",
    params: [7],
  });
});

test("compiles structured DDL without bind parameters", () => {
  expect(
    compile("sqlite", {
      kind: "createTable",
      table: { name: "edition" },
      ifNotExists: true,
      columns: [
        { name: "id", type: "INTEGER", notNull: true },
        { name: "published", type: "BOOLEAN" },
        { name: "title", type: "TEXT" },
      ],
    })
  ).toEqual({
    sql: 'CREATE TABLE IF NOT EXISTS "edition" ("id" INTEGER NOT NULL, "published" BOOLEAN, "title" TEXT)',
    params: [],
  });

  expect(
    compile("mysql", {
      kind: "dropTable",
      table: { name: "edition", schema: "library" },
      ifExists: true,
    })
  ).toEqual({ sql: "DROP TABLE IF EXISTS `library`.`edition`", params: [] });
});

test("requires MariaDB opt-in for INSERT and DELETE RETURNING", () => {
  const mariadb = {
    dialect: "mysql",
    mariadbReturning: true,
  } satisfies CompileTarget;

  expect(() => compile("mysql", insert)).toThrow("RETURNING is unsupported");
  expect(() => compile("mysql", update)).toThrow("RETURNING is unsupported");
  expect(() => compile("mysql", remove)).toThrow("RETURNING is unsupported");
  expect(() =>
    compile({ dialect: "mysql", mariadbReturning: false }, insert)
  ).toThrow("RETURNING is unsupported");
  expect(() =>
    compile({ dialect: "pg", compatibility: "portable" }, insert)
  ).toThrow("RETURNING is unsupported");
  expect(compile(mariadb, insert)).toEqual({
    sql: "INSERT INTO `library`.`books` (`title`, `edition`) VALUES (?, ?), (?, ?) RETURNING `id` AS `id`",
    params: ["Kindred", 1, "Parable of the Sower", 2],
  });
  expect(compile(mariadb, remove)).toEqual({
    sql: "DELETE FROM `books` WHERE (`id` = ?) RETURNING `id` AS `id`",
    params: [7],
  });
  expect(() => compile(mariadb, update)).toThrow("RETURNING is unsupported");
});

test("rejects an INSERT row with too few values", () => {
  expect(() =>
    compile("pg", {
      kind: "insert",
      table: { name: "books" },
      columns: ["title", "edition"],
      rows: [[{ kind: "parameter", value: "Kindred" }]],
    })
  ).toThrow("Each INSERT row must match the column count");
});
