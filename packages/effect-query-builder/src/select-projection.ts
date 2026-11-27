import { Array as Arr, Effect, Predicate, Schema } from "effect";
import { forEach, map } from "effect/Effect";
import type { SqlConnection, Statement } from "effect/sql";

import { isExpression, toExpressionNode } from "./expression.ts";
import type { Expression } from "./expression.ts";
import type { Expression as Node, Projection } from "./kernel/ast.ts";
import { projectionAlias } from "./kernel/invariants.ts";
import { isColumn, isTableSource } from "./table.ts";
import type { Column, TableSource } from "./table.ts";

type SqlExpression = Node<Statement.Fragment>;

export type SelectionItem = TableSource | Column | Expression;

export type Selection = TableSource | Readonly<Record<string, SelectionItem>>;

type IsOuter<V, Nulls extends string> = V extends TableSource
  ? V["name"] extends Nulls
    ? true
    : false
  : V extends Column
    ? V["table"]["name"] extends Nulls
      ? true
      : false
    : V extends Expression
      ? Extract<V["references"][number]["table"]["name"], Nulls> extends never
        ? false
        : true
      : false;

type SelectionSchema<V extends SelectionItem> = V extends TableSource
  ? V["select"]
  : V extends Column | Expression
    ? V["schema"]
    : never;

type Value<V extends SelectionItem, Nulls extends string> =
  | SelectionSchema<V>["Type"]
  | (IsOuter<V, Nulls> extends true ? null : never);

export type Selected<
  P extends Selection,
  Nulls extends string,
> = P extends TableSource
  ? Value<P, Nulls>
  : {
      readonly [K in keyof P]: P[K] extends SelectionItem
        ? Value<P[K], Nulls>
        : never;
    };

export type DecodeServices<P extends Selection> = (P extends TableSource
  ? SelectionSchema<P>
  : P[keyof P] extends SelectionItem
    ? SelectionSchema<P[keyof P]>
    : never)["DecodingServices"];

type Decode = (
  row: SqlConnection.Row
) => Effect.Effect<unknown, Schema.SchemaError, unknown>;

export interface ProjectionField {
  readonly alias: string;
  readonly schema: Schema.Constraint;
  readonly marker?: string;
  readonly expressionCanBeNull?: boolean;
  readonly decode: Decode;
}

export interface ProjectionPlan {
  readonly columns: Arr.NonEmptyReadonlyArray<Projection<Statement.Fragment>>;
  readonly decode: Decode;
  readonly fields: Readonly<Record<string, ProjectionField>>;
  readonly presence: ReadonlyMap<string, string>;
}

const presenceColumn = (source: TableSource) => {
  const names = new Set(
    Object.values(source.c).map(({ name }) => name.toLowerCase())
  );

  let index = 0;
  let marker = projectionAlias(index);

  while (names.has(marker)) {
    index += 1;
    marker = projectionAlias(index);
  }

  return marker;
};

const primaryKeyMarker = (source: TableSource) => {
  const primaryKey = source.constraints?.primaryKey;
  const key = Predicate.isString(primaryKey) ? primaryKey : primaryKey?.[0];

  const column =
    key !== undefined && Object.hasOwn(source.c, key)
      ? source.c[key]
      : undefined;

  return column?.nullable === false ? column.name : undefined;
};

const markerExpression: (
  source: TableSource,
  name: string,
  grouped: boolean
) => SqlExpression = (source, name, grouped) => {
  const operand = { kind: "column", name, table: source.name } as const;

  return grouped
    ? {
        kind: "binary",
        operator: ">",
        left: { kind: "aggregate", name: "COUNT", operand },
        right: { kind: "numberLiteral", value: 0 },
      }
    : { kind: "nullCheck", negate: true, operand };
};

const missing = (row: SqlConnection.Row, marker: string | undefined) => {
  if (marker === undefined) {
    return false;
  }

  const value = row[marker];

  return value === false || value === 0 || value === 0n || value === "0";
};

