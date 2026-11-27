import { Array as Arr, Effect, Predicate, Schema } from "effect";
import { forEach, map } from "effect/Effect";
import type { SqlConnection, Statement } from "effect/sql";

import { isExpression, toExpressionNode } from "./expression.ts";
import type { Expression } from "./expression.ts";
import type { Expression as Node, Projection } from "./kernel/ast.ts";
import { projectionAlias } from "./kernel/invariants.ts";
import { isDerivedSource, isSource } from "./select-source.ts";
import type { Source } from "./select-source.ts";
import { isColumn } from "./table.ts";
import type { Column, TableSource } from "./table.ts";

type SqlExpression = Node<Statement.Fragment>;

export type SelectionItem = Source | Column | Expression;

export type Selection = Source | Readonly<Record<string, SelectionItem>>;

type IsOuter<V, Nulls extends string> = V extends Source
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

type Value<V extends SelectionItem, Nulls extends string> =
  | (V extends Source
      ? Effect.Success<ReturnType<V["decodeRow"]>>
      : V extends Column | Expression
        ? V["schema"]["Type"]
        : never)
  | (IsOuter<V, Nulls> extends true ? null : never);

export type Selected<
  P extends Selection,
  Nulls extends string,
> = P extends Source
  ? Value<P, Nulls>
  : {
      readonly [K in keyof P]: P[K] extends SelectionItem
        ? Value<P[K], Nulls>
        : never;
    };

type ItemServices<V> = V extends Source
  ? Effect.Services<ReturnType<V["decodeRow"]>>
  : V extends Column | Expression
    ? V["schema"]["DecodingServices"]
    : never;

export type DecodeServices<P extends Selection> = P extends Source
  ? ItemServices<P>
  : ItemServices<P[keyof P]>;

type Decode = (
  row: SqlConnection.Row
) => Effect.Effect<unknown, Schema.SchemaError, unknown>;

export interface ProjectionField {
  readonly alias: string;
  readonly schema: Schema.Constraint;
  readonly inputs: readonly string[];
  readonly nullable: boolean;
  readonly decode: Decode;
}

export interface ProjectionPlan {
  readonly columns: Arr.NonEmptyReadonlyArray<
    Projection<Statement.Fragment> & { readonly alias: string }
  >;
  readonly layout: readonly ProjectionSlot[];
  readonly decode: Decode;
  readonly fields: Readonly<Record<string, ProjectionField>>;
  readonly presence: ReadonlyMap<string, string>;
}

