import { Predicate } from "effect";
import { Statement } from "effect/sql";

import type { Statement as QueryStatement } from "./kernel/ast.ts";
import { renderStatement } from "./kernel/compile.ts";
import type { CompileTarget, SqlDialect } from "./kernel/compile.ts";

export const toStatementFragment = (
  query: QueryStatement<Statement.Fragment>,
  target?: CompileTarget
) => {
  const segments: Statement.Segment[] = [];

  renderStatement(target, query, (token) => {
    switch (token.kind) {
      case "text": {
        segments.push(Statement.literal(token.text));
        break;
      }

      case "bind": {
        segments.push(Statement.parameter(token.value));
        break;
      }

      case "identifier": {
        segments.push(Statement.identifier(token.name));
        break;
      }

      case "raw": {
        for (const segment of token.value.segments) {
          segments.push(segment);
        }

        break;
      }

      default: {
        const unhandled: never = token;
        throw new TypeError(`Unexpected SQL token: ${String(unhandled)}`);
      }
    }
  });

  return Statement.fragment(Object.freeze(segments));
};

const makeCompiler = (dialect: SqlDialect) =>
  Statement.makeCompiler<Statement.Custom>({
    dialect,
    onCustom(segment) {
      throw new TypeError(
        `Driver-specific SQL segment ${segment.kind} cannot be compiled offline`
      );
    },
    onIdentifier: Statement.defaultEscape(dialect === "mysql" ? "`" : '"'),
    onRecordUpdate() {
      throw new TypeError(
        "Driver-specific SQL updateValues cannot be compiled offline"
      );
    },
    placeholder: dialect === "pg" ? (index) => `$${index}` : () => "?",
  });

const compilers = {
  mysql: makeCompiler("mysql"),
  pg: makeCompiler("pg"),
  sqlite: makeCompiler("sqlite"),
} satisfies Record<SqlDialect, Statement.Compiler>;

export const compileStatement = (
  query: QueryStatement<Statement.Fragment>,
  target: CompileTarget
) => {
  const dialect = Predicate.isString(target) ? target : target.dialect;

  const [sql, params] = compilers[dialect].compile(
    toStatementFragment(query, target),
    true
  );

  return { params, sql };
};

export const toSelectFragment = toStatementFragment;
export const compileSelect = compileStatement;