const projectObject =
  (fields: readonly (readonly [string, Decode])[]) =>
  (row: SqlConnection.Row) =>
    map(
      forEach(fields, ([key, decode]) =>
        map(decode(row), (value) => [key, value] as const)
      ),
      Object.fromEntries
    );

export const planProjection: (
  selection: Selection,
  sources: Readonly<Record<string, TableSource>>,
  nullable: ReadonlySet<string>,
  grouped: boolean
) => ProjectionPlan = (selection, sources, nullable, grouped) => {
  const columns: Projection<Statement.Fragment>[] = [];
  const presence = new Map<string, string>();
  const markerAliases = new Map<string, string>();
  const fields: [string, ProjectionField][] = [];

  const add = (expression: SqlExpression) => {
    const alias = projectionAlias(columns.length);
    columns.push({ alias, expression });

    return alias;
  };

  const findMarker = (source: TableSource) => {
    const cached = markerAliases.get(source.name);

    if (cached !== undefined || !nullable.has(source.name)) {
      return cached;
    }

    const key = primaryKeyMarker(source);
    const marker = key ?? presenceColumn(source);

    if (key === undefined) {
      presence.set(source.name, marker);
    }

    const alias = add(markerExpression(source, marker, grouped));
    markerAliases.set(source.name, alias);

    return alias;
  };

  const projectTable = (source: TableSource, topLevel: boolean) => {
    const marker = findMarker(source);

    const mapping = Object.keys(source.select.fields)
      .toSorted()
      .flatMap((key) => {
        const column = source.c[key];

        if (column === undefined) {
          return [];
        }

        const alias = add(toExpressionNode(column));

        if (topLevel) {
          const decode = Schema.decodeUnknownEffect(column.schema);
          fields.push([
            key,
            {
              alias,
              decode: (row) =>
                missing(row, marker)
                  ? Effect.succeed(null)
                  : decode(row[alias]),
              marker,
              schema: column.schema,
            },
          ]);
        }

        return [[column.name, alias] as const];
      });

    return (row: SqlConnection.Row) =>
      missing(row, marker)
        ? Effect.succeed(null)
        : source.decodeRow(
            Object.fromEntries(
              mapping.map(([name, alias]) => [name, row[alias]])
            )
          );
  };

  const projectItem = (key: string, item: SelectionItem) => {
    if (isTableSource(item)) {
      return projectTable(item, false);
    }

    const source =
      isColumn(item) && Object.hasOwn(sources, item.table.name)
        ? sources[item.table.name]
        : undefined;

    const marker = source === undefined ? undefined : findMarker(source);

    const expressionCanBeNull =
      isExpression(item) &&
      item.references.some((column) => nullable.has(column.table.name));

    const alias = add(toExpressionNode(item));
    const decodeValue = Schema.decodeUnknownEffect(item.schema);

    const decode: Decode = (row) =>
      missing(row, marker) || (row[alias] === null && expressionCanBeNull)
        ? Effect.succeed(null)
        : decodeValue(row[alias]);

    fields.push([
      key,
      { alias, decode, expressionCanBeNull, marker, schema: item.schema },
    ]);

    return decode;
  };

  const decode = isTableSource(selection)
    ? projectTable(selection, true)
    : projectObject(
        Object.keys(selection)
          .toSorted()
          .flatMap((key) => {
            const item = selection[key];

            return item === undefined ? [] : [[key, projectItem(key, item)]];
          })
      );

  if (!Arr.isReadonlyArrayNonEmpty(columns)) {
    return {
      columns: [
        {
          expression: { kind: "numberLiteral", value: 1 },
          alias: projectionAlias(0),
        },
      ],
      decode,
      fields: Object.fromEntries(fields),
      presence,
    };
  }

  return { columns, decode, fields: Object.fromEntries(fields), presence };
};
