import { Statement } from "effect/sql";

import type { SelectStatement } from "./kernel/ast.ts";
import { renderSelect } from "./kernel/compile.ts";
import type { SqlDialect } from "./kernel/compile.ts";

export type SelectDialect = SqlDialect;

export const toSelectFragment = (
  query: SelectStatement<Statement.Fragment>,
  dialect?: SelectDialect
) => {
  const segments: Statement.Segment[] = [];

  renderSelect(dialect, query, (token) => {
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

const makeCompiler = (dialect: SelectDialect) =>
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
} satisfies Record<SelectDialect, Statement.Compiler>;

export const compileSelect = (
  query: SelectStatement<Statement.Fragment>,
  dialect: SelectDialect
) => {
  const [sql, params] = compilers[dialect].compile(
    toSelectFragment(query, dialect),
    true
  );

  return { params, sql };
};
