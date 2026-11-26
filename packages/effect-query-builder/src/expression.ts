import { Predicate, Schema, SchemaTransformation } from "effect";
import { Statement } from "effect/sql";

import { inferColumnStorage } from "./column-storage.ts";
import type { Expression as ExpressionNode } from "./kernel/ast.ts";
import { isColumn } from "./table.ts";
import type { Column } from "./table.ts";

const ExpressionTypeId = Symbol("effect-query-builder/Expression");
const OrderingTypeId = Symbol("effect-query-builder/Ordering");

export interface Expression<
  S extends Schema.Constraint = Schema.Constraint,
  Refs extends Column = Column,
> {
  readonly [ExpressionTypeId]: true;
  readonly schema: S;
  readonly node: ExpressionNode<Statement.Fragment>;
  readonly references: readonly Refs[];
}

type ScalarExpression = Column | Expression;

export type ExpressionInput = ScalarExpression | Statement.Fragment;

export type PredicateInput =
  | Expression<Schema.Constraint & { readonly Type: boolean | null }>
  | Statement.Fragment;

export interface Ordering<Input extends ExpressionInput = ExpressionInput> {
  readonly [OrderingTypeId]: true;
  readonly expression: Input;
  readonly direction: "asc" | "desc";
}

type InputReferences<Input> = Input extends Column
  ? Input
  : Input extends Expression<Schema.Constraint, infer Refs>
    ? Refs
    : never;

export type ExpressionReferences<Input> =
  Input extends Ordering<infer Item>
    ? InputReferences<Item>
    : InputReferences<Input>;

type Scalar =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | Int8Array;

type Operand = ScalarExpression | Scalar;

type Node = ExpressionNode<Statement.Fragment>;

type Operator = Extract<Node, { kind: "binary" }>["operator"];

type SqlValue<Input> = Input extends Column
  ? Input["schema"]["Encoded"]
  : Input extends Expression
    ? Input["schema"]["Type"]
    : Input extends Statement.Fragment
      ? unknown
      : Input;

type Matches<Input, Value> = [NonNullable<SqlValue<Input>>] extends [Value]
  ? unknown
  : never;

type EncodedValue<Input> = Input extends ScalarExpression
  ? Input["schema"]["Encoded"]
  : SqlValue<Input>;

type NullableSchema<S extends Schema.Constraint, Input> =
  null extends EncodedValue<Input> ? Schema.NullOr<S> : S;

const booleanSchema = Schema.Union([Schema.Boolean, Schema.BooleanFromBit]);

const integerFromBigInt = Schema.BigInt.pipe(
  Schema.decodeTo(
    Schema.Int,
    SchemaTransformation.transform({ decode: Number, encode: BigInt })
  )
);

const countSchema = Schema.Union([
  Schema.Natural,
  Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  integerFromBigInt.check(Schema.isGreaterThanOrEqualTo(0)),
]);

const numberSchema = Schema.Union([
  Schema.Finite,
  Schema.FiniteFromString,
  integerFromBigInt,
]);

export const isExpression = <Input>(
  value: Input
): value is Input & Expression =>
  Predicate.hasProperty(value, ExpressionTypeId) &&
  value[ExpressionTypeId] === true;

export const isOrdering = <Input>(value: Input): value is Input & Ordering =>
  Predicate.hasProperty(value, OrderingTypeId) &&
  value[OrderingTypeId] === true;

export const makeExpression = <
  S extends Schema.Constraint,
  Refs extends Column,
>(
  schema: S,
  node: Node,
  references: readonly Refs[]
) =>
  Object.freeze<Expression<S, Refs>>({
    [ExpressionTypeId]: true,
    node,
    references: Object.freeze(references),
    schema,
  });

export const toExpressionNode: (value: ExpressionInput) => Node = (value) => {
  if (isExpression(value)) {
    return value.node;
  }

  if (Statement.isFragment(value)) {
    return {
      kind: "raw",
      value: Statement.fragment([
        Statement.literal("("),
        ...value.segments,
        Statement.literal(")"),
      ]),
    };
  }

  return { kind: "column", name: value.name, table: value.table.name };
};

