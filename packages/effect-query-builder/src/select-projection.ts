import { Array as Arr, Effect, Predicate, Schema, SchemaAST } from "effect";
import type { Types } from "effect";
import { forEach, map } from "effect/Effect";
import type { SqlConnection, Statement } from "effect/sql";

import {
  expressionSqlFamily,
  isExpression,
  numericResultSchema,
  numericTransportNumber,
  toExpressionNode,
} from "./expression.ts";
import type { Expression } from "./expression.ts";
import type {
  Expression as Node,
  Projection,
  SelectStatement,
} from "./kernel/ast.ts";
import { projectionAlias } from "./kernel/invariants.ts";
import {
  derivedDefinition,
  isDerivedSource,
  isSource,
} from "./select-source.ts";
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
  readonly resultSchema?: Schema.Constraint;
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
  markerExpression(
    {
      kind: "caseWhen",
      condition: operand,
      result: { kind: "numberLiteral", value: 1 },
    },
    grouped
  );

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

  return (
    value === null ||
    value === false ||
    value === 0 ||
    value === 0n ||
    value === "0"
  );
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
  readonly booleanCodec?: "predicate" | "bit";
  readonly numericTransport?: true;
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

const projectionEncoding: (
  schema: Schema.Constraint
) => Pick<ProjectionSlot, "encoding" | "booleanCodec" | "numericTransport"> = (
  schema
) => {
  const family = expressionSqlFamily(schema.ast);

  if (family === "number") {
    return { numericTransport: true, encoding: family };
  }

  const encoding = encodedFamily(SchemaAST.toEncoded(schema.ast));

  if (family === "boolean") {
    return { encoding, booleanCodec: "predicate" };
  }

  if (family === "boolean bit") {
    return { encoding, booleanCodec: "bit" };
  }

  return { encoding };
};

const matchesPredicate = (predicate: ProjectionSlot, other: ProjectionSlot) =>
  predicate.booleanCodec === "predicate" &&
  (other.encoding === "boolean" || other.booleanCodec === "bit");

const requiresMarkers = (
  marker: string | undefined,
  inherited: readonly string[] = []
) => (marker === undefined ? inherited : [...inherited, marker]);

type ProjectionColumn = ProjectionPlan["columns"][number];

const normalizeNumbers = (
  row: SqlConnection.Row,
  aliases: Iterable<string>
) => {
  let mapped: Types.Mutable<SqlConnection.Row> | undefined;

  for (const alias of aliases) {
    const value = row[alias];

    if (!Predicate.isBigInt(value) && !Predicate.isString(value)) {
      continue;
    }

    const number = numericTransportNumber(value);

    if (number !== null) {
      mapped ??= { ...row };
      mapped[alias] = number;
    }
  }

  return mapped ?? row;
};

export const withNumericSetTransport: (
  plan: ProjectionPlan,
  operands: readonly ProjectionPlan[]
) => ProjectionPlan = (plan, operands) => {
  const promotedPaths = new Set(
    operands.flatMap(({ columns }) =>
      columns
        .filter(({ slot }) => slot.numericTransport)
        .map(({ slot }) => JSON.stringify(slot.path))
    )
  );

  const promotedAliases = new Set(
    plan.columns.flatMap(({ alias, slot }) =>
      slot.encoding === "number" &&
      !slot.numericTransport &&
      promotedPaths.has(JSON.stringify(slot.path))
        ? [alias]
        : []
    )
  );

  if (promotedAliases.size === 0) {
    return plan;
  }

  const [first, ...rest] = plan.columns;

  const promoteColumn = (column: ProjectionColumn) =>
    promotedAliases.has(column.alias)
      ? { ...column, slot: { ...column.slot, numericTransport: true } as const }
      : column;

  return {
    ...plan,
    columns: [promoteColumn(first), ...rest.map(promoteColumn)],
    decode: (row) => plan.decode(normalizeNumbers(row, promotedAliases)),
    fields: Object.fromEntries(
      Object.entries(plan.fields).map(([key, field]) => [
        key,
        promotedAliases.has(field.alias)
          ? {
              ...field,
              decode: (row: SqlConnection.Row) =>
                field.decode(normalizeNumbers(row, [field.alias])),
              resultSchema: numericResultSchema(field.schema),
            }
          : field,
      ])
    ),
  };
};

const projectionLayout = (columns: readonly ProjectionColumn[]) => {
  const positions = new Map(columns.map(({ alias }, index) => [alias, index]));

  return JSON.stringify(
    columns.map(({ slot: { role, path, markers } }) => [
      role,
      path,
      markers
        ?.map((marker) => positions.get(marker))
        .filter(Predicate.isNumber) ?? [],
    ])
  );
};

