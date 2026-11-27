import { Array as Arr, Effect, Predicate, Schema, SchemaAST } from "effect";
import { forEach, map } from "effect/Effect";
import type { SqlConnection, Statement } from "effect/sql";

import { isExpression, toExpressionNode } from "./expression.ts";
import type { Expression } from "./expression.ts";
import type { Expression as Node, Projection } from "./kernel/ast.ts";
import { projectionAlias } from "./kernel/invariants.ts";
import { isDerivedSource, isSource } from "./select-source.ts";
import type { Source } from "./select-source.ts";
import { isColumn } from "./table.ts";
import type { Column } from "./table.ts";

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
    Projection<Statement.Fragment> & {
      readonly alias: string;
      readonly slot: ProjectionSlot;
    }
  >;
  readonly decode: Decode;
  readonly fields: Readonly<Record<string, ProjectionField>>;
  readonly presence: ReadonlyMap<string, string>;
}

const markerExpression: (
  operand: SqlExpression,
  grouped: boolean
) => SqlExpression = (operand, grouped) =>
  grouped
    ? {
        kind: "binary",
        operator: ">",
        left: { kind: "aggregate", name: "COUNT", operand },
        right: { kind: "numberLiteral", value: 0 },
      }
    : { kind: "nullCheck", negate: true, operand };

const inheritedMarker = (operand: SqlExpression, grouped: boolean) =>
  grouped
    ? markerExpression(
        {
          kind: "caseWhen",
          condition: operand,
          result: { kind: "numberLiteral", value: 1 },
        },
        true
      )
    : operand;

const nonNullScalar = new Set<SchemaAST.AST["_tag"]>([
  "BigInt",
  "Boolean",
  "Enum",
  "Literal",
  "Number",
  "String",
  "TemplateLiteral",
]);

const preservesNull = (ast: SchemaAST.AST) => {
  if (ast.encoding !== undefined || ast.checks !== undefined) {
    return false;
  }

  return (
    ast._tag === "Null" ||
    (ast._tag === "Union" &&
      ast.types.some((part) => part._tag === "Null") &&
      ast.types.every(
        (part) =>
          part.encoding === undefined &&
          (part._tag === "Null"
            ? part.checks === undefined
            : nonNullScalar.has(part._tag))
      ))
  );
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
  readonly role:
    | "empty projection"
    | "inherited presence"
    | "presence"
    | "value";
  readonly path: FieldPath;
  readonly markers?: readonly string[];
  readonly encoding?: string;
}

const literalFamily = (value: SchemaAST.LiteralValue) => {
  if (Predicate.isString(value)) {
    return "string";
  }

  if (Predicate.isNumber(value)) {
    return "number";
  }

  return Predicate.isBoolean(value) ? "boolean" : "bigint";
};

const encodedFamily: (ast: SchemaAST.AST) => string | undefined = (ast) => {
  if (ast._tag === "Union") {
    const branches = ast.types
      .filter((part) => part._tag !== "Null")
      .map(encodedFamily);

    const known = branches.filter(Predicate.isString);

    return known.length === branches.length
      ? [...new Set(known)].toSorted().join("|")
      : undefined;
  }

  if (ast._tag === "Literal") {
    return literalFamily(ast.literal);
  }

  if (ast._tag === "Enum") {
    return [...new Set(ast.enums.map(([, value]) => literalFamily(value)))]
      .toSorted()
      .join("|");
  }

  if (ast._tag === "TemplateLiteral") {
    return "string";
  }

  return nonNullScalar.has(ast._tag) || ast._tag === "Null"
    ? ast._tag.toLowerCase()
    : undefined;
};

const requiresMarkers = (
  marker: string | undefined,
  inherited: readonly string[] = []
) => (marker === undefined ? inherited : [...inherited, marker]);

