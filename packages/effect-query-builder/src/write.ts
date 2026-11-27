import { Array as Arr, Effect, Effectable, Predicate } from "effect";
import type { Schema } from "effect";
import { flatMap, forEach, map } from "effect/Effect";
import { identity } from "effect/Function";
import { SqlClient } from "effect/sql";
import type { SqlError, Statement } from "effect/sql";

import { inferColumnStorage } from "./column-storage.ts";
import { getClientDialect, unsupportedDialect } from "./dialect.ts";
import type { CheckDialect } from "./dialect.ts";
import {
  isExpression,
  makeExpression,
  toExpressionNode,
} from "./expression.ts";
import type {
  Expression,
  ExpressionDialect,
  PredicateInput,
} from "./expression.ts";
import type {
  Expression as Node,
  InsertConflict,
  Projection,
  Statement as QueryStatement,
} from "./kernel/ast.ts";
import type { CompileTarget, SqlDialect } from "./kernel/compile.ts";
import { UnsupportedDialectClauseError } from "./kernel/errors.ts";
import { compileStatement, toStatementFragment } from "./select-compiler.ts";
import { planProjection } from "./select-projection.ts";
import type {
  DecodeServices,
  ProjectionPlan,
  Selected,
} from "./select-projection.ts";
import { isSource } from "./select-source.ts";
import type { ScalarEncoded, ScalarKey, ScalarValue } from "./select-source.ts";
import { QueryTypeId } from "./select.ts";
import type { OperandDialect, QueryOperand } from "./select.ts";
import { isColumn } from "./table.ts";
import type { Column, RowSchema, TableSource } from "./table.ts";
import {
  assertWriteReferences,
  encodeWriteRow,
  requiredWriteKeys,
  WriteInputError,
} from "./write-values.ts";
import type {
  CheckReferences,
  CheckWriteInput,
  SqlValueInput,
  WriteInput,
  WriteInputValues,
  WriteRow,
  WriteTargetColumns,
} from "./write-values.ts";

type NonEmpty<T> = Arr.NonEmptyReadonlyArray<T>;

type WriteAst = Extract<
  QueryStatement<Statement.Fragment>,
  { readonly kind: "insert" | "update" | "delete" }
>;

type WriteKind = WriteAst["kind"];

type WriteError = Schema.SchemaError | SqlError.SqlError | WriteInputError;

type Encoders<T extends TableSource, K extends WriteKind> = K extends "update"
  ? T["update"]["EncodingServices"]
  : never;

type InputRows<S extends RowSchema> = WriteInput<S> | readonly WriteInput<S>[];

type RowOf<Input> = Input extends readonly unknown[] ? Input[number] : Input;

type CompatibleValue<
  S extends RowSchema,
  Input,
  Allowed extends Column,
  D extends SqlDialect,
> = CheckWriteInput<S, NoInfer<Input>, Allowed> &
  CheckDialect<D & ExpressionDialect<WriteInputValues<NoInfer<Input>>>>;

type StringKey<K> = `${Extract<K, number | string>}`;

type SelectProjection<Q extends QueryOperand> = ReturnType<
  Q[typeof QueryTypeId]
>["selection"];

type SelectKeys<Q extends QueryOperand> = ScalarKey<SelectProjection<Q>>;

type SelectRow<Q extends QueryOperand> = Effect.Success<Q>[number];

type ForKey<Row, Key extends string> = Key extends keyof Row
  ? Row[Key]
  : Key extends `${infer N extends number}`
    ? Row[N & keyof Row]
    : never;

type SelectedSqlValue<Q extends QueryOperand, K extends SelectKeys<Q>> =
  | NonNullable<ScalarValue<SelectProjection<Q>, K>>
  | (null extends
      | ScalarEncoded<SelectProjection<Q>, K>
      | ForKey<SelectRow<Q>, K>
      ? null
      : never);

type RequiredEncodedKeys<S extends RowSchema> = StringKey<
  {
    [K in keyof S["Encoded"]]-?: S["Encoded"] extends Required<
      Pick<S["Encoded"], K>
    >
      ? K
      : never;
  }[keyof S["Encoded"]]
>;

type InvalidSelectFields<S extends RowSchema, Q extends QueryOperand> = {
  [K in keyof S["fields"]]-?: StringKey<K> extends SelectKeys<Q>
    ? [SelectedSqlValue<Q, StringKey<K>>] extends [S["fields"][K]["Encoded"]]
      ? never
      : K
    : never;
}[keyof S["fields"]];

