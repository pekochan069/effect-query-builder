import {
  Array as Arr,
  Cause,
  Effect,
  Effectable,
  Predicate,
  Stream,
} from "effect";
import type { Option, Schema, Types } from "effect";
import { flatMap, forEach, map } from "effect/Effect";
import { SqlClient, SqlError, Statement } from "effect/sql";
import type { SqlConnection } from "effect/sql";

import { isExpression, isOrdering, toExpressionNode } from "./expression.ts";
import type {
  ExpressionInput,
  ExpressionReferences,
  Ordering,
  PredicateInput,
} from "./expression.ts";
import type {
  Expression,
  Join,
  Relation,
  SelectStatement,
} from "./kernel/ast.ts";
import { compileSelect, toSelectFragment } from "./select-compiler.ts";
import type { SelectDialect } from "./select-compiler.ts";
import { planProjection } from "./select-projection.ts";
import type {
  DecodeServices,
  ProjectionPlan,
  Selected,
  Selection,
} from "./select-projection.ts";
import { isColumn, isTableSource } from "./table.ts";
import type { TableSource } from "./table.ts";

type Scope = Readonly<Record<string, TableSource>>;

const emptyScope = Object.freeze({});

type EmptyScope = typeof emptyScope;

type AddSource<S extends Scope, T extends TableSource> = S &
  Readonly<Record<T["name"], T>>;

type Scoped<T, S extends Scope = Scope> = T | ((tables: S) => T);

type SqlExpression = Expression<Statement.Fragment>;

type SelectAst = SelectStatement<Statement.Fragment>;

type SelectJoin = Join<Statement.Fragment>;

type SelectError = SqlError.SqlError | Schema.SchemaError;

type OrderItem = ExpressionInput | Ordering;

type ScopeColumns<S extends Scope> = {
  [K in keyof S]: S[K]["c"][keyof S[K]["c"]];
}[keyof S];

type CheckInput<Input, S extends Scope> = [
  Exclude<ExpressionReferences<Input>, ScopeColumns<S>>,
] extends [never]
  ? unknown
  : never;

type CheckSelectionItem<Item, S extends Scope> = Item extends TableSource
  ? Item extends S[keyof S]
    ? unknown
    : never
  : CheckInput<Item, S>;

type InvalidSelection<P extends Selection, S extends Scope> = {
  [K in keyof P]: CheckSelectionItem<P[K], S> extends never ? K : never;
}[keyof P];

type CheckSelection<
  P extends Selection,
  S extends Scope,
> = P extends TableSource
  ? CheckSelectionItem<P, S>
  : [InvalidSelection<P, S>] extends [never]
    ? unknown
    : never;

type CheckFrom<P extends Selection, T extends TableSource> = CheckSelection<
  P,
  AddSource<EmptyScope, T>
>;

type NewSource<S extends Scope, T extends TableSource> = T &
  (keyof S extends never ? never : T["name"] extends keyof S ? never : unknown);

type Result<P extends Selection, N extends string, Override> = [
  Override,
] extends [never]
  ? Selected<P, N>
  : Override;

type Narrow<Row, Subset> = {
  readonly [K in keyof Row]: K extends keyof Subset ? Subset[K] : Row[K];
};

export interface SelectQuery<
  S extends Scope,
  P extends Selection,
  N extends string = never,
  D extends SelectDialect = SelectDialect,
  Override = never,
