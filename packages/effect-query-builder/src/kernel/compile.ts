import type {
  DeleteStatement,
  Expression,
  InsertConflict,
  InsertStatement,
  Join,
  Projection,
  QualifiedName,
  Relation,
  SelectStatement,
  Statement,
  UpdateStatement,
  WriteAssignment,
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

type WriteStatement<Raw = never> = Extract<
  Statement<Raw>,
  { kind: "insert" | "update" | "delete" }
>;

type ConditionalClause = "fullJoin" | `${WriteStatement["kind"]}Returning`;

type CompilerToken<Raw> =
  | SqlToken
  | { readonly kind: "identifier"; readonly name: string }
  | { readonly kind: "raw"; readonly value: Raw };

type ColumnQualifier =
  | { readonly kind: "unqualified" }
  | { readonly kind: "replace"; readonly from: string; readonly to: string };

const joinSql = {
  cross: "CROSS JOIN",
  full: "FULL OUTER JOIN",
  inner: "INNER JOIN",
  left: "LEFT JOIN",
  right: "RIGHT JOIN",
} satisfies Record<Join["kind"], string>;

const pgOperators = new Set<
  Extract<Expression, { kind: "binary" }>["operator"]
>(["ILIKE", "->", "->>", "@>", "?"]);

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
  #qualifier?: ColumnQualifier;
  #updatingConflict?: "doUpdate" | "duplicateKeyUpdate";

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

  #booleanLiteral(value: boolean) {
    if (this.#dialect === "sqlite") {
      this.#text(value ? "1" : "0");
    } else {
      this.#text(value ? "TRUE" : "FALSE");
    }
  }

  #binary(expression: Extract<Expression<Raw>, { kind: "binary" }>) {
    if (pgOperators.has(expression.operator)) {
      this.#requireDialect(expression.operator, "pg");
    }

    this.#text("(");
    this.#expression(expression.left);
    this.#text(` ${expression.operator} `);
    this.#expression(expression.right);
    this.#text(")");
  }

  #column(expression: Extract<Expression<Raw>, { kind: "column" }>) {
    const qualifier = this.#qualifier;
    let schema = expression.table;

    if (qualifier?.kind === "unqualified") {
      schema = undefined;
    } else if (qualifier?.kind === "replace" && schema === qualifier.from) {
      schema = qualifier.to;
    }

    this.#qualifiedName({ name: expression.name, schema });
  }

  #expression(expression: Expression<Raw>) {
    switch (expression.kind) {
      case "column": {
        this.#column(expression);

        return;
      }

      case "incomingColumn": {
        this.#incomingColumn(expression.name);

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
        this.#booleanLiteral(expression.value);

        return;
      }

      case "nullLiteral": {
        this.#text("NULL");

        return;
      }

      case "defaultValue": {
        this.#requireDialect("DEFAULT in VALUES", "pg", "mysql");
        this.#text("DEFAULT");

        return;
      }

      case "binary": {
        this.#binary(expression);

        return;
      }

      case "sqliteJson": {
        this.#requireDialect(expression.name, "sqlite");
        this.#text(`${expression.name}(`);
        this.#expression(expression.operand);
        this.#text(", ");
        this.#expression(expression.path);
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

  #requireDialect(sql: string, ...dialects: readonly SqlDialect[]) {
    const dialect = this.#dialect;

    if (
      dialect !== undefined &&
      (this.#profile === "portable" || !dialects.includes(dialect))
    ) {
      throw new UnsupportedDialectClauseError(
        `${sql} is unsupported by the ${this.#profile} dialect profile`
      );
    }
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
    const updatingConflict = this.#updatingConflict;
    this.#updatingConflict = undefined;
    this.#text("(");

    try {
      this.#withQualifier(undefined, () => {
        this.#select(query);
      });
    } finally {
      this.#updatingConflict = updatingConflict;
    }

    this.#text(")");
  }

  #withQualifier(qualifier: ColumnQualifier | undefined, render: () => void) {
    const current = this.#qualifier;
    this.#qualifier = qualifier;

    try {
      render();
    } finally {
      this.#qualifier = current;
    }
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
    if (query.dialect !== undefined) {
      this.#requireDialect(`SELECT scoped to ${query.dialect}`, query.dialect);
    }

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
    const { distinct } = query;

    this.#text("SELECT ");

    if (distinct === true) {
      this.#text("DISTINCT ");
    } else if (distinct !== undefined && distinct !== false) {
      this.#requireDialect("DISTINCT ON", "pg");
      this.#text("DISTINCT ON (");
      this.#list(distinct, (expression) => {
        this.#groupOrOrderExpression(expression);
      });
      this.#text(") ");
    }

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

    if (query.forUpdate === true) {
      this.#requireDialect("FOR UPDATE", "pg", "mysql");
      this.#text(" FOR UPDATE");
    }
  }

  #returning(statement: WriteStatement<Raw>) {
    const { returning } = statement;

    if (returning !== undefined) {
      this.#requireClause(`${statement.kind}Returning`, "RETURNING");
      this.#text(" RETURNING ");

      if (this.#dialect === "sqlite") {
        this.#withQualifier({ kind: "unqualified" }, () => {
          this.#projections(returning);
        });
      } else {
        this.#projections(returning);
      }
    }
  }

  #insert(statement: InsertStatement<Raw>) {
    this.#text("INSERT INTO ");
    this.#qualifiedName(statement.table);

    const { conflict, table } = statement;

    const targetName =
      this.#dialect === "sqlite" ? table.name.toLowerCase() : table.name;

    const qualify = conflict?.kind === "doUpdate" && targetName === "excluded";
    const targetAlias = "__eqb_insert_target";

    if (qualify) {
      this.#alias(targetAlias);
    }

    this.#insertSource(statement);

    this.#withQualifier(
      qualify
        ? { kind: "replace", from: table.name, to: targetAlias }
        : undefined,
      () => {
        if (conflict !== undefined) {
          this.#conflict(conflict);
        }

        this.#returning(statement);
      }
    );
  }

  #incomingColumn(name: string) {
    if (this.#updatingConflict === "doUpdate") {
      this.#qualifiedName({ name, schema: "excluded" });
    } else if (this.#updatingConflict === "duplicateKeyUpdate") {
      this.#text("VALUES(");
      this.#identifier(name);
      this.#text(")");
    } else {
      throw new UnsupportedDialectClauseError(
        "Incoming columns require an upsert assignment"
      );
    }
  }

  #conflict(conflict: InsertConflict<Raw>) {
    if (conflict.kind === "duplicateKeyUpdate") {
      this.#requireDialect("ON DUPLICATE KEY UPDATE", "mysql");
      this.#text(" ON DUPLICATE KEY UPDATE ");
    } else {
      this.#requireDialect("ON CONFLICT", "pg", "sqlite");
      this.#text(" ON CONFLICT");

      if (conflict.columns !== undefined) {
        this.#text(" (");
        this.#list(conflict.columns, (column) => {
          this.#identifier(column);
        });
        this.#text(")");
      }

      if (conflict.kind === "doNothing") {
        this.#text(" DO NOTHING");

        return;
      }

      this.#text(" DO UPDATE SET ");
    }

    this.#updatingConflict = conflict.kind;

    try {
      this.#assignments(conflict.assignments);
    } finally {
      this.#updatingConflict = undefined;
    }
  }

  #insertSource(statement: InsertStatement<Raw>) {
    if ("defaultRows" in statement) {
      if (statement.conflict !== undefined) {
        this.#requireDialect("Upsert with default-only INSERT", "pg", "mysql");
      }

      this.#defaultInsert(statement.defaultRows, statement.defaultColumn);

      return;
    }

    this.#text(" (");
    this.#list(statement.columns, (column) => {
      this.#identifier(column);
    });
    this.#text(") ");

    if ("select" in statement) {
      this.#insertSelect(statement.select, statement.conflict !== undefined);
    } else {
      this.#text("VALUES ");
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
    }
  }

  #insertSelect(select: SelectStatement<Raw>, hasConflict: boolean) {
    if (this.#dialect !== "sqlite" || !hasConflict) {
      this.#select(select);
    } else if ((select.sets?.length ?? 0) === 0) {
      this.#select({
        ...select,
        where: select.where ?? { kind: "booleanLiteral", value: true },
      });
    } else {
      this.#text("SELECT * FROM ");
      this.#subquery(select);
      this.#alias("__eqb_upsert_source");
      this.#text(" WHERE 1");
    }
  }

  #defaultInsert(count: number, column: string | undefined) {
    if (!Number.isSafeInteger(count) || count < 1) {
      throw new TypeError("INSERT requires at least one row");
    }

    if (this.#dialect === "mysql") {
      this.#text(` () VALUES ()${", ()".repeat(count - 1)}`);
    } else if (count === 1) {
      this.#text(" DEFAULT VALUES");
    } else {
      this.#requireDialect("Bulk default-only INSERT", "pg");

      if (column === undefined) {
        throw new TypeError(
          "Bulk default-only INSERT requires a target column"
        );
      }

      this.#text(" (");
      this.#identifier(column);
      this.#text(`) VALUES (DEFAULT)${", (DEFAULT)".repeat(count - 1)}`);
    }
  }

  #assignments(assignments: readonly WriteAssignment<Raw>[]) {
    this.#list(assignments, ({ column, value }) => {
      this.#identifier(column);
      this.#text(" = ");
      this.#expression(value);
    });
  }

  #update(statement: UpdateStatement<Raw>) {
    this.#text("UPDATE ");
    this.#qualifiedName(statement.table);

    if (statement.alias !== undefined) {
      this.#alias(statement.alias);
    }

    this.#text(" SET ");
    this.#assignments(statement.assignments);
    this.#predicate("WHERE", statement.where);
    this.#returning(statement);
  }

  #delete(statement: DeleteStatement<Raw>) {
    const { alias, table } = statement;
    const lowerAlias = alias !== undefined && this.#profile === "mariadb";

    this.#text("DELETE ");

    if (alias !== undefined && this.#dialect === "mysql" && !lowerAlias) {
      this.#identifier(alias);
      this.#text(" ");
    }

    this.#text("FROM ");
    this.#qualifiedName(table);

    if (alias !== undefined && !lowerAlias) {
      this.#alias(alias);
    }

    this.#withQualifier(
      lowerAlias ? { kind: "replace", from: alias, to: table.name } : undefined,
      () => {
        this.#predicate("WHERE", statement.where);
        this.#returning(statement);
      }
    );
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

export const renderStatement = <Raw>(
  dialect: CompileTarget | undefined,
  query: Statement<Raw>,
  write: (token: CompilerToken<Raw>) => void
) => {
  new Compiler(dialect, write).compile(query);
};