const assertCompatibleEncoding = (
  left: readonly ProjectionColumn[],
  right: readonly ProjectionColumn[]
) => {
  if (
    left.some(({ slot }, index) => {
      const other = right[index]?.slot;

      return (
        slot.encoding !== undefined &&
        other?.encoding !== undefined &&
        slot.encoding !== other.encoding &&
        !matchesPredicate(slot, other) &&
        !matchesPredicate(other, slot)
      );
    })
  ) {
    throw new TypeError(
      "Set operation operands must have compatible encoded projections"
    );
  }
};

const omittableSetMarkers = (plan: ProjectionPlan, other: ProjectionPlan) => {
  const markers = new Map<string, string>();

  for (const [key, field] of Object.entries(plan.fields)) {
    const opposite = Object.hasOwn(other.fields, key)
      ? other.fields[key]
      : undefined;

    const { ast } = field.schema;

    if (
      field.inputs.length !== 2 ||
      opposite?.inputs.length !== 1 ||
      ast.encoding !== undefined ||
      !nonNullScalar.has(ast._tag) ||
      !preservesNull(opposite.schema.ast)
    ) {
      continue;
    }

    const marker = field.inputs.find((input) => input !== field.alias);
    const column = plan.columns.find(({ alias }) => alias === marker);

    if (
      column === undefined ||
      column.slot.path.length !== 1 ||
      plan.columns.some(
        ({ alias, slot }) =>
          alias !== field.alias && slot.markers?.includes(column.alias) === true
      )
    ) {
      continue;
    }

    markers.set(column.alias, opposite.alias);
  }

  return markers;
};

const incompatibleLayout = () =>
  new TypeError(
    "Set operation operands must have the same SQL projection layout"
  );

export const alignSetProjection: (
  left: ProjectionPlan,
  right: ProjectionPlan,
  query: SelectStatement<Statement.Fragment>
) => SelectStatement<Statement.Fragment> = (left, right, query) => {
  if (projectionLayout(left.columns) === projectionLayout(right.columns)) {
    assertCompatibleEncoding(left.columns, right.columns);

    return query;
  }

  const leftMarkers = omittableSetMarkers(left, right);
  const rightMarkers = omittableSetMarkers(right, left);

  const leftColumns = left.columns.filter(
    ({ alias }) => !leftMarkers.has(alias)
  );

  const rightColumns = right.columns.filter(
    ({ alias }) => !rightMarkers.has(alias)
  );

  if (projectionLayout(leftColumns) !== projectionLayout(rightColumns)) {
    throw incompatibleLayout();
  }

  assertCompatibleEncoding(leftColumns, rightColumns);

  const source = "__eqb_set_operand";

  const rightAliases = new Map(
    leftColumns.map(({ alias }, index) => [alias, rightColumns[index]?.alias])
  );

  const reproject = ({ alias }: ProjectionColumn) => {
    const forValue = leftMarkers.get(alias);
    const name = forValue ?? rightAliases.get(alias);

    if (name === undefined) {
      throw incompatibleLayout();
    }

    const column = { kind: "column", name, table: source } as const;

    return {
      alias,
      expression:
        forValue === undefined ? column : markerExpression(column, false),
    };
  };

  const [first, ...rest] = left.columns;

  return {
    from: { relation: { alias: source, kind: "subquery", query } },
    kind: "select",
    projections: [reproject(first), ...rest.map(reproject)],
  };
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
      ...field,
      alias,
      decode: remapDecode(field.decode, aliases, marker),
      inputs: [
        ...aliases.map(([, input]) => input),
        ...(marker === undefined ? [] : [marker]),
      ],
      nullable: field.nullable || marker !== undefined,
    };
  };

  const projectTable = (source: Source, path: FieldPath) => {
    const marker = findMarker(source, path);
    const topLevel = path.length === 0;

    if (isDerivedSource(source)) {
      const { plan } = derivedDefinition(source);
      const start = columns.length;

      const mapping = new Map(
        plan.columns.map(({ alias }, index) => [
          alias,
          projectionAlias(start + index),
        ])
      );

      for (const { alias, slot } of plan.columns) {
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
        for (const [key, field] of Object.entries(plan.fields)) {
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
          ...projectionEncoding(column.schema),
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
      const field = derivedDefinition(source).plan.fields[item.key];

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
          ...projectionEncoding(field.resultSchema ?? field.schema),
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
      ...projectionEncoding(item.schema),
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
