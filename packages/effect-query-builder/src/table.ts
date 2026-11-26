import { Effect, Predicate, Schema, Struct } from "effect";
import { flatMap, forEach } from "effect/Effect";
import * as Model from "effect/schema/Model";
import type {
  TypeId,
  Extract as Variant,
  Struct as VariantStruct,
} from "effect/schema/VariantSchema";
import type { Statement } from "effect/sql";

import { columnName, hasDuplicateColumnNames } from "./column-names.ts";
import type { ColumnNaming } from "./column-names.ts";
import { inferColumnStorage } from "./column-storage.ts";
import type { SqlTypes } from "./column-storage.ts";
import type { QualifiedName } from "./kernel/ast.ts";

type KeyOf<Fields> = Extract<keyof Fields, string | number>;

type ColumnKey<Fields> = `${KeyOf<Fields>}`;

type NonEmpty<T> = readonly [T, ...T[]];

type TableName = string | QualifiedName;

type ResolvedName<Name extends TableName> = Name extends string
  ? { readonly name: Name }
  : Name;

type Nullable<Encoded> = unknown extends Encoded
  ? boolean
  : null extends Encoded
    ? true
    : false;

type TableSchema<Name extends QualifiedName> = Name extends QualifiedName
  ? "schema" extends keyof Name
    ? Name["schema"]
    : undefined
  : never;

const ColumnTypeId = Symbol("effect-query-builder/Column");

export interface Column<
  Name extends QualifiedName = QualifiedName,
  Key extends string = string,
  Field extends Schema.Constraint = Schema.Constraint,
  IsNullable extends boolean = Nullable<Field["Encoded"]>,
  SchemaName extends QualifiedName["schema"] = TableSchema<Name>,
> {
  readonly [ColumnTypeId]: SchemaName;
  readonly table: Name;
  readonly key: Key;
  readonly name: string;
  readonly schema: Field;
  readonly nullable: IsNullable;
  readonly sqlType: SqlTypes;
  readonly default?: string;
  readonly generated: boolean;
}

type Columns<
  Name extends QualifiedName,
  Fields extends Schema.Struct.Fields,
> = {
  readonly [Key in KeyOf<Fields> as `${Key}`]: Column<
    Name,
    `${Key}`,
    Fields[Key]
  >;
};

export interface ColumnOptions {
  readonly name?: string;
  readonly sqlType?: string | Readonly<Partial<SqlTypes>>;
  readonly default?: string;
  readonly generated?: boolean;
}

interface ForeignKey<Key extends string> {
  readonly columns: NonEmpty<Key>;
  readonly references: NonEmpty<
    Pick<Column, typeof ColumnTypeId | "table" | "key" | "name">
  >;
}

interface Index<Key extends string> {
  readonly columns: NonEmpty<Key>;
  readonly name?: string;
  readonly unique?: boolean;
}

interface TableConstraints<Key extends string> {
  readonly primaryKey?: Key | NonEmpty<Key>;
  readonly foreignKeys?: readonly ForeignKey<Key>[];
  readonly unique?: readonly NonEmpty<Key>[];
  readonly indexes?: readonly Index<Key>[];
}

export interface TableOptions<
  Key extends string = string,
> extends TableConstraints<Key> {
  readonly columns?: Readonly<Record<string, ColumnOptions | undefined>>;
  readonly naming?: ColumnNaming;
}

interface NoColumnSettings {
  readonly columns?: never;
}

type ColumnSetting<Options, Key extends string | number> = Options extends {
  readonly columns: infer Settings;
}
  ? Settings extends Readonly<Record<`${Key}`, infer Setting>>
    ? string extends keyof Settings
      ? undefined
      : number extends keyof Settings
        ? undefined
        : Setting
    : undefined
  : undefined;

type ColumnOptionsCheck<Fields, Options> = Options extends {
  readonly columns: infer Settings;
}
  ? string extends keyof Settings
    ? unknown
    : Exclude<keyof Settings, KeyOf<Fields> | ColumnKey<Fields>> extends never
      ? unknown
      : never
  : unknown;

type WriteFields<
  Fields extends Schema.Struct.Fields,
  Options,
  Update extends boolean,
> = {
  readonly [
    Key in KeyOf<Fields> as ColumnSetting<Options, Key> extends {
      readonly generated: true;
    }
      ? never
      : Key
  ]: Update extends true
    ? Schema.optionalKey<Fields[Key]>
    : ColumnSetting<Options, Key> extends { readonly default: string }
      ? Schema.optionalKey<Fields[Key]>
      : Fields[Key];
};