const expressionInput = (
  value: Operand | Statement.Fragment
): value is ExpressionInput =>
  isColumn(value) || isExpression(value) || Statement.isFragment(value);

const toOperandNode: (value: Operand) => Node = (value) =>
  expressionInput(value)
    ? toExpressionNode(value)
    : { kind: "parameter", value };

function referencesOf<Operands extends readonly unknown[]>(
  operands: Operands
): readonly InputReferences<Operands[number]>[];
function referencesOf(operands: readonly unknown[]) {
  return operands.flatMap((value) => {
    if (isColumn(value)) {
      return [value];
    }

    return isExpression(value) ? value.references : [];
  });
}

const mayBeNull = (operand: Operand | Statement.Fragment) => {
  if (isColumn(operand)) {
    return operand.nullable;
  }

  return isExpression(operand)
    ? inferColumnStorage(operand.schema.ast).nullable
    : Statement.isFragment(operand);
};

function nullPropagating<
  S extends Schema.Constraint,
  Operands extends readonly (Operand | Statement.Fragment)[],
>(
  schema: S,
  node: Node,
  operands: Operands
): Expression<
  NullableSchema<S, Operands[number]>,
  InputReferences<Operands[number]>
>;
function nullPropagating(
  schema: Schema.Constraint,
  node: Node,
  operands: readonly (Operand | Statement.Fragment)[]
) {
  return makeExpression(
    operands.some(mayBeNull) ? Schema.NullOr(schema) : schema,
    node,
    referencesOf(operands)
  );
}

const binary = (operator: Operator, left: Operand, right: Operand) =>
  ({
    kind: "binary",
    left: toOperandNode(left),
    operator,
    right: toOperandNode(right),
  }) satisfies Node;

const comparison =
  (operator: Operator) =>
  <L extends ScalarExpression, R extends Operand>(
    left: L,
    right: R & Matches<R, NonNullable<SqlValue<NoInfer<L>>>>
  ) =>
    nullPropagating(booleanSchema, binary(operator, left, right), [
      left,
      right,
    ]);

export const eq = comparison("=");
export const neq = comparison("<>");
export const gt = comparison(">");
export const gte = comparison(">=");
export const lt = comparison("<");
export const lte = comparison("<=");

const logical =
  (operator: "AND" | "OR") =>
  <const Terms extends readonly PredicateInput[]>(...terms: Terms) => {
    const [first, ...rest] = terms;

    let node: Node =
      first === undefined
        ? { kind: "booleanLiteral", value: operator === "AND" }
        : toExpressionNode(first);

    for (const term of rest) {
      node = {
        kind: "binary",
        left: node,
        operator,
        right: toExpressionNode(term),
      };
    }

    return nullPropagating(booleanSchema, node, terms);
  };

export const and = logical("AND");
export const or = logical("OR");

export const not = <Input extends PredicateInput>(operand: Input) =>
  nullPropagating(
    booleanSchema,
    { kind: "not", operand: toExpressionNode(operand) },
    [operand]
  );

const nullCheck =
  (negate: boolean) =>
  <Input extends ExpressionInput>(operand: Input) =>
    makeExpression(
      booleanSchema,
      { kind: "nullCheck", negate, operand: toExpressionNode(operand) },
      referencesOf([operand])
    );

export const isNull = nullCheck(false);
export const isNotNull = nullCheck(true);

export const like = <L extends ScalarExpression, R extends Operand>(
  left: L & Matches<L, string>,
  pattern: R & Matches<R, string>
) =>
  nullPropagating(booleanSchema, binary("LIKE", left, pattern), [
    left,
    pattern,
  ]);

export const between = <
  Input extends ScalarExpression,
  Lower extends Operand,
  Upper extends Operand,