type CheckInsertSelect<S extends RowSchema, Q extends QueryOperand> = [
  | Exclude<RequiredEncodedKeys<S>, SelectKeys<Q>>
  | Exclude<SelectKeys<Q>, StringKey<keyof S["fields"]>>
  | Exclude<StringKey<keyof SelectRow<Q>>, SelectKeys<Q>>
  | InvalidSelectFields<S, Q>,
] extends [never]
  ? [SelectKeys<Q>] extends [never]
    ? never
    : unknown
  : never;

type WriteProjection = Readonly<Record<string, SqlValueInput>>;

type ReturningSelection = TableSource | WriteProjection;

type ReturningDialects<K extends WriteKind, M extends boolean> =
  | "pg"
  | "sqlite"
  | (M extends true ? (K extends "update" ? never : "mysql") : never);

type WriteResult<P extends ReturningSelection> = [P] extends [never]
  ? undefined
  : readonly Selected<P, never>[];

type WriteDecoders<P extends ReturningSelection> = [P] extends [never]
  ? never
  : DecodeServices<P>;

interface WriteResultEffect<
  Row,
  D extends SqlDialect,
  EncodeR,
  DecodeR,
> extends Effect.Effect<
  Row,
  WriteError,
  SqlClient.SqlClient | EncodeR | DecodeR
> {
  readonly compile: (
    dialect: D
  ) => Effect.Effect<ReturnType<typeof compileStatement>, WriteError, EncodeR>;
  readonly toFragment: (
    dialect: D
  ) => Effect.Effect<Statement.Fragment, WriteError, EncodeR>;
}

type WriteReturn<
  K extends WriteKind,
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
  R,
  P extends ReturningSelection,
  Upsert extends boolean,
> = K extends "insert"
  ? InsertQuery<T, D, M, R, P, Upsert>
  : K extends "update" | "delete"
    ? ChangeQuery<K, T, D, M, R, P>
    : never;

type CheckProjection<
  P extends WriteProjection,
  T extends TableSource,
  D extends SqlDialect,
> = CheckReferences<NoInfer<P>[keyof P], WriteTargetColumns<T>> &
  CheckDialect<D & ExpressionDialect<NoInfer<P>[keyof P]>> &
  (Extract<keyof P, symbol> extends never ? unknown : never);

type Returning<
  K extends WriteKind,
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
  R,
  Upsert extends boolean = false,
> = [D & ReturningDialects<K, M>] extends [never]
  ? unknown
  : {
      readonly returning: {
        (): WriteReturn<K, T, D & ReturningDialects<K, M>, M, R, T, Upsert>;
        <const P extends WriteProjection>(
          selection: P & CheckProjection<P, T, D & ReturningDialects<K, M>>
        ): WriteReturn<
          K,
          T,
          D & ReturningDialects<K, M> & ExpressionDialect<P[keyof P]>,
          M,
          R,
          P,
          Upsert
        >;
      };
    };

export type InsertQuery<
  T extends TableSource,
  D extends SqlDialect = SqlDialect,
  M extends boolean = false,
  R = T["insert"]["EncodingServices"],
  P extends ReturningSelection = never,
  Upsert extends boolean = false,
> = WriteResultEffect<WriteResult<P>, D, R, WriteDecoders<P>> &
  Returning<"insert", T, D, M, R, Upsert> &
  (Upsert extends true ? unknown : ConflictMethods<T, D, M, R, P>);

type ConflictKey<T extends TableSource> = Extract<keyof T["c"], string>;

type ConflictTarget<T extends TableSource> =
  | ConflictKey<T>
  | NonEmpty<ConflictKey<T>>;

type ConflictDialect = "pg" | "sqlite";

type IncomingColumn<C extends Column> = Expression<
  C["schema"],
  never,
  SqlDialect,
  C["schema"]["Encoded"]
>;

interface UpsertScope<T extends TableSource> {
  readonly target: T;
  readonly incoming: <Key extends ConflictKey<T>>(
    key: Key
  ) => IncomingColumn<T["c"][Key]>;
}

type UpsertPatch<T extends TableSource, Input> =
  | Input
  | ((scope: UpsertScope<T>) => Input);

type UpsertInput<
  T extends TableSource,
  Input,
  D extends SqlDialect,
> = UpsertPatch<
  T,
  Input & CompatibleValue<T["update"], Input, WriteTargetColumns<T>, D>
>;

type UpdatedInsert<
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
  R,
  P extends ReturningSelection,
  Input,