type RowSchema = Schema.Constraint & {
  readonly Encoded: object;
  readonly fields: Schema.Struct.Fields;
};

type ModelInput = Pick<
  VariantStruct<VariantStruct.Fields>,
  typeof TypeId | "pipe"
>;

type ModelVariant<
  VariantName extends "select" | "insert" | "update",
  M extends ModelInput,
> = Variant<VariantName, VariantStruct<M[typeof TypeId]>>;

type ModelSelect<M extends ModelInput> = M extends RowSchema
  ? M
  : ModelVariant<"select", M>;

type ModelColumns<
  Select extends RowSchema,
  Insert extends RowSchema,
  Update extends RowSchema,
> = Select["fields"] &
  Omit<Insert["fields"], keyof Select["fields"]> &
  Omit<Update["fields"], keyof (Select["fields"] & Insert["fields"])>;

type ModelTableFields<M extends ModelInput> = ModelColumns<
  ModelSelect<M>,
  ModelVariant<"insert", M>,
  ModelVariant<"update", M>
>;

function resolveName<const Name extends TableName>(
  name: Name
): ResolvedName<Name>;
function resolveName(name: TableName) {
  return Object.freeze(Predicate.isString(name) ? { name } : { ...name });
}

const validateIdentifier = (identifier: string) => {
  if (identifier.length === 0 || identifier.includes("\0")) {
    throw new TypeError("SQL identifiers must be non-empty and contain no NUL");
  }
};

const fieldEntries = (fields: Schema.Struct.Fields) => {
  if (
    Object.getOwnPropertySymbols(fields).some(
      (symbol) =>
        Object.getOwnPropertyDescriptor(fields, symbol)?.enumerable === true
    )
  ) {
    throw new TypeError("SQL table fields must use string or numeric keys");
  }

  return Object.entries(fields);
};

function makeColumns<
  Name extends QualifiedName,
  Fields extends Schema.Struct.Fields,
>(
  table: Name,
  fields: Fields,
  naming: ColumnNaming | undefined,
  options: TableOptions | undefined
): {
  readonly byKey: Columns<Name, Fields>;
  readonly columns: readonly Column[];
};
function makeColumns(
  table: QualifiedName,
  fields: Schema.Struct.Fields,
  naming: ColumnNaming | undefined,
  options: TableOptions | undefined
) {
  validateIdentifier(table.name);

  if (table.schema !== undefined) {
    validateIdentifier(table.schema);
  }

  const settings = new Map(Object.entries(options?.columns ?? {}));

  const columns: readonly Column[] = fieldEntries(fields).map(
    ([key, schema]) => {
      const column = settings.get(key);
      settings.delete(key);
      const { nullable, sqlType } = inferColumnStorage(schema.ast);
      const override = column?.sqlType;
      const name = column?.name ?? columnName(key, options?.naming ?? naming);
      validateIdentifier(name);

      return Object.freeze({
        [ColumnTypeId]: table.schema,
        default: column?.default,
        generated: column?.generated ?? false,
        key,
        name,
        nullable,
        schema,
        sqlType: Object.freeze(
          Predicate.isString(override)
            ? { pg: override, sqlite: override, mysql: override }
            : {
                pg: override?.pg ?? sqlType.pg,
                sqlite: override?.sqlite ?? sqlType.sqlite,
                mysql: override?.mysql ?? sqlType.mysql,
              }
        ),
        table,
      } satisfies Column);
    }
  );

  if (settings.size > 0) {
    throw new TypeError(
      `Unknown SQL table fields: ${[...settings.keys()].join(", ")}`
    );
  }

  if (hasDuplicateColumnNames(columns.map((column) => column.name))) {
    throw new TypeError(
      `Duplicate physical column name in table ${table.name}`
    );
  }

  const byKey = Object.freeze(
    Object.fromEntries(columns.map((column) => [column.key, column]))
  );

  return { byKey, columns };
}

const copyKeys = <T>([first, ...rest]: NonEmpty<T>) =>
  Object.freeze([first, ...rest] as const);

