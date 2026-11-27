import { Predicate, Schema } from "effect";
import type { Effect } from "effect";
import type { SqlConnection, Statement } from "effect/sql";

import type { Expression } from "./expression.ts";
import type { SelectStatement } from "./kernel/ast.ts";
import type { SelectDialect } from "./select-compiler.ts";
import type { ProjectionPlan, Selection } from "./select-projection.ts";
import {
  alias as aliasTable,
  isTableSource,
  projectionColumn,
  validateIdentifier,
} from "./table.ts";
import type { Column, TableSource } from "./table.ts";

const DerivedTypeId = Symbol("effect-query-builder/DerivedSource");

type StringKey<Key> = `${Extract<Key, number | string>}`;

type ScalarFields<P> = P extends TableSource
  ? Pick<P["c"], Extract<keyof P["c"], StringKey<keyof P["select"]["fields"]>>>
  : P extends DerivedSource
    ? P["c"]
    : {
        [
          K in keyof P as P[K] extends Column | Expression
            ? StringKey<K>
            : never
        ]: Extract<P[K], Column | Expression>;
      };

export type ScalarKey<P> = Extract<keyof ScalarFields<P>, string>;

type FieldSchema<P, Key extends ScalarKey<P>> = ScalarFields<P>[Key] extends
  | Column
  | Expression
  ? ScalarFields<P>[Key]["schema"]
  : never;

type FieldValue<Row, Key extends string> = Key extends keyof NonNullable<Row>
  ? NonNullable<Row>[Key]
  : Key extends `${infer NumericKey extends number}`
    ? NonNullable<Row>[NumericKey & keyof NonNullable<Row>]
    : never;

type ProjectedSchema<P, Key extends ScalarKey<P>, Row> = Schema.Constraint & {
  readonly Type: FieldValue<Row, Key> | (null extends Row ? null : never);
  readonly Encoded:
    | FieldSchema<P, Key>["Encoded"]
    | (null extends Row | FieldValue<Row, Key> ? null : never);
  readonly DecodingServices: FieldSchema<P, Key>["DecodingServices"];
};

export type ScalarSchema<P, Key extends ScalarKey<P>, Row> = Schema.NullOr<
  ProjectedSchema<P, Key, Row>
>;

interface DerivedSourceBase {
  readonly [DerivedTypeId]: true;
  readonly name: string;
  readonly c: Readonly<Record<string, Column>>;
  readonly dialects: readonly SelectDialect[];
  readonly plan: ProjectionPlan;
  readonly relation:
    | { readonly kind: "cte"; readonly name: string }
    | {
        readonly kind: "subquery";
        readonly query: SelectStatement<Statement.Fragment>;
      };
}

export interface DerivedSource<
  Name extends string = string,
  Columns extends Readonly<Record<string, Column>> = Readonly<
    Record<string, Column>
  >,
  Row = unknown,
  R = unknown,
  Dialect extends SelectDialect = SelectDialect,
> extends DerivedSourceBase {
  readonly name: Name;
  readonly c: Columns;
  readonly dialects: readonly Dialect[];
  readonly decodeRow: (
    row: SqlConnection.Row
  ) => Effect.Effect<Row, Schema.SchemaError, R>;
}

export type Source = TableSource | DerivedSource;

export type SourceDialect<T extends Source> = T extends DerivedSource
  ? T["dialects"][number]
  : SelectDialect;

export type DerivedSelection<
  Name extends string,
  P extends Selection,
  Row,
  R,
  D extends SelectDialect,
> = DerivedSource<
  Name,
  {
    readonly [K in ScalarKey<P>]: Column<
      { readonly name: Name },
      K,
      ProjectedSchema<P, K, Row>
    >;
  },
  Row,
  R,
  D
>;

export const isDerivedSource = <T>(value: T): value is T & DerivedSource =>
  Predicate.hasProperty(value, DerivedTypeId) && value[DerivedTypeId] === true;

export const isSource = (value: unknown): value is Source =>
  isTableSource(value) || isDerivedSource(value);

export const makeDerivedSource = (
  name: string,
  plan: ProjectionPlan,
  relation: DerivedSource["relation"],
  dialects: readonly SelectDialect[]
) => {
  validateIdentifier(name);

  const c = Object.fromEntries(
    Object.entries(plan.fields).map(([key, field]) => [
      key,
      projectionColumn(
        name,
        key,
        field.alias,
        field.nullable ? Schema.NullOr(field.schema) : field.schema
      ),
    ])
  );

  return Object.freeze<DerivedSource>({
    [DerivedTypeId]: true,
    c: Object.freeze(c),
    decodeRow: plan.decode,
    dialects,
    name,
    plan,
    relation,
  });
};

type AliasedDerived<
  S extends DerivedSource,
  Name extends string,
> = DerivedSource<
  Name,
  {
    readonly [K in keyof S["c"]]: S["c"][K] extends Column
      ? Column<
          { readonly name: Name },
          S["c"][K]["key"],
          S["c"][K]["schema"],
          S["c"][K]["nullable"]
        >
      : never;
  },
  Effect.Success<ReturnType<S["decodeRow"]>>,
  Effect.Services<ReturnType<S["decodeRow"]>>,
  S["dialects"][number]
>;

export function alias<const S extends DerivedSource, const Name extends string>(
  source: S,
  name: Name
): AliasedDerived<S, Name>;
export function alias<const S extends TableSource, const Name extends string>(
  source: S,
  name: Name
): ReturnType<typeof aliasTable<S, Name>>;
export function alias(source: Source, name: string) {
  return isDerivedSource(source)
    ? makeDerivedSource(name, source.plan, source.relation, source.dialects)
    : aliasTable(source, name);
}
