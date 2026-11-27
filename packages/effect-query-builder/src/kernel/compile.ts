import type {
  Expression,
  Join,
  Projection,
  QualifiedName,
  Relation,
  SelectStatement,
  Statement,
} from "./ast.ts";
import { UnsupportedDialectClauseError } from "./errors.ts";
import {
  projectionAlias,
  quoteWithDoubledDelimiter,
  renderTokens,
  supportsClause,
} from "./invariants.ts";
import type { SqlToken } from "./invariants.ts";

export type SqlDialect = "pg" | "sqlite" | "mysql";

type DialectProfile = SqlDialect | "portable" | "mariadb";

type WriteStatement = Extract<
  Statement,
  { kind: "insert" | "update" | "delete" }
>;

type ConditionalClause = "fullJoin" | `${WriteStatement["kind"]}Returning`;

type CompilerToken<Raw> =
  | SqlToken
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "raw"; readonly value: Raw };

const joinSql = {
  cross: "CROSS JOIN",
  full: "FULL OUTER JOIN",
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
} satisfies Record<Join["kind"], string>;

const offsetOnlyLimit = {
  pg: "",
  portable: " LIMIT 9223372036854775807",
  sqlite: " LIMIT -1",
  mysql: " LIMIT 18446744073709551615",
} satisfies Record<SqlDialect | "portable", string>;

export type CompileTarget =
  | SqlDialect
  | { readonly dialect: SqlDialect; readonly compatibility: "portable" }
  | { readonly dialect: "mysql"; readonly mariadbReturning: boolean };

class Compiler<Raw> {
  readonly #dialect: SqlDialect | undefined;
  readonly #profile: DialectProfile | undefined;
  readonly #write: (token: CompilerToken<Raw>) => void;

  constructor(
    target: CompileTarget | undefined,
    write: (token: CompilerToken<Raw>) => void
  ) {
    this.#write = write;

    switch (target) {
      case undefined: {
        break;
      }

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

  get dialect() {
    return this.#dialect;
  }

  compile(statement: Statement<Raw>) {
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
  }

  #text(text: string) {
    this.#write({ kind: "text", text });
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

    if (this.#dialect === undefined) {
      if (name.includes(".")) {
        throw new TypeError(
          "Use toFragment(dialect) for SQL identifiers containing dots"
        );
      }

      this.#write({ kind: "identifier", name });

      return;
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
    if (this.#dialect === undefined) {
      this.#write({ kind: "bind", value });

      return;
    }

    const hasBackslash = value.includes("\\");
    const hasNul = value.includes("\0");

    if (this.#dialect === "mysql") {
      if (hasBackslash || hasNul || value.includes("\u001A")) {
        const hex = Array.from(new TextEncoder().encode(value), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");

        this.#text(`_utf8mb4 X'${hex}'`);

        return;
      }
    } else if (hasNul) {
      throw new TypeError(
        `${this.#dialect} string literals cannot contain NUL`
      );
    }

    if (this.#dialect === "pg" && hasBackslash) {
      this.#text(
        `E${quoteWithDoubledDelimiter(value.replaceAll("\\", "\\\\"), "'")}`
      );

      return;
    }

    this.#text(quoteWithDoubledDelimiter(value, "'"));
  }

  #numberLiteral(value: number) {
    if (!Number.isFinite(value)) {
      throw new RangeError("Numeric SQL literals must be finite");
    }

    this.#text(String(value));
  }

  #expression(expression: Expression<Raw>) {
    switch (expression.kind) {
      case "column": {
        this.#qualifiedName({
          name: expression.name,
          schema: expression.table,
        });

        return;
      }

      case "parameter": {
        this.#write({ kind: "bind", value: expression.value });

        return;
      }

      case "stringLiteral": {
        this.#stringLiteral(expression.value);

        return;
      }

