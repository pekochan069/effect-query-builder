import { Predicate, Schema, SchemaAST } from "effect";

import type { CompileTarget } from "./kernel/compile.ts";

export type SqlTypes = Readonly<
  Record<Extract<CompileTarget, string>, string | undefined>
>;

const text: SqlTypes = { pg: "TEXT", sqlite: "TEXT", mysql: "TEXT" };

const integer: SqlTypes = {
  pg: "INTEGER",
  sqlite: "INTEGER",
  mysql: "INTEGER",
};

const storage = {
  bigint: { pg: "BIGINT", sqlite: "INTEGER", mysql: "BIGINT" },
  boolean: { pg: "BOOLEAN", sqlite: "INTEGER", mysql: "BOOLEAN" },
  integer,
  json: { pg: "JSONB", sqlite: "TEXT", mysql: "JSON" },
  real: { pg: "DOUBLE PRECISION", sqlite: "REAL", mysql: "DOUBLE" },
  text,
} satisfies Record<string, SqlTypes>;

const unknownStorage: SqlTypes = {
  pg: undefined,
  sqlite: undefined,
  mysql: undefined,
};

const jsonString = SchemaAST.resolve(
  SchemaAST.toEncoded(Schema.fromJsonString(Schema.Unknown).ast)
)?.expected;

const isIntegerCheck: (check: SchemaAST.Check<unknown>) => boolean = (check) =>
  check.annotations?.representation?.id === "effect/schema/isInt" ||
  (check._tag === "FilterGroup" && check.checks.some(isIntegerCheck));

const encodedParts: (
  ast: SchemaAST.AST,
  resolving: ReadonlySet<SchemaAST.AST>
) => readonly SchemaAST.AST[] = (ast, resolving) => {
  if (ast._tag === "Union") {
    return ast.types.flatMap((type) => encodedParts(type, resolving));
  }

  if (ast._tag === "Suspend") {
    return resolving.has(ast)
      ? []
      : encodedParts(ast.thunk(), new Set([...resolving, ast]));
  }

  return [ast];
};

const typeForLiteral: (
  value: SchemaAST.LiteralValue
) => keyof typeof storage = (value) => {
  if (Predicate.isNumber(value)) {
    return Number.isSafeInteger(value) ? "integer" : "real";
  }

  if (Predicate.isString(value)) {
    return "text";
  }

  return Predicate.isBoolean(value) ? "boolean" : "bigint";
};

const primitiveTypes: Partial<
  Record<SchemaAST.AST["_tag"], keyof typeof storage>
> = {
  BigInt: "bigint",
  Boolean: "boolean",
  TemplateLiteral: "text",
};

const typeFor: (ast: SchemaAST.AST) => keyof typeof storage | undefined = (
  ast
) => {
  if (ast._tag === "String") {
    return jsonString !== undefined &&
      SchemaAST.resolve(ast)?.expected === jsonString
      ? "json"
      : "text";
  }

  if (ast._tag === "Number") {
    return ast.checks?.some(isIntegerCheck) === true ? "integer" : "real";
  }

  if (ast._tag === "Literal") {
    return typeForLiteral(ast.literal);
  }

  return primitiveTypes[ast._tag];
};

export const inferColumnStorage = (ast: SchemaAST.AST) => {
  const parts = encodedParts(SchemaAST.toEncoded(ast), new Set());

  const types = parts
    .filter(
      (part) =>
        part._tag !== "Null" &&
        part._tag !== "Undefined" &&
        part._tag !== "Never"
    )
    .flatMap((part) =>
      part._tag === "Enum"
        ? part.enums.map(([, value]) => typeForLiteral(value))
        : [typeFor(part)]
    );

  const [first, ...rest] = types;

  return {
    nullable: parts.some(
      ({ _tag }) => _tag === "Null" || _tag === "Unknown" || _tag === "Any"
    ),
    sqlType:
      first !== undefined && rest.every((type) => type === first)
        ? storage[first]
        : unknownStorage,
  };
};