> = InsertQuery<
  T,
  D & ExpressionDialect<WriteInputValues<Input>>,
  M,
  R | T["update"]["EncodingServices"],
  P,
  true
>;

type ConflictMethods<
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
  R,
  P extends ReturningSelection,
> = ([D & ConflictDialect] extends [never]
  ? unknown
  : {
      readonly onConflictDoNothing: (
        target?: ConflictTarget<T>
      ) => InsertQuery<T, D & ConflictDialect, M, R, P, true>;
      readonly onConflictDoUpdate: <
        const Input extends WriteInput<T["update"]>,
      >(
        target: ConflictTarget<T>,
        patch: UpsertInput<T, Input, D & ConflictDialect>
      ) => UpdatedInsert<T, D & ConflictDialect, M, R, P, Input>;
    }) &
  ("mysql" extends D
    ? {
        readonly onDuplicateKeyUpdate: <
          const Input extends WriteInput<T["update"]>,
        >(
          patch: UpsertInput<T, Input, "mysql">
        ) => UpdatedInsert<T, "mysql", M, R, P, Input>;
      }
    : unknown);

type ScopedPredicate<P extends PredicateInput, T extends TableSource> =
  | P
  | ((target: T) => P);

type ChangeQuery<
  K extends "update" | "delete",
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
  R = Encoders<T, K>,
  P extends ReturningSelection = never,
> = WriteResultEffect<WriteResult<P>, D, R, WriteDecoders<P>> &
  Returning<K, T, D, M, R> & {
    readonly where: <const Predicate extends PredicateInput>(
      predicate: ScopedPredicate<
        Predicate &
          CheckReferences<NoInfer<Predicate>, WriteTargetColumns<T>> &
          CheckDialect<D & ExpressionDialect<NoInfer<Predicate>>>,
        T
      >
    ) => ChangeQuery<K, T, D & ExpressionDialect<Predicate>, M, R, P>;
  };

export type UpdateQuery<
  T extends TableSource,
  D extends SqlDialect = SqlDialect,
  M extends boolean = false,
  P extends ReturningSelection = never,
> = ChangeQuery<"update", T, D, M, T["update"]["EncodingServices"], P>;

export type DeleteQuery<
  T extends TableSource,
  D extends SqlDialect = SqlDialect,
  M extends boolean = false,
  P extends ReturningSelection = never,
> = ChangeQuery<"delete", T, D, M, never, P>;

interface InsertBuilder<
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
> {
  readonly values: <const Input extends InputRows<T["insert"]>>(
    input: Input &
      (NoInfer<Input> extends readonly [] ? never : unknown) &
      CompatibleValue<T["insert"], RowOf<Input>, never, D>
  ) => InsertQuery<T, D & ExpressionDialect<WriteInputValues<RowOf<Input>>>, M>;
  readonly fromSelect: <Q extends QueryOperand>(
    query: Q &
      CheckInsertSelect<T["insert"], NoInfer<Q>> &
      CheckDialect<D & OperandDialect<NoInfer<Q>>>
  ) => InsertQuery<T, D & OperandDialect<Q>, M, never>;
}

interface UpdateBuilder<
  T extends TableSource,
  D extends SqlDialect,
  M extends boolean,
> {
  readonly set: <const Input extends WriteInput<T["update"]>>(
    patch: Input & CompatibleValue<T["update"], Input, WriteTargetColumns<T>, D>
  ) => UpdateQuery<T, D & ExpressionDialect<WriteInputValues<Input>>, M>;
}

export interface WriteEntrypoints<D extends SqlDialect, M extends boolean> {
  readonly insertInto: <const T extends TableSource>(
    table: T & (T extends { readonly alias: string } ? never : unknown)
  ) => InsertBuilder<T, D, M>;
  readonly update: <const T extends TableSource>(
    table: T
  ) => UpdateBuilder<T, D, M>;
  readonly deleteFrom: <const T extends TableSource>(
    table: T
  ) => DeleteQuery<T, D, M>;
}

const defaultValue = { kind: "defaultValue" } as const;
const insertSourceAlias = "__eqb_insert_source";

