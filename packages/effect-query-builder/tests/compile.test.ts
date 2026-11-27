import { expect, test } from "bun:test";

import type { SelectStatement } from "../src/kernel/ast.ts";
import { compile } from "../src/kernel/compile.ts";

test("compiles the same select for all three SQL dialects", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [{ expression: { kind: "column", name: "title" } }],
    from: { relation: { kind: "table", name: { name: "books" } } },
    where: {
      kind: "binary",
      operator: "=",
      left: { kind: "column", name: "author" },
      right: { kind: "parameter", value: "Octavia Butler" },
    },
  };

  expect(compile("pg", query)).toEqual({
    sql: 'SELECT "title" AS "__eqb_0" FROM "books" WHERE ("author" = $1)',
    params: ["Octavia Butler"],
  });
  expect(compile("sqlite", query)).toEqual({
    sql: 'SELECT "title" AS "__eqb_0" FROM "books" WHERE ("author" = ?)',
    params: ["Octavia Butler"],
  });
  expect(compile("mysql", query)).toEqual({
    sql: "SELECT `title` AS `__eqb_0` FROM `books` WHERE (`author` = ?)",
    params: ["Octavia Butler"],
  });
});

test("emits clauses and nested binds in SQL order", () => {
  const query: SelectStatement = {
    kind: "select",
    limit: 10,
    offset: 2,
    orderBy: [
      { direction: "desc", expression: { kind: "column", name: "tag" } },
    ],
    having: {
      kind: "binary",
      operator: "<>",
      left: { kind: "column", name: "category", table: "s" },
      right: { kind: "parameter", value: "excluded" },
    },
    groupBy: [{ kind: "column", name: "category", table: "s" }],
    where: {
      kind: "binary",
      operator: "=",
      left: { kind: "column", name: "category", table: "s" },
      right: { kind: "parameter", value: "fiction" },
    },
    from: {
      relation: { kind: "table", name: { name: "seed" }, alias: "s" },
      joins: [
        {
          kind: "left",
          relation: {
            kind: "subquery",
            query: {
              kind: "select",
              projections: [
                { alias: "id", expression: { kind: "parameter", value: 7 } },
              ],
            },
            alias: "j",
          },
          on: {
            kind: "binary",
            operator: "=",
            left: { kind: "column", name: "id", table: "j" },
            right: { kind: "parameter", value: 9 },
          },
        },
      ],
    },
    projections: [
      { alias: "tag", expression: { kind: "parameter", value: "new" } },
      {
        alias: "scalar",
        expression: {
          kind: "subquery",
          query: {
            kind: "select",
            projections: [
              { alias: "size", expression: { kind: "parameter", value: 18 } },
            ],
          },
        },
      },
    ],
    with: [
      {
        name: "seed",
        query: {
          kind: "select",
          projections: [
            {
              alias: "category",
              expression: { kind: "parameter", value: "seed" },
            },
          ],
        },
      },
    ],
  };

  expect(compile("pg", query)).toEqual({
    sql:
      'WITH "seed" AS (SELECT $1 AS "category") ' +
      'SELECT $2 AS "tag", (SELECT $3 AS "size") AS "scalar" ' +
      'FROM "seed" AS "s" LEFT JOIN (SELECT $4 AS "id") AS "j" ON ("j"."id" = $5) ' +
      'WHERE ("s"."category" = $6) GROUP BY "s"."category" ' +
      'HAVING ("s"."category" <> $7) ORDER BY "tag" DESC LIMIT 10 OFFSET 2',
    params: ["seed", "new", 18, 7, 9, "fiction", "excluded"],
  });
});

test("quotes identifier and literal text without creating extra binds", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [
      { expression: { kind: "column", name: 'a"`?$1' }, alias: "column" },
      {
        expression: { kind: "stringLiteral", value: "can't?$2" },
        alias: "plain",
      },
      { expression: { kind: "stringLiteral", value: "\\'?" }, alias: "slash" },
      { expression: { kind: "parameter", value: "value" }, alias: "bound" },
    ],
    from: { relation: { kind: "table", name: { name: "books" } } },
  };

  expect(compile("pg", query)).toEqual({
    sql: 'SELECT "a""`?$1" AS "column", \'can\'\'t?$2\' AS "plain", E\'\\\\\'\'?\' AS "slash", $1 AS "bound" FROM "books"',
    params: ["value"],
  });
  expect(compile("sqlite", query)).toEqual({
    sql: 'SELECT "a""`?$1" AS "column", \'can\'\'t?$2\' AS "plain", \'\\\'\'?\' AS "slash", ? AS "bound" FROM "books"',
    params: ["value"],
  });
  expect(compile("mysql", query)).toEqual({
    sql: "SELECT `a\"``?$1` AS `column`, 'can''t?$2' AS `plain`, _utf8mb4 X'5c273f' AS `slash`, ? AS `bound` FROM `books`",
    params: ["value"],
  });
});