export const assertCompatibleProjections = (
  left: ProjectionPlan,
  right: ProjectionPlan
) => {
  const layout = (plan: ProjectionPlan) =>
    plan.columns.map(({ slot: { role, path, markers } }) => [
      role,
      path,
      markers ?? [],
    ]);

  if (JSON.stringify(layout(left)) !== JSON.stringify(layout(right))) {
    throw new TypeError(
      "Set operation operands must have the same SQL projection layout"
    );
  }

  if (
    left.columns.some(({ slot: { encoding } }, index) => {
      const other = right.columns[index]?.slot.encoding;

      return (
        encoding !== undefined && other !== undefined && encoding !== other
      );
    })
  ) {
    throw new TypeError(
      "Set operation operands must have compatible encoded projections"
    );
  }
};

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
  const presence = new Map<string, string>();
  const markerAliases = new Map<string, string>();
  const fields: [string, ProjectionField][] = [];

  const relationNames = new Set(
    Object.keys(sources).map((key) => key.toLowerCase())
  );

  let markerIndex = 0;

  const allocatePresence = (source: Source) => {
    let name = `__eqb_presence_${markerIndex}`;

    while (relationNames.has(name)) {
      markerIndex += 1;
      name = `__eqb_presence_${markerIndex}`;
    }

    markerIndex += 1;
    presence.set(source.name, name);

    return name;
  };

  const add = (expression: SqlExpression, slot: ProjectionSlot) => {
    const alias = projectionAlias(columns.length);
    columns.push({ alias, expression, slot });

    return alias;
  };

  const findMarker = (source: Source, path: FieldPath) => {
    const cached = markerAliases.get(source.name);

    if (cached !== undefined || !nullable.has(source.name)) {
      return cached;
    }

    const table = allocatePresence(source);

    const alias = add(
      markerExpression({ kind: "column", name: table, table }, grouped),
      { path, role: "presence" }
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

      for (const { alias, slot } of source.plan.columns) {
        const markers = slot.markers?.flatMap((input) => {
          const mapped = mapping.get(input);

          return mapped === undefined ? [] : [mapped];
        });

        const column = {
          kind: "column",
          name: alias,
          table: source.name,
        } as const;

        add(
          slot.role === "presence" || slot.role === "inherited presence"
            ? inheritedMarker(column, grouped)
            : column,
          {
            ...slot,
            path: [...path, ...slot.path],
            markers: requiresMarkers(marker, markers),
          }
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

        const alias = add(toExpressionNode(column), {
          encoding: encodedFamily(SchemaAST.toEncoded(column.schema.ast)),
          markers: requiresMarkers(marker),
          path: [...path, key],
          role: "value",
        });

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

    const marker =
      source === undefined || preservesNull(item.schema.ast)
        ? undefined
        : findMarker(source, path);

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
                inheritedMarker(
                  { kind: "column", name: input, table: source.name },
                  grouped
                ),
                { path, role: "inherited presence" }
              ),
            ] as const
        );

      const markers = inputs.map(([, alias]) => alias);

      const alias = add(
        { kind: "column", name: field.alias, table: source.name },
        {
          encoding: encodedFamily(SchemaAST.toEncoded(field.schema.ast)),
          markers: requiresMarkers(marker, markers),
          path,
          role: "value",
        }
      );

      const mapping = new Map([[field.alias, alias], ...inputs]);
      const projected = forwardField(field, mapping, marker);
      fields.push([key, projected]);

      return projected.decode;
    }

    const expressionCanBeNull =
      isExpression(item) &&
      item.references.some((column) => nullable.has(column.table.name));

    const alias = add(toExpressionNode(item), {
      encoding: encodedFamily(SchemaAST.toEncoded(item.schema.ast)),
      markers: requiresMarkers(marker),
      path,
      role: "value",
    });

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
          slot: { path: [], role: "empty projection" },
        },
      ],
      decode,
      fields: Object.fromEntries(fields),
      presence,
    };
  }

  return {
    columns,
    decode,
    fields: Object.fromEntries(fields),
    presence,
  };
};