const insertRows = (
  table: TableSource,
  input: WriteRow | readonly WriteRow[]
) =>
  Effect.gen(function* buildInsert() {
    if (table.alias !== undefined) {
      return yield* new WriteInputError({
        message: "INSERT requires an unaliased table",
      });
    }

    const rows = Arr.isArray<WriteRow | readonly WriteRow[]>(input)
      ? input
      : [input];

    if (!Arr.isReadonlyArrayNonEmpty(rows)) {
      return yield* new WriteInputError({
        message: "INSERT requires at least one row",
      });
    }

    const encoded = yield* forEach(rows, (row) =>
      encodeWriteRow(table, "insert", row)
    );

    const columnNames = new Set(
      encoded.flatMap((row) => row.map(({ column }) => column))
    );

    const columns = Object.values(table.c)
      .map(({ name }) => name)
      .filter((name) => columnNames.has(name));

    if (!Arr.isReadonlyArrayNonEmpty(columns)) {
      return {
        defaultColumn: Object.values(table.c)[0]?.name,
        defaultRows: encoded.length,
        kind: "insert",
        table: table.identifier,
      } satisfies WriteAst;
    }

    const [firstColumn, ...restColumns] = columns;

    const renderedRows = encoded.map((row) => {
      const values = new Map(row.map(({ column, value }) => [column, value]));
      const value = (column: string) => values.get(column) ?? defaultValue;

      return [value(firstColumn), ...restColumns.map(value)] satisfies NonEmpty<
        Node<Statement.Fragment>
      >;
    });

    if (!Arr.isReadonlyArrayNonEmpty(renderedRows)) {
      return yield* new WriteInputError({
        message: "INSERT requires at least one row",
      });
    }

    return {
      columns,
      kind: "insert",
      rows: renderedRows,
      table: table.identifier,
    } satisfies WriteAst;
  });

const insertSelect = (table: TableSource, query: QueryOperand) =>
  Effect.gen(function* buildInsertSelect() {
    if (table.alias !== undefined) {
      return yield* new WriteInputError({
        message: "INSERT requires an unaliased table",
      });
    }

    const { ast, plan, selection } = query[QueryTypeId]();
    const keys = Object.keys(plan.fields);

    if (
      !Arr.isReadonlyArrayNonEmpty(keys) ||
      (!isSource(selection) && keys.length !== Object.keys(selection).length) ||
      plan.columns.some(({ slot }) => slot.path.length > 1)
    ) {
      return yield* new WriteInputError({
        message: "INSERT SELECT requires named scalar projections",
      });
    }

    for (const required of requiredWriteKeys(table.insert)) {
      if (!Object.hasOwn(plan.fields, required)) {
        return yield* new WriteInputError({
          message: `INSERT SELECT is missing column ${required}`,
        });
      }
    }

    const columns: string[] = [];
    const projections: Projection<Statement.Fragment>[] = [];

    for (const key of keys) {
      const field = plan.fields[key];

      const target = Object.hasOwn(table.insert.fields, key)
        ? table.insert.fields[key]
        : undefined;

      const column = table.c[key];

      if (field === undefined || target === undefined || column === undefined) {
        return yield* new WriteInputError({
          message: `INSERT SELECT has no insert column ${key}`,
        });
      }

      const sourceNullable =
        field.nullable || inferColumnStorage(field.schema.ast).nullable;

      const targetNullable = inferColumnStorage(target.ast).nullable;

      if (sourceNullable && !targetNullable) {
        return yield* new WriteInputError({
          message: `INSERT SELECT cannot write nullable projection ${key}`,
        });
      }

      columns.push(column.name);
      projections.push({
        expression: {
          kind: "column",
          name: field.alias,
          table: insertSourceAlias,
        },
      });
    }

    if (
      !Arr.isReadonlyArrayNonEmpty(columns) ||
      !Arr.isReadonlyArrayNonEmpty(projections)
    ) {
      return yield* new WriteInputError({
        message: "INSERT SELECT requires named scalar projections",
      });
    }

    return {
      columns,
      kind: "insert",
      select: {
        from: {
          relation: { alias: insertSourceAlias, kind: "subquery", query: ast },
        },
        kind: "select",
        projections,
      },
      table: table.identifier,
    } satisfies WriteAst;
  });

const requiredAssignments = (
  table: TableSource,
  input: WriteRow,
  clause: string
) =>
  Effect.gen(function* buildAssignments() {
    const assignments = yield* encodeWriteRow(table, "update", input);

    if (!Arr.isReadonlyArrayNonEmpty(assignments)) {
      return yield* new WriteInputError({
        message: `${clause} requires at least one assignment`,
      });
    }

    return assignments;
  });

const updateAssignments = (table: TableSource, input: WriteRow) =>
  map(
    requiredAssignments(table, input, "UPDATE"),
    (assignments) =>
      ({
        alias: table.alias,
        assignments,
        kind: "update",
        table: table.identifier,
      }) satisfies WriteAst
  );

