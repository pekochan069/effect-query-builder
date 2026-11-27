import { Data, Effect, Predicate, Schema, SchemaAST } from "effect";
import type { Statement } from "effect/sql";

import { isExpression, toExpressionNode } from "./expression.ts";
import type {
  Expression,
  ExpressionReferences,
  SqlValue,
} from "./expression.ts";
import type { Expression as Node, WriteAssignment } from "./kernel/ast.ts";
import { isColumn } from "./table.ts";
import type { Column, RowSchema, TableSource } from "./table.ts";

export class WriteInputError extends Data.TaggedError("WriteInputError")<{
  readonly message: string;
}> {}

export type SqlValueInput = Column | Expression;

export type WriteRow = WriteInput<Schema.Struct<Schema.Struct.Fields>>;

export type WriteTargetColumns<T extends TableSource> = T["c"][keyof T["c"]];

export type CheckReferences<Input, Allowed extends Column> = [
  Exclude<ExpressionReferences<Input>, Allowed>,
] extends [never]
  ? unknown
  : never;

export type WriteInput<S extends RowSchema> = {
  readonly [K in keyof S["Type"]]: S["Type"][K] | SqlValueInput;
};

type InvalidField<
  Value,
  Field extends Schema.Constraint,
  Allowed extends Column,
> = [Extract<Value, SqlValueInput>] extends [never]
  ? false
  : CheckReferences<Extract<Value, SqlValueInput>, Allowed> extends never
    ? true
    : [SqlValue<Extract<Value, SqlValueInput>>] extends [Field["Encoded"]]
      ? false
      : true;

export type CheckWriteInput<
  S extends RowSchema,
  Input,
  Allowed extends Column,
> = [InvalidWriteInput<S, Input, Allowed>] extends [never] ? unknown : never;

type InvalidWriteInput<
  S extends RowSchema,
  Input,
  Allowed extends Column,
> = Input extends unknown
  ? {
      [K in keyof Input]-?: K extends keyof S["fields"]
        ? InvalidField<Input[K], S["fields"][K], Allowed> extends true
          ? K
          : never
        : K;
    }[keyof Input]
  : never;

export type WriteInputValues<Input> = Input extends unknown
  ? Input[keyof Input]
  : never;

const writeParameter = <T>(value: T) =>
  ({
    kind: "parameter",
    value,
  }) satisfies Node<Statement.Fragment>;

const hasWriteValue = (value: unknown): value is SqlValueInput =>
  isColumn(value) || isExpression(value);

export const assertWriteReferences = (
  input: SqlValueInput | Statement.Fragment,
  target: TableSource | undefined
) => {
  const references = isExpression(input)
    ? input.references
    : [input].filter(isColumn);

  for (const column of references) {
    if (
      target === undefined ||
      !Object.hasOwn(target.c, column.key) ||
      target.c[column.key] !== column
    ) {
      throw new WriteInputError({
        message: `Column ${column.table.name}.${column.name} is outside the write scope`,
      });
    }
  }
};

export const requiredWriteKeys = (schema: RowSchema) =>
  Object.entries(schema.fields).flatMap(([key, field]) =>
    SchemaAST.isOptional(SchemaAST.toEncoded(field.ast)) ? [] : [key]
  );

export const encodeWriteRow = (
  table: TableSource,
  variant: "insert" | "update",
  input: WriteRow
) =>
  Effect.gen(function* encodeRow() {
    if (!Predicate.isObject(input) || Array.isArray(input)) {
      return yield* new WriteInputError({
        message: "A write row must be an object",
      });
    }

    const schema = table[variant];
    const expressions = new Map<string, Node<Statement.Fragment>>();
    const values: [string, unknown][] = [];

    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(schema.fields, key)) {
        return yield* new WriteInputError({
          message: `Column ${key} is unavailable for ${variant}`,
        });
      }

      if (hasWriteValue(value)) {
        try {
          assertWriteReferences(
            value,
            variant === "update" ? table : undefined
          );
        } catch (error) {
          if (error instanceof WriteInputError) {
            return yield* error;
          }

          throw error;
        }

        expressions.set(key, toExpressionNode(value));
      } else {
        values.push([key, value]);
      }
    }

    if (expressions.size > 0 && schema.ast.checks !== undefined) {
      return yield* new WriteInputError({
        message: "SQL expressions cannot be used with whole-row write checks",
      });
    }

    const valueSchema =
      expressions.size === 0
        ? schema
        : Schema.Struct(
            Object.fromEntries(
              Object.entries(schema.fields).filter(
                ([key]) => !expressions.has(key)
              )
            )
          );

    const boundValues = new Map(
      Object.entries(
        yield* Schema.encodeEffect(valueSchema)(Object.fromEntries(values))
      )
    );

    const assignments: WriteAssignment<Statement.Fragment>[] = [];

    for (const key of Object.keys(schema.fields)) {
      const expression = expressions.get(key);

      if (expression === undefined && !boundValues.has(key)) {
        continue;
      }

      const column = Object.hasOwn(table.c, key) ? table.c[key] : undefined;

      if (column === undefined) {
        return yield* new WriteInputError({
          message: `Unknown write column: ${key}`,
        });
      }

      assignments.push({
        column: column.name,
        value: expression ?? writeParameter(boundValues.get(key)),
      });
    }

    return assignments;
  });