>(
  operand: Input,
  lower: Lower & Matches<Lower, NonNullable<SqlValue<NoInfer<Input>>>>,
  upper: Upper & Matches<Upper, NonNullable<SqlValue<NoInfer<Input>>>>
) =>
  nullPropagating(
    booleanSchema,
    {
      kind: "between",
      lower: toOperandNode(lower),
      operand: toExpressionNode(operand),
      upper: toOperandNode(upper),
    },
    [operand, lower, upper]
  );

const inList =
  (negate: boolean) =>
  <Input extends ScalarExpression, Item extends Operand>(
    operand: Input,
    values: readonly (Item &
      Matches<Item, NonNullable<SqlValue<NoInfer<Input>>>>)[]
  ) =>
    nullPropagating(
      booleanSchema,
      {
        kind: "in",
        negate,
        operand: toExpressionNode(operand),
        values: values.map(toOperandNode),
      },
      [operand, ...values]
    );

export const inArray = inList(false);
export const notInArray = inList(true);

type Numeric = number | bigint;

type Orderable = string | Numeric | Date;

const arithmetic =
  (operator: "+" | "-" | "*") =>
  <L extends Operand, R extends Operand>(
    left: L & Matches<L, Numeric>,
    right: R & Matches<R, Numeric>
  ) =>
    nullPropagating(numberSchema, binary(operator, left, right), [left, right]);

export const add = arithmetic("+");
export const subtract = arithmetic("-");
export const multiply = arithmetic("*");

export const divide = <L extends Operand, R extends Operand>(
  left: L & Matches<L, Numeric>,
  right: R & Matches<R, Numeric>
) =>
  makeExpression(
    Schema.NullOr(numberSchema),
    binary("/", left, right),
    referencesOf([left, right])
  );

interface AggregateOptions {
  readonly distinct?: boolean;
}

export function count(): Expression<typeof countSchema, never>;
export function count<Input extends ExpressionInput>(
  operand: Input,
  options?: AggregateOptions
): Expression<typeof countSchema, InputReferences<Input>>;
export function count(operand?: ExpressionInput, options?: AggregateOptions) {
  return operand === undefined
    ? makeExpression(countSchema, { kind: "aggregate", name: "COUNT" }, [])
    : makeExpression(
        countSchema,
        {
          distinct: options?.distinct,
          kind: "aggregate",
          name: "COUNT",
          operand: toExpressionNode(operand),
        },
        referencesOf([operand])
      );
}

const numericAggregate =
  (name: "SUM" | "AVG") =>
  <Input extends ScalarExpression>(
    operand: Input & Matches<Input, Numeric>,
    options?: AggregateOptions
  ) =>
    makeExpression(
      Schema.NullOr(numberSchema),
      {
        distinct: options?.distinct,
        kind: "aggregate",
        name,
        operand: toExpressionNode(operand),
      },
      referencesOf([operand])
    );

export const sum = numericAggregate("SUM");
export const avg = numericAggregate("AVG");

const extremum =
  (name: "MIN" | "MAX") =>
  <Input extends ScalarExpression>(
    operand: Input & Matches<Input, Orderable>
  ) =>
    makeExpression<Schema.NullOr<Input["schema"]>, InputReferences<Input>>(
      Schema.NullOr<Input["schema"]>(operand.schema),
      { kind: "aggregate", name, operand: toExpressionNode(operand) },
      referencesOf([operand])
    );

export const min = extremum("MIN");
export const max = extremum("MAX");

export const raw = <S extends Schema.Constraint>(
  schema: S,
  fragment: Statement.Fragment
) => makeExpression(schema, toExpressionNode(fragment), []);

const ordering =
  (direction: Ordering["direction"]) =>
  <Input extends ExpressionInput>(expression: Input) =>
    Object.freeze<Ordering<Input>>({
      [OrderingTypeId]: true,
      direction,
      expression,
    });

export const asc = ordering("asc");
export const desc = ordering("desc");
