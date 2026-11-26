import type {
  Expression,
  Join,
  Projection,
  QualifiedName,
  Relation,
  SelectStatement,
  Statement,
} from "./ast.ts";
import {
  projectionAlias,
  quoteWithDoubledDelimiter,
  renderTokens,
  supportsClause,
} from "./invariants.ts";
import type { SqlToken } from "./invariants.ts";

type SqlDialect = "pg" | "sqlite" | "mysql";

type DialectProfile = SqlDialect | "portable" | "mariadb";

type WriteStatement = Extract<
  Statement,
  { kind: "insert" | "update" | "delete" }
>;

type ConditionalClause = "fullJoin" | `${WriteStatement["kind"]}Returning`;

const joinSql = {
  cross: "CROSS JOIN",
  full: "FULL OUTER JOIN",
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
} satisfies Record<Join["kind"], string>;

export type CompileTarget =
  | SqlDialect
  | { readonly dialect: SqlDialect; readonly compatibility: "portable" }
  | { readonly dialect: "mysql"; readonly mariadbReturning: boolean };

class Compiler {
  readonly #dialect: SqlDialect;
  readonly #profile: DialectProfile;
  readonly #tokens: SqlToken[] = [];

  constructor(target: CompileTarget) {
    switch (target) {
      case "pg":
      case "sqlite":
      case "mysql": {
        this.#dialect = target;
        this.#profile = target;
        break;
      }

      default: {
        this.#dialect = target.dialect;

        if ("mariadbReturning" in target) {
          this.#profile = target.mariadbReturning ? "mariadb" : "mysql";
        } else {
          this.#profile = "portable";
        }
      }
    }
  }

  compile(statement: Statement) {
    switch (statement.kind) {
      case "select": {
        this.#select(statement);
        break;
      }

      case "insert": {
        this.#insert(statement);
        break;
      }

      case "update": {
        this.#update(statement);
        break;
      }

      case "delete": {
        this.#delete(statement);
        break;
      }

      case "createTable": {
        this.#createTable(statement);
        break;
      }

      case "dropTable": {
        this.#text(
          statement.ifExists === true ? "DROP TABLE IF EXISTS " : "DROP TABLE "
        );
        this.#qualifiedName(statement.table);
        break;
      }

      default: {
        const unhandled: never = statement;
        throw new TypeError(`Unsupported statement: ${String(unhandled)}`);
      }
    }

    return renderTokens(this.#tokens, this.#dialect === "pg");
  }

