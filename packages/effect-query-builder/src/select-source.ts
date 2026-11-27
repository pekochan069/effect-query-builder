import { Predicate, Schema } from "effect";
import type { Effect } from "effect";
import type { SqlConnection, Statement } from "effect/sql";

import type {
  Expression,
  ProjectedSqlValue,
  sqlNullOr,
  SqlValue,
} from "./expression.ts";
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

type FieldSqlValue<P, Key extends ScalarKey<P>> =
  FieldSchema<P, Key> extends ProjectedSqlValue<infer Value>
    ? Value
    : SqlValue<ScalarFields<P>[Key]>;

export type ScalarValue<P, Key extends ScalarKey<P>> = FieldSqlValue<
  P,
  Key
> | null;

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

type ProjectedSchema<P, Key extends ScalarKey<P>, Row> = Schema.Constraint &
  ProjectedSqlValue<FieldSqlValue<P, Key>> & {
    readonly Type: FieldValue<Row, Key> | (null extends Row ? null : never);
    readonly Encoded:
      | FieldSchema<P, Key>["Encoded"]
      | (null extends Row | FieldValue<Row, Key> ? null : never);
    readonly DecodingServices: FieldSchema<P, Key>["DecodingServices"];
  };

export type ScalarSchema<P, Key extends ScalarKey<P>, Row> = ReturnType<
  typeof sqlNullOr<ProjectedSchema<P, Key, Row>>
>;

interface DerivedDefinition {
  readonly mysql: boolean;
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
> {
  readonly [DerivedTypeId]: DerivedDefinition & { readonly dialect?: Dialect };
  readonly name: Name;
  readonly c: Columns;
  readonly decodeRow: (
    row: SqlConnection.Row
  ) => Effect.Effect<Row, Schema.SchemaError, R>;
}

export type Source = TableSource | DerivedSource;

export type SourceDialect<T extends Source> = T extends DerivedSource
  ? NonNullable<T[typeof DerivedTypeId]["dialect"]>
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
  Predicate.hasProperty(value, DerivedTypeId);

export const derivedDefinition = (source: DerivedSource) =>
  source[DerivedTypeId];

export const isSource = (value: unknown): value is Source =>
  isTableSource(value) || isDerivedSource(value);

export const makeDerivedSource = (
  name: string,
  definition: DerivedDefinition
) => {
  validateIdentifier(name);

  const { plan } = definition;

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
    [DerivedTypeId]: Object.freeze(definition),
    c: Object.freeze(c),
    decodeRow: plan.decode,
    name,
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
  SourceDialect<S>
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
    ? makeDerivedSource(name, derivedDefinition(source))
    : aliasTable(source, name);
}