test("keeps generated aliases distinct from joined columns and explicit aliases", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [
      { expression: { kind: "column", name: "id", table: "b" } },
      { expression: { kind: "column", name: "id", table: "a" } },
      {
        alias: "__EQB_0",
        expression: { kind: "column", name: "edition", table: "b" },
      },
    ],
    from: {
      relation: { kind: "table", name: { name: "books" }, alias: "b" },
      joins: [
        {
          kind: "cross",
          relation: { kind: "table", name: { name: "authors" }, alias: "a" },
        },
      ],
    },
  };

  expect(
    compile({ dialect: "sqlite", compatibility: "portable" }, query).sql
  ).toBe(
    'SELECT "b"."id" AS "__eqb_1", "a"."id" AS "__eqb_2", "b"."edition" AS "__EQB_0" ' +
      'FROM "books" AS "b" CROSS JOIN "authors" AS "a"'
  );
});

test("keeps generated aliases from shadowing an ORDER BY column", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [{ expression: { kind: "column", name: "label" } }],
    from: { relation: { kind: "table", name: { name: "items" } } },
    orderBy: [
      { expression: { kind: "column", name: "__EQB_0" }, direction: "asc" },
    ],
  };

  expect(compile("sqlite", query)).toEqual({
    sql: 'SELECT "label" AS "__eqb_1" FROM "items" ORDER BY "__EQB_0" ASC',
    params: [],
  });
});

test("keeps GROUP BY and ORDER BY literals as values", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [{ expression: { kind: "numberLiteral", value: 7 } }],
    groupBy: [{ kind: "numberLiteral", value: 0 }],
    orderBy: [
      {
        expression: { kind: "booleanLiteral", value: false },
        direction: "asc",
      },
      { expression: { kind: "stringLiteral", value: "a" }, direction: "desc" },
      { expression: { kind: "nullLiteral" }, direction: "asc" },
    ],
  };

  expect(compile("sqlite", query)).toEqual({
    sql:
      'SELECT 7 AS "__eqb_0" GROUP BY CASE WHEN 1 = 1 THEN 0 END ' +
      "ORDER BY CASE WHEN 1 = 1 THEN 0 END ASC, CASE WHEN 1 = 1 THEN 'a' END DESC, CASE WHEN 1 = 1 THEN NULL END ASC",
    params: [],
  });
  expect(compile("pg", query)).toEqual({
    sql:
      'SELECT 7 AS "__eqb_0" GROUP BY CASE WHEN 1 = 1 THEN 0 END ' +
      "ORDER BY CASE WHEN 1 = 1 THEN FALSE END ASC, CASE WHEN 1 = 1 THEN 'a' END DESC, CASE WHEN 1 = 1 THEN NULL END ASC",
    params: [],
  });
});

test("checks FULL OUTER JOIN support inside a subquery", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [
      {
        expression: {
          kind: "subquery",
          query: {
            kind: "select",
            projections: [
              { expression: { kind: "column", table: "books", name: "id" } },
            ],
            from: {
              relation: { kind: "table", name: { name: "books" } },
              joins: [
                {
                  kind: "full",
                  relation: { kind: "table", name: { name: "authors" } },
                  on: { kind: "booleanLiteral", value: true },
                },
              ],
            },
          },
        },
      },
    ],
  };

  expect(compile("pg", query).sql).toContain(
    'FULL OUTER JOIN "authors" ON TRUE'
  );
  expect(compile("sqlite", query).sql).toContain(
    'FULL OUTER JOIN "authors" ON 1'
  );
  expect(() => compile("mysql", query)).toThrow(
    "FULL OUTER JOIN is unsupported"
  );
  expect(() =>
    compile({ dialect: "mysql", mariadbReturning: true }, query)
  ).toThrow("FULL OUTER JOIN is unsupported");
  expect(() =>
    compile({ dialect: "pg", compatibility: "portable" }, query)
  ).toThrow("FULL OUTER JOIN is unsupported");
});

test("handles NUL according to the SQL token and dialect", () => {
  const query: SelectStatement = {
    kind: "select",
    projections: [{ expression: { kind: "stringLiteral", value: "\0" } }],
  };

  expect(() => compile("pg", query)).toThrow(
    "pg string literals cannot contain NUL"
  );
  expect(() => compile("sqlite", query)).toThrow(
    "sqlite string literals cannot contain NUL"
  );
  expect(compile("mysql", query)).toEqual({
    sql: "SELECT _utf8mb4 X'00' AS `__eqb_0`",
    params: [],
  });
  expect(() =>
    compile("mysql", {
      kind: "select",
      projections: [{ expression: { kind: "column", name: "a\0b" } }],
    })
  ).toThrow("SQL identifiers must be non-empty and contain no NUL");
});