const makeConstraints = <Key extends string>(
  keys: ReadonlySet<string>,
  options: TableOptions<Key> | undefined
) => {
  const { primaryKey, foreignKeys, unique, indexes } = options ?? {};

  const constraints: {
    -readonly [
      Property in keyof TableConstraints<Key>
    ]: TableConstraints<Key>[Property];
  } = {};

  const validate = (columns: NonEmpty<Key>) => {
    if (
      columns.length === 0 ||
      columns.some((key) => !keys.has(key)) ||
      new Set(columns).size !== columns.length
    ) {
      throw new TypeError(
        "SQL constraints must refer to distinct fields of the table"
      );
    }

    return copyKeys(columns);
  };

  if (primaryKey !== undefined) {
    constraints.primaryKey = Predicate.isString(primaryKey)
      ? validate([primaryKey])[0]
      : validate(primaryKey);
  }

  if (foreignKeys !== undefined) {
    constraints.foreignKeys = Object.freeze(
      foreignKeys.map(({ columns, references }) => {
        const [first] = references;

        if (
          columns.length !== references.length ||
          references.some(
            ({ table }) =>
              table.name !== first.table.name ||
              table.schema !== first.table.schema
          )
        ) {
          throw new TypeError(
            "Foreign keys must reference the same number of columns in one table"
          );
        }

        if (hasDuplicateColumnNames(references.map(({ name }) => name))) {
          throw new TypeError(
            "Foreign keys must reference distinct columns of the target table"
          );
        }

        return Object.freeze({
          columns: validate(columns),
          references: copyKeys(references),
        });
      })
    );
  }

  if (unique !== undefined) {
    constraints.unique = Object.freeze(unique.map(validate));
  }

  if (indexes !== undefined) {
    constraints.indexes = Object.freeze(
      indexes.map((index) => {
        if (index.name !== undefined) {
          validateIdentifier(index.name);
        }

        return Object.freeze({ ...index, columns: validate(index.columns) });
      })
    );
  }

  return Object.freeze(constraints);
};

const remapRow = (
  entries: readonly (readonly [string, unknown])[],
  names: ReadonlyMap<string, string>
) => {
  const result: [string, unknown][] = [];

  for (const [key, value] of entries) {
    const name = names.get(key);

    if (name !== undefined) {
      result.push([name, value]);
    }
  }

  return Object.fromEntries(result);
};

const makeTable = <
  Name extends QualifiedName,
  Fields extends Schema.Struct.Fields,
  Select extends RowSchema,
  Insert extends RowSchema,
  Update extends RowSchema,
>(
  name: Name,
  fields: Fields,
  select: Select,
  insert: Insert,
  update: Update,
  naming: ColumnNaming | undefined,
  options: TableOptions<ColumnKey<Fields>> | undefined
) => {
  const { byKey, columns } = makeColumns(name, fields, naming, options);

  const physicalKeys = new Map(
    columns.map((column) => [column.key, column.name])
  );

  const logicalKeys = new Map(
    columns.map((column) => [column.name, column.key])
  );

  const constraints = makeConstraints(new Set(physicalKeys.keys()), options);

  const decode = Schema.decodeUnknownEffect(select);

  const decodeRow = (row: Parameters<typeof decode>[0]) =>
    decode(
      Predicate.isObject(row) ? remapRow(Object.entries(row), logicalKeys) : row
    );

  const encode = <SchemaType extends RowSchema>(schema: SchemaType) => {
    const encodeEffect = Schema.encodeEffect(schema);

    return (row: SchemaType["Type"]) =>
      Effect.map(encodeEffect(row), (encoded) =>
        remapRow(Object.entries(encoded), physicalKeys)
      );
  };

  return Object.freeze({
    c: byKey,
    constraints,
    decodeRow,
    encodeInsert: encode(insert),
    encodeUpdate: encode(update),
    identifier: name,
    name: name.name,
    select,
    selectRows: (statement: Statement.Statement<unknown>) =>
      flatMap(statement.withoutTransform, (rows) =>
        forEach(rows, (row) => decodeRow(row))
      ),
    insert,
    update,
  });
};

function writeFields<
  Fields extends Schema.Struct.Fields,
  Options extends TableOptions | undefined,
  Update extends boolean,
>(
  fields: Fields,
  options: Options | undefined,
  update: Update
): WriteFields<Fields, Options, Update>;
function writeFields(
  fields: Schema.Struct.Fields,
  options: TableOptions | undefined,
  update: boolean
) {
  const entries: [string, Schema.Constraint][] = [];
  const settings = new Map(Object.entries(options?.columns ?? {}));

  for (const [key, schema] of fieldEntries(fields)) {
    const setting = settings.get(key);

    if (setting?.generated !== true) {
      entries.push([
        key,
        update || setting?.default !== undefined
          ? Schema.optionalKey(schema)
          : schema,
      ]);
    }
  }

  return Object.fromEntries(entries);
}