  #text(text: string) {
    this.#tokens.push({ kind: "text", text });
  }

  #list<T>(items: readonly T[], write: (item: T) => void) {
    for (const [index, item] of items.entries()) {
      if (index > 0) {
        this.#text(", ");
      }

      write(item);
    }
  }

  #identifier(name: string) {
    if (name.length === 0 || name.includes("\0")) {
      throw new TypeError(
        "SQL identifiers must be non-empty and contain no NUL"
      );
    }

    const delimiter = this.#dialect === "mysql" ? "`" : '"';
    this.#text(quoteWithDoubledDelimiter(name, delimiter));
  }

  #qualifiedName(name: QualifiedName) {
    if (name.schema !== undefined) {
      this.#identifier(name.schema);
      this.#text(".");
    }

    this.#identifier(name.name);
  }

  #stringLiteral(value: string) {
    const hasBackslash = value.includes("\\");
    const hasNul = value.includes("\0");

    if (this.#dialect === "mysql") {
      if (hasBackslash || hasNul || value.includes("\u001A")) {
        const hex = Array.from(new TextEncoder().encode(value), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");

        return `_utf8mb4 X'${hex}'`;
      }
    } else if (hasNul) {
      throw new TypeError(
        `${this.#dialect} string literals cannot contain NUL`
      );
    }

    if (this.#dialect === "pg" && hasBackslash) {
      return `E${quoteWithDoubledDelimiter(value.replaceAll("\\", "\\\\"), "'")}`;
    }

    return quoteWithDoubledDelimiter(value, "'");
  }

  #expression(expression: Expression) {
    switch (expression.kind) {
      case "column": {
        this.#qualifiedName({
          name: expression.name,
          schema: expression.table,
        });

        return;
      }

      case "parameter": {
        this.#tokens.push({ kind: "bind", value: expression.value });

        return;
      }

      case "stringLiteral": {
        this.#text(this.#stringLiteral(expression.value));

        return;
      }

      case "numberLiteral": {
        if (!Number.isFinite(expression.value)) {
          throw new RangeError("Numeric SQL literals must be finite");
        }

        this.#text(String(expression.value));

        return;
      }

      case "booleanLiteral": {
        if (this.#dialect === "sqlite") {
          this.#text(expression.value ? "1" : "0");
        } else {
          this.#text(expression.value ? "TRUE" : "FALSE");
        }

        return;
      }

      case "nullLiteral": {
        this.#text("NULL");

        return;
      }

      case "binary": {
        this.#text("(");
        this.#expression(expression.left);
        this.#text(` ${expression.operator} `);
        this.#expression(expression.right);
        this.#text(")");

        return;
      }

      case "subquery": {
        this.#subquery(expression.query);

        return;
      }

      case "not": {
        this.#text("(NOT ");
        this.#expression(expression.operand);
        this.#text(")");

        return;
      }

      case "nullCheck": {
        this.#text("(");
        this.#expression(expression.operand);
        this.#text(expression.negate === true ? " IS NOT NULL)" : " IS NULL)");

        return;
      }

      default: {
        const unhandled: never = expression;
        throw new TypeError(`Unsupported expression: ${String(unhandled)}`);
      }
    }
  }

  #projections(
    projections: readonly Projection[],
    orderBy?: SelectStatement["orderBy"]
  ) {
    const reserved = new Set<string>();

    const reserve = (name: string) => {
      reserved.add(this.#dialect === "pg" ? name : name.toLowerCase());
    };

    for (const { alias } of projections) {
      if (alias !== undefined) {
        reserve(alias);
      }
    }

    for (const { expression } of orderBy ?? []) {
      if (expression.kind === "column" && expression.table === undefined) {
        reserve(expression.name);
      }
    }

    let nextIndex = 0;
    this.#list(projections, (projection) => {
      let { alias } = projection;

      if (alias === undefined) {
        do {
          alias = projectionAlias(nextIndex);
          nextIndex += 1;
        } while (reserved.has(alias));
      }

      this.#expression(projection.expression);
      this.#text(" AS ");
      this.#identifier(alias);
    });
  }

  #relation(relation: Relation) {
    if (relation.kind === "table") {
      this.#qualifiedName(relation.name);
    } else {
      this.#subquery(relation.query);
    }

    if (relation.alias !== undefined) {
      this.#text(" AS ");
      this.#identifier(relation.alias);
    }
  }

  #requireClause(clause: ConditionalClause, sql: string) {
    if (!supportsClause(this.#profile, clause)) {
      throw new TypeError(
        `${sql} is unsupported by the ${this.#profile} dialect profile`
      );
    }
  }

  #join(join: Join) {
    const keyword = joinSql[join.kind];

    if (join.kind === "full") {
      this.#requireClause("fullJoin", keyword);
    }

    this.#text(` ${keyword} `);
    this.#relation(join.relation);

    if (join.kind !== "cross") {
      this.#text(" ON ");
      this.#expression(join.on);
    }
  }

  #subquery(query: SelectStatement) {
    this.#text("(");
    this.#select(query);
    this.#text(")");
  }

  #predicate(clause: "WHERE" | "HAVING", expression: Expression | undefined) {
    if (expression !== undefined) {
      this.#text(` ${clause} `);
      this.#expression(expression);
    }
  }

  #limitValue(keyword: "LIMIT" | "OFFSET", value: number) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`${keyword} must be a non-negative safe integer`);
    }

    this.#text(` ${keyword} ${value}`);
  }

  #groupOrOrderExpression(expression: Expression) {
    const isLiteral =
      expression.kind === "numberLiteral" ||
      expression.kind === "booleanLiteral" ||
      expression.kind === "stringLiteral" ||
      expression.kind === "nullLiteral";

    if (isLiteral) {
      this.#text("CASE WHEN 1 = 1 THEN ");
    }

    this.#expression(expression);

    if (isLiteral) {
      this.#text(" END");
    }
  }

  #select(query: SelectStatement) {
    if (query.with !== undefined) {
      this.#text("WITH ");
      this.#list(query.with, (cte) => {
        this.#identifier(cte.name);
        this.#text(" AS ");
        this.#subquery(cte.query);
      });
      this.#text(" ");
    }

    this.#text("SELECT ");
    this.#projections(query.projections, query.orderBy);

    if (query.from !== undefined) {
      this.#text(" FROM ");
      this.#relation(query.from.relation);

      for (const join of query.from.joins ?? []) {
        this.#join(join);
      }
    }

    this.#predicate("WHERE", query.where);

    if (query.groupBy !== undefined) {
      this.#text(" GROUP BY ");
      this.#list(query.groupBy, (expression) => {
        this.#groupOrOrderExpression(expression);
      });
    }

    this.#predicate("HAVING", query.having);

    if (query.orderBy !== undefined) {
      this.#text(" ORDER BY ");
      this.#list(query.orderBy, ({ direction, expression }) => {
        this.#groupOrOrderExpression(expression);
        this.#text(direction === "asc" ? " ASC" : " DESC");
      });
    }

    if (query.limit !== undefined) {
      this.#limitValue("LIMIT", query.limit.count);

      if (query.limit.offset !== undefined) {
        this.#limitValue("OFFSET", query.limit.offset);
      }
    }
  }

  #returning(statement: WriteStatement) {
    if (statement.returning !== undefined) {
      this.#requireClause(`${statement.kind}Returning`, "RETURNING");
      this.#text(" RETURNING ");
      this.#projections(statement.returning);
    }
  }

  #insert(statement: Extract<WriteStatement, { kind: "insert" }>) {
    this.#text("INSERT INTO ");
    this.#qualifiedName(statement.table);
    this.#text(" (");
    this.#list(statement.columns, (column) => {
      this.#identifier(column);
    });
    this.#text(") VALUES ");
    this.#list(statement.rows, (row) => {
      if (row.length !== statement.columns.length) {
        throw new TypeError("Each INSERT row must match the column count");
      }

      this.#text("(");
      this.#list(row, (value) => {
        this.#expression(value);
      });
      this.#text(")");
    });
    this.#returning(statement);
  }

  #update(statement: Extract<WriteStatement, { kind: "update" }>) {
    this.#text("UPDATE ");
    this.#qualifiedName(statement.table);
    this.#text(" SET ");
    this.#list(statement.assignments, ({ column, value }) => {
      this.#identifier(column);
      this.#text(" = ");
      this.#expression(value);
    });
    this.#predicate("WHERE", statement.where);
    this.#returning(statement);
  }

  #delete(statement: Extract<WriteStatement, { kind: "delete" }>) {
    this.#text("DELETE FROM ");
    this.#qualifiedName(statement.table);
    this.#predicate("WHERE", statement.where);
    this.#returning(statement);
  }

  #createTable(statement: Extract<Statement, { kind: "createTable" }>) {
    this.#text(
      statement.ifNotExists === true
        ? "CREATE TABLE IF NOT EXISTS "
        : "CREATE TABLE "
    );
    this.#qualifiedName(statement.table);
    this.#text(" (");
    this.#list(statement.columns, ({ name, type, notNull }) => {
      this.#identifier(name);
      this.#text(` ${type}`);

      if (notNull === true) {
        this.#text(" NOT NULL");
      }
    });
    this.#text(")");
  }
}

export const compile = (target: CompileTarget, statement: Statement) =>
  new Compiler(target).compile(statement);