const operation = {
  delete: "DELETE",
  insert: "INSERT",
  update: "UPDATE",
} as const;

const conflictColumns = (
  table: TableSource,
  target: string | readonly string[]
) =>
  Effect.gen(function* resolveConflictColumns() {
    const keys = Predicate.isString(target) ? [target] : target;
    const columns: string[] = [];

    if (!Arr.isArray(keys)) {
      return yield* new WriteInputError({
        message: "A conflict target needs distinct columns",
      });
    }

    for (const key of keys) {
      const column = Object.hasOwn(table.c, key) ? table.c[key] : undefined;

      if (column === undefined) {
        return yield* new WriteInputError({
          message: `Unknown conflict column: ${key}`,
        });
      }

      columns.push(column.name);
    }

    if (
      !Arr.isReadonlyArrayNonEmpty(columns) ||
      new Set(columns).size !== columns.length
    ) {
      return yield* new WriteInputError({
        message: "A conflict target needs distinct columns",
      });
    }

    return columns;
  });

const incomingColumn = (target: TableSource, key: string) => {
  const column = Object.hasOwn(target.c, key) ? target.c[key] : undefined;

  if (column === undefined) {
    throw new WriteInputError({ message: `Unknown incoming column: ${key}` });
  }

  return makeExpression(
    column.schema,
    { kind: "incomingColumn", name: column.name },
    []
  ) satisfies IncomingColumn<Column>;
};

const upsertAssignments = (
  target: TableSource,
  patch: UpsertPatch<TableSource, WriteRow>,
  clause: string
) =>
  Effect.gen(function* buildUpsertAssignments() {
    let values: WriteRow;

    try {
      values = Predicate.isFunction(patch)
        ? patch({ target, incoming: (key) => incomingColumn(target, key) })
        : patch;
    } catch (error) {
      if (error instanceof WriteInputError) {
        return yield* error;
      }

      throw error;
    }

    return yield* requiredAssignments(target, values, clause);
  });

interface WriteState {
  readonly target: TableSource;
  readonly kind: WriteKind;
  readonly dialect?: SqlDialect;
  readonly mariadb: boolean;
  readonly build: Effect.Effect<
    WriteAst,
    Schema.SchemaError | WriteInputError,
    unknown
  >;
  readonly predicate?: Node<Statement.Fragment>;
  readonly projection?: ProjectionPlan;
}

type ConflictEffect = Effect.Effect<
  InsertConflict<Statement.Fragment>,
  Schema.SchemaError | WriteInputError,
  unknown
>;

class Write extends Effectable.Class<
  readonly unknown[] | undefined,
  WriteError,
  unknown