      case "numberLiteral": {
        this.#numberLiteral(expression.value);

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

      case "in": {
        this.#inPredicate(expression);

        return;
      }

      case "between": {
        this.#text("(");
        this.#expression(expression.operand);
        this.#text(" BETWEEN ");
        this.#expression(expression.lower);
        this.#text(" AND ");
        this.#expression(expression.upper);
        this.#text(")");

        return;
      }

      case "aggregate": {
        this.#aggregate(expression);

        return;
      }

      case "caseWhen": {
        this.#text("CASE WHEN ");
        this.#expression(expression.condition);
        this.#text(" THEN ");
        this.#expression(expression.result);
        this.#text(" END");

        return;
      }

      case "raw": {
        this.#write({ kind: "raw", value: expression.value });

        return;
      }

      default: {
        const unhandled: never = expression;
        throw new TypeError(`Unsupported expression: ${String(unhandled)}`);
      }
    }
  }

  #inPredicate({
    operand,
    values,
    negate,
  }: Extract<Expression<Raw>, { kind: "in" }>) {
    if (!("kind" in values) && values.length === 0) {
      this.#text(negate === true ? "(1 = 1)" : "(1 = 0)");

      return;
    }

    this.#text("(");
    this.#expression(operand);
    this.#text(negate === true ? " NOT IN " : " IN ");

    if ("kind" in values) {
      this.#subquery(values);
    } else {
      this.#text("(");
      this.#list(values, (value) => {
        this.#expression(value);
      });
      this.#text(")");
    }

    this.#text(")");
  }

  #aggregate({
    name,
    operand,
    distinct,
  }: Extract<Expression<Raw>, { kind: "aggregate" }>) {
    this.#text(`${name}(`);

    if (operand === undefined) {
      if (name !== "COUNT" || distinct === true) {
        throw new TypeError(`${name} requires an aggregate operand`);
      }

      this.#text("*");
    } else {
      if (distinct === true) {
        this.#text("DISTINCT ");
      }

      this.#expression(operand);
    }

    this.#text(")");
  }

  #projections(
    projections: readonly Projection<Raw>[],
    orderBy?: SelectStatement<Raw>["orderBy"]
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

  #relation(relation: Relation<Raw>) {
    if (relation.presence !== undefined) {
      this.#text("(");
    }

    if (relation.kind === "table") {
      this.#qualifiedName(relation.name);
    } else {
      this.#subquery(relation.query);
    }

    if (relation.alias !== undefined) {
      this.#alias(relation.alias);
    }

    if (relation.presence !== undefined) {
      this.#text(" CROSS JOIN (SELECT 1 AS ");
      this.#identifier(relation.presence);
      this.#text(")");
      this.#alias(relation.presence);
      this.#text(")");
    }
  }

  #alias(alias: string) {
    this.#text(" AS ");
    this.#identifier(alias);
  }

  #requireClause(clause: ConditionalClause, sql: string) {
    if (this.#profile !== undefined && !supportsClause(this.#profile, clause)) {
      throw new UnsupportedDialectClauseError(
        `${sql} is unsupported by the ${this.#profile} dialect profile`
      );
    }
  }

  #join(join: Join<Raw>) {
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

  #subquery(query: SelectStatement<Raw>) {
    this.#text("(");
    this.#select(query);
    this.#text(")");
  }

  #predicate(
    clause: "WHERE" | "HAVING",
    expression: Expression<Raw> | undefined
  ) {
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

  #groupOrOrderExpression(expression: Expression<Raw>) {
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

  #select(query: SelectStatement<Raw>) {
    if (query.with !== undefined) {
      this.#text("WITH ");
      this.#list(query.with, (cte) => {
        this.#identifier(cte.name);
        this.#text(" AS ");
        this.#subquery(cte.query);
      });
      this.#text(" ");
    }

    const sets = query.sets ?? [];

    for (const _ of sets) {
      this.#text("SELECT * FROM (");
    }

    this.#selectBody(query);

    for (const { operator, query: right } of sets) {
      this.#text(")");
      this.#alias("__eqb_set_left");
      this.#text(` ${operator} SELECT * FROM `);
      this.#subquery(right);
      this.#alias("__eqb_set_right");
    }
  }

  #selectBody(query: SelectStatement<Raw>) {
    this.#text(query.distinct === true ? "SELECT DISTINCT " : "SELECT ");
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

    const { limit, offset } = query;

    if (limit !== undefined) {
      this.#limitValue("LIMIT", limit);
    } else if (offset !== undefined) {
      this.#text(offsetOnlyLimit[this.#dialect ?? "portable"]);
    }

    if (offset !== undefined) {
      this.#limitValue("OFFSET", offset);
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

export const compile = (target: CompileTarget, statement: Statement) => {
  const tokens: SqlToken[] = [];

  const compiler = new Compiler<never>(target, (token) => {
    if (token.kind === "raw" || token.kind === "identifier") {
      throw new TypeError(`Unexpected token: ${token.kind}`);
    }

    tokens.push(token);
  });

  compiler.compile(statement);

  return renderTokens(tokens, compiler.dialect === "pg");
};

export const renderSelect = <Raw>(
  dialect: SqlDialect | undefined,
  query: SelectStatement<Raw>,
  write: (token: CompilerToken<Raw>) => void
) => {
  new Compiler(dialect, write).compile(query);
};