const presenceColumn = (source: Source) => {
  const names = new Set(
    isDerivedSource(source)
      ? source.plan.columns.map(({ alias }) => alias.toLowerCase())
      : Object.values(source.c).map(({ name }) => name.toLowerCase())
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
  source: Source,
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

type FieldPath = readonly string[];

interface ProjectionSlot {
  readonly role: string;
  readonly path: FieldPath;
  readonly markers: readonly string[];
}

const remapDecode: (
  decode: Decode,
  mapping: readonly (readonly [string, string])[],
  marker: string | undefined
) => Decode = (decode, mapping, marker) => (row) =>
  missing(row, marker)
    ? Effect.succeed(null)
    : decode(
        Object.fromEntries(mapping.map(([name, alias]) => [name, row[alias]]))
      );

export const planProjection: (
  selection: Selection,
  sources: Readonly<Record<string, Source>>,
  nullable: ReadonlySet<string>,
  grouped: boolean
) => ProjectionPlan = (selection, sources, nullable, grouped) => {
  const columns: ProjectionPlan["columns"][number][] = [];
  const layout: ProjectionSlot[] = [];
  const presence = new Map<string, string>();
  const markerAliases = new Map<string, string>();
  const fields: [string, ProjectionField][] = [];

  const add = (
    expression: SqlExpression,
    role: string,
    path: FieldPath,
    markers: readonly string[] = []
  ) => {
    const alias = projectionAlias(columns.length);
    columns.push({ alias, expression });
    layout.push({ markers, path, role });

    return alias;
  };

  const findMarker = (source: Source, path: FieldPath) => {
    const cached = markerAliases.get(source.name);

    if (cached !== undefined || !nullable.has(source.name)) {
      return cached;
    }

    const key = isDerivedSource(source) ? undefined : primaryKeyMarker(source);
    const marker = key ?? presenceColumn(source);

    if (key === undefined) {
      presence.set(source.name, marker);
    }

    const alias = add(
      markerExpression(source, marker, grouped),
      "presence",
      path
    );

    markerAliases.set(source.name, alias);

    return alias;
  };

  const forwardField = (
    field: ProjectionField,
    mapping: ReadonlyMap<string, string>,
    marker: string | undefined
  ) => {
    const aliases = field.inputs.map((input) => {
      const alias = mapping.get(input);

      if (alias === undefined) {
        throw new TypeError("Derived SELECT lost a projected field");
      }

      return [input, alias] as const;
    });

    const alias = mapping.get(field.alias);

    if (alias === undefined) {
      throw new TypeError("Derived SELECT lost a projected column");
    }

    return {
      alias,
      decode: remapDecode(field.decode, aliases, marker),
      inputs: [
        ...aliases.map(([, input]) => input),
        ...(marker === undefined ? [] : [marker]),
      ],
      nullable: field.nullable || marker !== undefined,
      schema: field.schema,
    };
  };

  const projectTable = (source: Source, path: FieldPath) => {
    const marker = findMarker(source, path);
    const topLevel = path.length === 0;

    if (isDerivedSource(source)) {
      const start = columns.length;

      const mapping = new Map(
        source.plan.columns.map(({ alias }, index) => [
          alias,
          projectionAlias(start + index),
        ])
      );

      for (const [index, { alias }] of source.plan.columns.entries()) {
        const slot = source.plan.layout[index];

        if (slot === undefined) {
          throw new TypeError("Derived SELECT lost a projection slot");
        }

        const markers = slot.markers.flatMap((input) => {
          const mapped = mapping.get(input);

          return mapped === undefined ? [] : [mapped];
        });

        add(
          { kind: "column", name: alias, table: source.name },
          slot.role,
          [...path, ...slot.path],
          marker === undefined ? markers : [...markers, marker]
        );
      }

      if (topLevel) {
        for (const [key, field] of Object.entries(source.plan.fields)) {
          fields.push([key, forwardField(field, mapping, marker)]);
        }
      }

      return remapDecode(source.decodeRow, [...mapping], marker);
    }

    const mapping = Object.keys(source.select.fields)
      .toSorted()
      .flatMap((key) => {
        const column = source.c[key];

        if (column === undefined) {
          return [];
        }

        const alias = add(
          toExpressionNode(column),
          "value",
          [...path, key],
          marker === undefined ? [] : [marker]
        );

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
              inputs: marker === undefined ? [alias] : [alias, marker],
              nullable: marker !== undefined,
              schema: column.schema,
            },
          ]);
        }

        return [[column.name, alias] as const];
      });

    return remapDecode(source.decodeRow, mapping, marker);
  };

  const projectItem = (key: string, item: SelectionItem) => {
    const path = [key];

    if (isSource(item)) {
      return projectTable(item, path);
    }

    const source =
      isColumn(item) && Object.hasOwn(sources, item.table.name)
        ? sources[item.table.name]
        : undefined;

    const marker = source === undefined ? undefined : findMarker(source, path);

    if (isColumn(item) && isDerivedSource(source)) {
      const field = source.plan.fields[item.key];

      if (field === undefined) {
        throw new TypeError(`Unknown derived SELECT column: ${item.key}`);
      }

      const inputs = field.inputs
        .filter((input) => input !== field.alias)
        .map(
          (input) =>
            [
              input,
              add(
                { kind: "column", name: input, table: source.name },
                "inherited presence",
                path
              ),
            ] as const
        );

      const markers = inputs.map(([, alias]) => alias);

      const alias = add(
        { kind: "column", name: field.alias, table: source.name },
        "value",
        path,
        marker === undefined ? markers : [...markers, marker]
      );

      const mapping = new Map([[field.alias, alias], ...inputs]);
      const projected = forwardField(field, mapping, marker);
      fields.push([key, projected]);

      return projected.decode;
    }

    const expressionCanBeNull =
      isExpression(item) &&
      item.references.some((column) => nullable.has(column.table.name));

    const alias = add(
      toExpressionNode(item),
      "value",
      path,
      marker === undefined ? [] : [marker]
    );

    const decodeValue = Schema.decodeUnknownEffect(item.schema);

    const decode: Decode = (row) =>
      missing(row, marker) || (row[alias] === null && expressionCanBeNull)
        ? Effect.succeed(null)
        : decodeValue(row[alias]);

    fields.push([
      key,
      {
        alias,
        decode,
        inputs: marker === undefined ? [alias] : [alias, marker],
        nullable: marker !== undefined || expressionCanBeNull,
        schema: item.schema,
      },
    ]);

    return decode;
  };

  const decode = isSource(selection)
    ? projectTable(selection, [])
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
      layout: [{ markers: [], path: [], role: "empty projection" }],
      presence,
    };
  }

  return {
    columns,
    decode,
    fields: Object.fromEntries(fields),
    layout,
    presence,
  };
};