> {
  readonly #state: WriteState;

  constructor(state: WriteState) {
    super();
    this.#state = state;
  }

  #withConflict(conflict: ConflictEffect) {
    return new Write({
      ...this.#state,
      build: flatMap(this.#state.build, (statement) => {
        if (statement.kind !== "insert") {
          return Effect.fail(
            new WriteInputError({ message: "An upsert needs an INSERT" })
          );
        }

        return map(conflict, (clause) => ({
          ...statement,
          conflict: clause,
        }));
      }),
    });
  }

  onConflictDoNothing(target?: string | readonly string[]) {
    const columns =
      target === undefined
        ? Effect.succeed(undefined)
        : conflictColumns(this.#state.target, target);

    return this.#withConflict(
      map(columns, (value) => ({
        columns: value,
        kind: "doNothing",
      }))
    );
  }

  onConflictDoUpdate(
    target: string | readonly string[],
    patch: UpsertPatch<TableSource, WriteRow>
  ) {
    const table = this.#state.target;

    const conflict = Effect.gen(function* buildConflict() {
      const columns = yield* conflictColumns(table, target);
      const assignments = yield* upsertAssignments(table, patch, "DO UPDATE");

      return {
        assignments,
        columns,
        kind: "doUpdate",
      } satisfies InsertConflict<Statement.Fragment>;
    });

    return this.#withConflict(conflict);
  }

  onDuplicateKeyUpdate(patch: UpsertPatch<TableSource, WriteRow>) {
    return this.#withConflict(
      map(
        upsertAssignments(this.#state.target, patch, "ON DUPLICATE KEY UPDATE"),
        (assignments) => ({ assignments, kind: "duplicateKeyUpdate" })
      )
    );
  }

  where(input: PredicateInput | ((target: TableSource) => PredicateInput)) {
    const current = this.#state.predicate;

    const value = Predicate.isFunction(input)
      ? input(this.#state.target)
      : input;

    assertWriteReferences(value, this.#state.target);

    const predicate = toExpressionNode(value);

    return new Write({
      ...this.#state,
      predicate:
        current === undefined
          ? predicate
          : {
              kind: "binary",
              left: current,
              operator: "AND",
              right: predicate,
            },
    });
  }

  returning(selection: ReturningSelection = this.#state.target) {
    const { target } = this.#state;

    if (!isSource(selection)) {
      for (const item of Object.values(selection)) {
        if (!isColumn(item) && !isExpression(item)) {
          throw new WriteInputError({
            message: "RETURNING requires columns or typed SQL expressions",
          });
        }

        assertWriteReferences(item, target);
      }
    } else if (target !== selection) {
      throw new WriteInputError({
        message: "RETURNING requires the write target",
      });
    }

    return new Write({
      ...this.#state,
      projection: planProjection(
        selection,
        { [target.name]: target },
        new Set(),
        false
      ),
    });
  }

  #render<A>(
    dialect: SqlDialect,
    render: (ast: WriteAst, target: CompileTarget) => A
  ) {
    const { build, kind, mariadb, predicate, projection } = this.#state;
    const op = operation[kind];
    const locked = this.#state.dialect;

    if (locked !== undefined && dialect !== locked) {
      return unsupportedDialect(
        op,
        `${op} scoped to ${locked} is unsupported by the ${dialect} dialect`
      );
    }

    const target: CompileTarget =
      mariadb && dialect === "mysql"
        ? { dialect, mariadbReturning: true }
        : dialect;

    return flatMap(build, (statement) => {
      try {
        const projected = { ...statement, returning: projection?.columns };

        const ast =
          projected.kind === "insert"
            ? projected
            : { ...projected, where: predicate };

        return Effect.succeed(render(ast, target));
      } catch (error) {
        if (error instanceof UnsupportedDialectClauseError) {
          return unsupportedDialect(op, error.message, error);
        }

        throw error;
      }
    });
  }

  compile(dialect: SqlDialect) {
    return this.#render(dialect, compileStatement);
  }

  toFragment(dialect: SqlDialect) {
    return this.#render(dialect, toStatementFragment);
  }

  override asEffect() {
    const { kind, projection } = this.#state;

    return flatMap(SqlClient.SqlClient, (client) => {
      const dialect = getClientDialect(client);
      const op = operation[kind];

      if (dialect === null) {
        return unsupportedDialect(
          op,
          `${op} is unsupported by this SQL driver`
        );
      }

      return flatMap(this.toFragment(dialect), (fragment) => {
        const sql = client.withoutTransforms();
        const statement = sql`${fragment}`.withoutTransform;

        return projection === undefined
          ? Effect.as(statement, undefined)
          : flatMap(statement, (rows) => forEach(rows, projection.decode));
      });
    });
  }
}

export function writeForDialect<
  const D extends SqlDialect = SqlDialect,
  const M extends boolean = false,
>(dialect?: D, mariadb?: M): WriteEntrypoints<D, M>;
export function writeForDialect(dialect?: SqlDialect, mariadb = false) {
  return identity<object>({
    deleteFrom(target: TableSource) {
      return new Write({
        build: Effect.succeed({
          alias: target.alias,
          kind: "delete",
          table: target.identifier,
        }),
        dialect,
        kind: "delete",
        mariadb,
        target,
      });
    },
    insertInto(target: TableSource) {
      return {
        fromSelect: (query: QueryOperand) =>
          new Write({
            build: insertSelect(target, query),
            dialect,
            kind: "insert",
            mariadb,
            target,
          }),
        values: (input: WriteRow | readonly WriteRow[]) =>
          new Write({
            build: insertRows(target, input),
            dialect,
            kind: "insert",
            mariadb,
            target,
          }),
      };
    },
    update(target: TableSource) {
      return {
        set: (input: WriteRow) =>
          new Write({
            build: updateAssignments(target, input),
            dialect,
            kind: "update",
            mariadb,
            target,
          }),
      };
    },
  });
}

const portable = writeForDialect();

export const deleteFrom: WriteEntrypoints<SqlDialect, false>["deleteFrom"] =
  portable.deleteFrom;

export const insertInto: WriteEntrypoints<SqlDialect, false>["insertInto"] =
  portable.insertInto;

export const update: WriteEntrypoints<SqlDialect, false>["update"] =
  portable.update;