>
  extends
    Effect.Effect<
      readonly Result<P, N, Override>[],
      SelectError,
      SqlClient.SqlClient | DecodeServices<P>
    >,
    Statement.Fragment {
  readonly from: <const T extends TableSource>(
    source: T &
      (keyof S extends never ? unknown : never) &
      CheckFrom<P, NoInfer<T>>
  ) => SelectQuery<AddSource<S, T>, P, N, D, Override>;
  readonly select: <const Next extends Selection>(
    selection: Scoped<Next & CheckSelection<Next, S>, S>
  ) => SelectQuery<S, Next, N, D>;
  readonly innerJoin: <
    const T extends TableSource,
    const On extends PredicateInput,
  >(
    source: NewSource<S, T>,
    on: Scoped<
      On & CheckInput<On, AddSource<S, NoInfer<T>>>,
      AddSource<S, NoInfer<T>>
    >
  ) => SelectQuery<AddSource<S, T>, P, N, D, Override>;
  readonly leftJoin: <
    const T extends TableSource,
    const On extends PredicateInput,
  >(
    source: NewSource<S, T>,
    on: Scoped<
      On & CheckInput<On, AddSource<S, NoInfer<T>>>,
      AddSource<S, NoInfer<T>>
    >
  ) => SelectQuery<AddSource<S, T>, P, N | T["name"], D, Override>;
  readonly rightJoin: <
    const T extends TableSource,
    const On extends PredicateInput,
  >(
    source: NewSource<S, T>,
    on: Scoped<
      On & CheckInput<On, AddSource<S, NoInfer<T>>>,
      AddSource<S, NoInfer<T>>
    >
  ) => SelectQuery<
    AddSource<S, T>,
    P,
    N | Extract<keyof S, string>,
    D,
    Override
  >;
  readonly fullJoin: <
    const T extends TableSource,
    const On extends PredicateInput,
  >(
    source: NewSource<S, T>,
    on: Scoped<
      On & CheckInput<On, AddSource<S, NoInfer<T>>>,
      AddSource<S, NoInfer<T>>
    >
  ) => SelectQuery<
    AddSource<S, T>,
    P,
    N | Extract<keyof S, string> | T["name"],
    Exclude<D, "mysql">,
    Override
  >;
  readonly crossJoin: <const T extends TableSource>(
    source: NewSource<S, T>
  ) => SelectQuery<AddSource<S, T>, P, N, D, Override>;
  readonly where: <const T extends PredicateInput>(
    predicate: Scoped<T & CheckInput<T, S>, S>
  ) => SelectQuery<S, P, N, D, Override>;
  readonly having: <const T extends PredicateInput>(
    predicate: Scoped<T & CheckInput<T, S>, S>
  ) => SelectQuery<S, P, N, D, Override>;
  readonly groupBy: {
    <const T extends readonly ExpressionInput[]>(
      ...items: T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override>;
    <const T extends ExpressionInput>(
      item: (tables: S) => T & CheckInput<T, S>
    ): SelectQuery<S, P, N, D, Override>;
    <const T extends readonly ExpressionInput[]>(
      items: (tables: S) => T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override>;
  };
  readonly orderBy: {
    <const T extends readonly OrderItem[]>(
      ...items: T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override>;
    <const T extends OrderItem>(
      item: (tables: S) => T & CheckInput<T, S>
    ): SelectQuery<S, P, N, D, Override>;
    <const T extends readonly OrderItem[]>(
      items: (tables: S) => T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override>;
  };
  readonly limit: (count: number) => SelectQuery<S, P, N, D, Override>;
  readonly offset: (count: number) => SelectQuery<S, P, N, D, Override>;
  readonly distinct: () => SelectQuery<S, P, N, D, Override>;
  readonly $if: (
    condition: boolean,
    apply: (
      query: SelectQuery<S, P, N, D, Override>
    ) => SelectQuery<S, P, N, D, Override>
  ) => SelectQuery<S, P, N, D, Override>;
  readonly when: (
    condition: boolean,
    apply: (
      query: SelectQuery<S, P, N, D, Override>
    ) => SelectQuery<S, P, N, D, Override>
  ) => SelectQuery<S, P, N, D, Override>;
  readonly $narrow: <T extends Partial<NonNullable<Result<P, N, Override>>>>(
    ...check: Exclude<
      keyof T,
      keyof NonNullable<Result<P, N, Override>>
    > extends never
      ? []
      : [never]
  ) => SelectQuery<S, P, N, D, Narrow<Result<P, N, Override>, T>>;
  readonly $assertType: <T>(
    ...check: Types.Equals<Result<P, N, Override>, T> extends true
      ? []
      : [never]
  ) => SelectQuery<S, P, N, D, T>;
  readonly compile: (dialect: D) => ReturnType<typeof compileSelect>;
  readonly toFragment: (dialect?: D) => Statement.Fragment;
  readonly findOne: () => Effect.Effect<
    Result<P, N, Override>,
    SelectError | Cause.NoSuchElementError,
    SqlClient.SqlClient | DecodeServices<P>
  >;
  readonly findOneOption: () => Effect.Effect<
    Option.Option<Result<P, N, Override>>,
    SelectError,
    SqlClient.SqlClient | DecodeServices<P>
  >;
  readonly findNonEmpty: () => Effect.Effect<
    Arr.NonEmptyReadonlyArray<Result<P, N, Override>>,
    SelectError | Cause.NoSuchElementError,
    SqlClient.SqlClient | DecodeServices<P>
  >;
  readonly stream: () => Stream.Stream<
    Result<P, N, Override>,
    SelectError,
    SqlClient.SqlClient | DecodeServices<P>
  >;
}

type JoinedSource =
  | { readonly kind: "cross"; readonly source: TableSource }
  | {
      readonly kind: Exclude<SelectJoin["kind"], "cross">;
      readonly source: TableSource;
      readonly on: SqlExpression;
    };

interface SelectState {
  readonly source?: TableSource;
  readonly joins: readonly JoinedSource[];
  readonly scope: Scope;
  readonly selection?: Selection;
  readonly nullable: ReadonlySet<string>;
  readonly mysql: boolean;
  readonly distinct?: boolean;
  readonly where?: SqlExpression;
  readonly groupBy: readonly SqlExpression[];
  readonly having?: SqlExpression;
  readonly orderBy: readonly NonNullable<SelectAst["orderBy"]>[number][];
  readonly limit?: number;
  readonly offset?: number;
}

const empty: SelectState = {
  groupBy: [],
  joins: [],
  mysql: true,
  nullable: new Set(),
  orderBy: [],
  scope: emptyScope,
};

const resolve = <T>(scoped: Scoped<T>, scope: Scope) =>
  Predicate.isFunction(scoped) ? scoped(scope) : scoped;

const addSource = (scope: Scope, source: TableSource) => {
  if (
    Object.keys(scope).some(
      (name) => name.toLowerCase() === source.name.toLowerCase()
    )
  ) {
    throw new TypeError(
      `Duplicate SELECT source name: ${source.name}. Use an alias for each occurrence.`
    );
  }

  return Object.freeze({ ...scope, [source.name]: source });
};

const checkInput = (input: ExpressionInput, scope: Scope) => {
  const columns = isExpression(input) ? input.references : [];
  const references = isColumn(input) ? [input] : columns;

  for (const column of references) {
    const { name, schema } = column.table;
    const source = Object.hasOwn(scope, name) ? scope[name] : undefined;

    const match =
      source !== undefined && Object.hasOwn(source.c, column.key)
        ? source.c[column.key]
        : undefined;

    if (match?.name !== column.name || match.table.schema !== schema) {
      throw new TypeError(
        `Column ${name}.${column.name} is outside the SELECT scope`
      );
    }
  }
};

const checkSelection = (selection: Selection, scope: Scope) => {
  const items = isTableSource(selection)
    ? [selection]
    : Object.values(selection);

  for (const item of items) {
    if (!isTableSource(item)) {
      checkInput(item, scope);
    } else if (!Object.hasOwn(scope, item.name) || scope[item.name] !== item) {
      throw new TypeError(`Table ${item.name} is outside the SELECT scope`);
    }
  }
};

const constrain = (previous: SqlExpression | undefined, next: SqlExpression) =>
  previous === undefined
    ? next
    : ({
        kind: "binary",
        operator: "AND",
        left: previous,
        right: next,
      } satisfies SqlExpression);

const relation = (source: TableSource, plan: ProjectionPlan) =>
  ({
    alias: source.alias,
    kind: "table",
    name: source.identifier,
    presence: plan.presence.get(source.name),
  }) satisfies Relation<Statement.Fragment>;

const copySelection = (selection: Selection) =>
  isTableSource(selection) ? selection : Object.freeze({ ...selection });

class Query extends Effectable.Class<readonly unknown[], SelectError, unknown> {
  static {
    const { segments: _segments, ...brand } = Statement.fragment([]);
    Object.assign(this.prototype, brand);
  }

  readonly #state: SelectState;
  readonly #statements = new WeakMap<
    SqlClient.SqlClient,
    Statement.Statement<SqlConnection.Row>
  >();
  #planCache?: ProjectionPlan;
  #fragment?: Statement.Fragment;

  constructor(state: SelectState) {
    super();
    this.#state = state;
  }

  #copy(changes: Partial<SelectState>) {
    return new Query({ ...this.#state, ...changes });
  }

  from(source: TableSource) {
    if (this.#state.source !== undefined) {
      throw new TypeError("SELECT already has a FROM source");
    }

    return this.#copy({ scope: addSource(this.#state.scope, source), source });
  }

  select(selection: Scoped<Selection>) {
    return this.#copy({
      selection: copySelection(resolve(selection, this.#state.scope)),
    });
  }

  #join(
    kind: Exclude<SelectJoin["kind"], "cross">,
    source: TableSource,
    predicate: Scoped<PredicateInput>
  ) {
    if (this.#state.source === undefined) {
      throw new TypeError("SELECT joins require a FROM source");
    }

    const { joins, mysql, nullable } = this.#state;
    const scope = addSource(this.#state.scope, source);
    const input = resolve(predicate, scope);
    checkInput(input, scope);

    const on = toExpressionNode(input);

    const leftNulls =
      kind === "right" || kind === "full" ? Object.keys(this.#state.scope) : [];

    const rightNulls = kind === "left" || kind === "full" ? [source.name] : [];

    return this.#copy({
      joins: [...joins, { kind, on, source }],
      mysql: mysql && kind !== "full",
      nullable: new Set([...nullable, ...leftNulls, ...rightNulls]),
      scope,
    });
  }

  innerJoin(source: TableSource, on: Scoped<PredicateInput>) {
    return this.#join("inner", source, on);
  }

  leftJoin(source: TableSource, on: Scoped<PredicateInput>) {
    return this.#join("left", source, on);
  }

  rightJoin(source: TableSource, on: Scoped<PredicateInput>) {
    return this.#join("right", source, on);
  }

  fullJoin(source: TableSource, on: Scoped<PredicateInput>) {
    return this.#join("full", source, on);
  }

  crossJoin(source: TableSource) {
    if (this.#state.source === undefined) {
      throw new TypeError("SELECT joins require a FROM source");
    }

    return this.#copy({
      joins: [...this.#state.joins, { kind: "cross", source }],
      scope: addSource(this.#state.scope, source),
    });
  }

  where(predicate: Scoped<PredicateInput>) {
    const input = resolve(predicate, this.#state.scope);
    checkInput(input, this.#state.scope);

    return this.#copy({
      where: constrain(this.#state.where, toExpressionNode(input)),
    });
  }

  having(predicate: Scoped<PredicateInput>) {
    const input = resolve(predicate, this.#state.scope);
    checkInput(input, this.#state.scope);

    return this.#copy({
      having: constrain(this.#state.having, toExpressionNode(input)),
    });
  }

  groupBy(
    ...items: readonly Scoped<ExpressionInput | readonly ExpressionInput[]>[]
  ) {
    const nodes = items
      .flatMap((item) => resolve(item, this.#state.scope))
      .map((item) => {
        checkInput(item, this.#state.scope);

        return toExpressionNode(item);
      });

    return this.#copy({ groupBy: [...this.#state.groupBy, ...nodes] });
  }

  orderBy(...items: readonly Scoped<OrderItem | readonly OrderItem[]>[]) {
    const nodes = items
      .flatMap((item) => resolve(item, this.#state.scope))
      .map((item) => {
        const ordered = isOrdering(item);
        const input = ordered ? item.expression : item;
        checkInput(input, this.#state.scope);

        return {
          direction: ordered ? item.direction : ("asc" as const),
          expression: toExpressionNode(input),
        };
      });

    return this.#copy({ orderBy: [...this.#state.orderBy, ...nodes] });
  }

  limit(limit: number) {
    return this.#copy({ limit });
  }

  offset(offset: number) {
    return this.#copy({ offset });
  }

  distinct() {
    return this.#copy({ distinct: true });
  }

  $if(condition: boolean, apply: (query: Query) => Query) {
    return condition ? apply(this) : this;
  }

  when(condition: boolean, apply: (query: Query) => Query) {
    return this.$if(condition, apply);
  }

  $narrow() {
    return this;
  }

  $assertType() {
    return this;
  }

  #plan() {
    if (this.#planCache === undefined) {
      const { groupBy, nullable, scope, selection, source } = this.#state;
      const selected = selection ?? source;

      if (selected === undefined) {
        throw new TypeError("SELECT requires a projection or source");
      }

      checkSelection(selected, scope);
      this.#planCache = planProjection(
        selected,
        scope,
        nullable,
        groupBy.length > 0
      );
    }

    return this.#planCache;
  }

  #ast() {
    const {
      distinct,
      groupBy,
      having,
      joins,
      limit,
      offset,
      orderBy,
      source,
      where,
    } = this.#state;

    const plan = this.#plan();

    const selectJoins: SelectJoin[] = joins.map((join) =>
      join.kind === "cross"
        ? { kind: "cross", relation: relation(join.source, plan) }
        : {
            kind: join.kind,
            on: join.on,
            relation: relation(join.source, plan),
          }
    );

    return {
      distinct,
      from:
        source === undefined
          ? undefined
          : {
              joins: Arr.isReadonlyArrayNonEmpty(selectJoins)
                ? selectJoins
                : undefined,
              relation: relation(source, plan),
            },
      groupBy: Arr.isReadonlyArrayNonEmpty(groupBy) ? groupBy : undefined,
      having,
      kind: "select",
      limit: limit === undefined ? undefined : { count: limit },
      offset,
      orderBy: Arr.isReadonlyArrayNonEmpty(orderBy) ? orderBy : undefined,
      projections: plan.columns,
      where,
    } satisfies SelectAst;
  }

  toFragment(dialect?: SelectDialect) {
    if (dialect !== undefined) {
      return toSelectFragment(this.#ast(), dialect);
    }

    this.#fragment ??= toSelectFragment(this.#ast());

    return this.#fragment;
  }

  get segments() {
    return this.toFragment().segments;
  }

  compile(dialect: SelectDialect) {
    return compileSelect(this.#ast(), dialect);
  }

  #statement() {
    return flatMap(SqlClient.SqlClient, (client) => {
      const statement = this.#statements.get(client);

      if (statement !== undefined) {
        return Effect.succeed(statement);
      }

      const dialect = client.onDialectOrElse({
        mysql: () => "mysql" as const,
        orElse: () => null,
        pg: () => "pg" as const,
        sqlite: () => "sqlite" as const,
      });

      if (dialect === null || (dialect === "mysql" && !this.#state.mysql)) {
        const message =
          dialect === null
            ? "SELECT is unsupported by this SQL driver"
            : "FULL OUTER JOIN is unsupported by MySQL";

        return Effect.fail(
          new SqlError.SqlError({
            reason: new SqlError.UnknownError({
              cause: message,
              message,
              operation: "SELECT",
            }),
          })
        );
      }

      const sql = client.withoutTransforms();

      const compiled = sql`${this.toFragment(dialect)}`;

      this.#statements.set(client, compiled);

      return Effect.succeed(compiled);
    });
  }

  asEffect() {
    return flatMap(this.#statement(), (statement) =>
      flatMap(statement.withoutTransform, (rows) =>
        forEach(rows, this.#plan().decode)
      )
    );
  }

  findOneOption() {
    return flatMap(this.#statement(), (statement) =>
      flatMap(statement.withoutTransform, (rows) =>
        Arr.isReadonlyArrayNonEmpty(rows)
          ? Effect.asSome(this.#plan().decode(rows[0]))
          : Effect.succeedNone
      )
    );
  }

  findOne() {
    return flatMap(this.findOneOption(), Effect.fromOption);
  }

  findNonEmpty() {
    return flatMap(this.asEffect(), (rows) =>
      Arr.isReadonlyArrayNonEmpty(rows)
        ? Effect.succeed(rows)
        : Effect.fail(new Cause.NoSuchElementError())
    );
  }

  stream() {
    return Stream.unwrap(
      map(this.#statement(), (statement) =>
        Stream.mapEffect(statement.stream, this.#plan().decode)
      )
    );
  }
}

export function from<const T extends TableSource>(
  source: T
): SelectQuery<AddSource<EmptyScope, T>, T>;
export function from(source: TableSource) {
  const result: object = new Query(empty).from(source);

  return result;
}

export function select<const T extends TableSource>(
  selection: T
): SelectQuery<AddSource<EmptyScope, T>, T>;
export function select<const P extends Exclude<Selection, TableSource>>(
  selection: P
): SelectQuery<EmptyScope, P>;
export function select(selection: Selection) {
  const query = new Query(empty);

  const result: object = isTableSource(selection)
    ? query.from(selection)
    : query.select(selection);

  return result;
}