function plainInsert<
  Fields extends Schema.Struct.Fields,
  Options extends TableOptions | undefined,
>(
  schema: Schema.Struct<Fields>,
  options: Options | undefined
): Schema.Struct<WriteFields<Fields, Options, false>>;
function plainInsert(
  schema: Schema.Struct<Schema.Struct.Fields>,
  options: TableOptions | undefined
) {
  const hasWriteMetadata = Object.values(options?.columns ?? {}).some(
    (column) => column?.generated === true || column?.default !== undefined
  );

  if (!hasWriteMetadata) {
    return schema;
  }

  const insertFields = writeFields(schema.fields, options, false);
  const { checks, propertySignatures } = schema.ast;

  if (
    checks !== undefined &&
    (Object.keys(insertFields).length !== propertySignatures.length ||
      propertySignatures.some(
        ({ name, type }) =>
          Predicate.isSymbol(name) ||
          !Object.hasOwn(insertFields, name) ||
          insertFields[name]?.ast !== type
      ))
  ) {
    throw new TypeError(
      "Generated columns and database defaults cannot reshape a plain struct insert with whole-row checks"
    );
  }

  return schema.mapFields(() => insertFields, { unsafePreserveChecks: true });
}

function modelVariants<M extends ModelInput>(
  model: M
): {
  readonly select: ModelSelect<M>;
  readonly insert: ModelVariant<"insert", M>;
  readonly update: ModelVariant<"update", M>;
};
function modelVariants(model: ModelInput) {
  return {
    select: Model.extract(model, "select"),
    insert: "insert" in model ? model.insert : Model.extract(model, "insert"),
    update: "update" in model ? model.update : Model.extract(model, "update"),
  };
}

function modelFields<
  Select extends RowSchema,
  Insert extends RowSchema,
  Update extends RowSchema,
>(
  select: Select,
  insert: Insert,
  update: Update
): ModelColumns<Select, Insert, Update>;
function modelFields(select: RowSchema, insert: RowSchema, update: RowSchema) {
  const entries = new Map(fieldEntries(select.fields));

  for (const [key, field] of [
    ...fieldEntries(insert.fields),
    ...fieldEntries(update.fields),
  ]) {
    if (!entries.has(key)) {
      entries.set(key, field);
    }
  }

  return Object.fromEntries(entries);
}

const optionalFields: <Fields extends Schema.Struct.Fields>(
  fields: Fields
) => { readonly [Key in keyof Fields]: Schema.optionalKey<Fields[Key]> } =
  Struct.map(Schema.optionalKey);

const tableFactory = (naming?: ColumnNaming) => ({
  fromSchema<
    const Name extends TableName,
    Fields extends Schema.Struct.Fields,
    const Options extends TableOptions<NoInfer<ColumnKey<Fields>>> | undefined =
      | TableOptions<NoInfer<ColumnKey<Fields>>>
      | undefined,
  >(
    name: Name,
    schema: Schema.Struct<Fields>,
    ...[options]:
      | (undefined extends Options ? [] : never)
      | [options: Options & ColumnOptionsCheck<Fields, NoInfer<Options>>]
  ) {
    const insert = plainInsert<Fields, Options>(schema, options);

    const update = schema.mapFields((fields) =>
      writeFields<Fields, Options, true>(fields, options, true)
    );

    return makeTable(
      resolveName(name),
      schema.fields,
      schema,
      insert,
      update,
      naming,
      options
    );
  },
  fromModel<
    const Name extends TableName,
    M extends ModelInput,
    const Options extends TableOptions<
      NoInfer<ColumnKey<ModelTableFields<M>>>
    > = NoColumnSettings,
  >(
    name: Name,
    model: M,
    options?: Options &
      TableOptions<NoInfer<ColumnKey<ModelTableFields<M>>>> &
      ColumnOptionsCheck<ModelTableFields<M>, Options>
  ) {
    const { select, insert, update } = modelVariants(model);
    const fields = modelFields(select, insert, update);

    return makeTable(
      resolveName(name),
      fields,
      select,
      insert,
      update.mapFields(optionalFields),
      naming,
      options
    );
  },
});

export const Table = { ...tableFactory(), withNaming: tableFactory };
