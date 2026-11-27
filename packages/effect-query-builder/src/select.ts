import {
  Array as Arr,
  Cause,
  Effect,
  Effectable,
  Predicate,
  Schema,
  Stream,
} from "effect";
import type { Option, Types } from "effect";
import { flatMap, forEach, map } from "effect/Effect";
import { SqlClient, SqlError, Statement } from "effect/sql";
import type { SqlConnection } from "effect/sql";

import {
  isExpression,
  isOrdering,
  makeExpression,
  toExpressionNode,
} from "./expression.ts";
import type {
  Expression as SelectExpression,
  ExpressionDialect,
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
import { UnsupportedDialectClauseError } from "./kernel/errors.ts";
import { compileSelect, toSelectFragment } from "./select-compiler.ts";
import type { SelectDialect } from "./select-compiler.ts";
import {
  assertCompatibleProjections,
  planProjection,
} from "./select-projection.ts";
import type {
  DecodeServices,
  ProjectionPlan,
  Selected,
  Selection,
} from "./select-projection.ts";
import {
  isDerivedSource,
  isSource,
  makeDerivedSource,
} from "./select-source.ts";
import type {
  DerivedSelection,
  ScalarKey,
  ScalarSchema,
  Source,
  SourceDialect,
} from "./select-source.ts";
import { isColumn } from "./table.ts";

type Scope = Readonly<Record<string, Source>>;

const emptyScope = Object.freeze({});

type EmptyScope = typeof emptyScope;

type SourceEntry<T extends Source> = Readonly<Record<T["name"], T>>;

type Scoped<T, S extends Scope = Scope> = T | ((tables: S) => T);

type SqlExpression = Expression<Statement.Fragment>;

type SelectAst = SelectStatement<Statement.Fragment>;

type SelectJoin = Join<Statement.Fragment>;

type Cte = NonNullable<SelectAst["with"]>[number];

type SetOperator = NonNullable<SelectAst["sets"]>[number]["operator"];

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

type CheckSelectionItem<Item, S extends Scope> = Item extends Source
  ? Item extends S[keyof S]
    ? unknown
    : never
  : CheckInput<Item, S>;

type InvalidSelection<P extends Selection, S extends Scope> = {
  [K in keyof P]: K extends symbol
    ? K
    : CheckSelectionItem<P[K], S> extends never
      ? K
      : never;
}[keyof P];

type CheckSelection<P extends Selection, S extends Scope> = P extends Source
  ? CheckSelectionItem<P, S>
  : [InvalidSelection<P, S>] extends [never]
    ? unknown
    : never;

type FromProjection<P extends Selection, T extends Source> = [P] extends [never]
  ? T
  : P;

type CheckFrom<P extends Selection, T extends Source> = [P] extends [never]
  ? unknown
  : CheckSelection<P, SourceEntry<T>>;

type SelectionDialect<P extends Selection> = P extends Source
  ? SourceDialect<P>
  : ExpressionDialect<P[keyof P]>;

type NewSource<S extends Scope, T extends Source> = T &
  (keyof S extends never ? never : T["name"] extends keyof S ? never : unknown);

type Result<P extends Selection, N extends string, Override> = [
  Override,
] extends [never]
  ? Selected<P, N>
  : Override;

type Narrow<Row, Subset> = {
  readonly [K in keyof Row]: K extends keyof Subset ? Subset[K] : Row[K];
};

const QueryTypeId = Symbol("effect-query-builder/SelectQuery");

interface QuerySnapshot<P extends Selection = Selection> {
  readonly plan: ProjectionPlan;
  readonly ast: SelectAst;
  readonly selection: P;
  readonly mysql: boolean;
}

interface QueryOperand extends Effect.Effect<
  readonly unknown[],
  SelectError,
  unknown
> {
  readonly [QueryTypeId]: () => QuerySnapshot;
  readonly compile: (dialect: never) => ReturnType<typeof compileSelect>;
}

type OperandRow<Q extends QueryOperand> = Effect.Success<Q>[number];

type OperandDialect<Q extends QueryOperand> = Parameters<Q["compile"]>[0];

type OperandSource<
  Name extends string,
  Q extends QueryOperand,
> = DerivedSelection<
  Name,
  ReturnType<Q[typeof QueryTypeId]>["selection"],
  OperandRow<Q>,
  Exclude<Effect.Services<Q>, SqlClient.SqlClient>,
  OperandDialect<Q>
>;

type SetOperand<Q extends QueryOperand, Row> = Q &
  (Types.Equals<OperandRow<Q>, Row> extends true ? unknown : never);

export interface SelectQuery<
  S extends Scope,
  P extends Selection,
  N extends string = never,
  D extends SelectDialect = SelectDialect,
  Override = never,
  C extends Scope = EmptyScope,
>
  extends
    Effect.Effect<
      readonly Result<P, N, Override>[],
      SelectError,
      SqlClient.SqlClient | DecodeServices<P>
    >,
    Statement.Fragment {
  readonly [QueryTypeId]: () => QuerySnapshot<P>;
  readonly as: <const Name extends string>(
    name: Name
  ) => DerivedSelection<
    Name,
    P,
    Result<P, N, Override>,
    DecodeServices<P>,
    D & SelectionDialect<P>
  >;
  readonly scalar: <const Key extends ScalarKey<P>>(
    key: Key
  ) => SelectExpression<
    ScalarSchema<P, Key, Result<P, N, Override>>,
    never,
    D & SelectionDialect<P>
  >;
  readonly with: <const Name extends string, Q extends QueryOperand>(
    name: Name & (Name extends keyof C ? never : unknown),
    query: Scoped<Q, C>
  ) => SelectQuery<
    S,
    P,
    N,
    D & OperandDialect<Q>,
    Override,
    C & SourceEntry<OperandSource<Name, Q>>
  >;
  readonly union: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>>
  ) => SelectQuery<S, P, N, D & OperandDialect<Q>, Override, C>;
  readonly unionAll: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>>
  ) => SelectQuery<S, P, N, D & OperandDialect<Q>, Override, C>;
  readonly intersect: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>>
  ) => SelectQuery<S, P, N, D & OperandDialect<Q>, Override, C>;
  readonly except: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>>
  ) => SelectQuery<S, P, N, D & OperandDialect<Q>, Override, C>;
  readonly from: <const T extends Source>(
    source: Scoped<
      T & (keyof S extends never ? unknown : never) & CheckFrom<P, NoInfer<T>>,
      C
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    FromProjection<P, T>,
    N,
    D & SourceDialect<T>,
    Override,
    C
  >;
  readonly select: <const Next extends Selection>(
    selection: Scoped<Next & CheckSelection<Next, S>, S>
  ) => SelectQuery<S, Next, N, D, never, C>;
  readonly innerJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<NewSource<S, T>, C>,
    on: Scoped<
      On & CheckInput<On, S & SourceEntry<NoInfer<T>>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<S & SourceEntry<T>, P, N, D & SourceDialect<T>, Override, C>;
  readonly leftJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<NewSource<S, T>, C>,
    on: Scoped<
      On & CheckInput<On, S & SourceEntry<NoInfer<T>>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N | T["name"],
    D & SourceDialect<T>,
    Override,
    C
  >;
  readonly rightJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<NewSource<S, T>, C>,
    on: Scoped<
      On & CheckInput<On, S & SourceEntry<NoInfer<T>>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N | Extract<keyof S, string>,
    D & SourceDialect<T>,
    never,
    C
  >;
  readonly fullJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<NewSource<S, T>, C>,
    on: Scoped<
      On & CheckInput<On, S & SourceEntry<NoInfer<T>>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N | Extract<keyof S, string> | T["name"],
    Exclude<D & SourceDialect<T>, "mysql">,
    never,
    C
  >;
  readonly crossJoin: <const T extends Source>(
    source: Scoped<NewSource<S, T>, C>
  ) => SelectQuery<S & SourceEntry<T>, P, N, D & SourceDialect<T>, Override, C>;
  readonly where: <const T extends PredicateInput>(
    predicate: Scoped<T & CheckInput<T, S>, S>
  ) => SelectQuery<S, P, N, D, Override, C>;
  readonly having: <const T extends PredicateInput>(
    predicate: Scoped<T & CheckInput<T, S>, S>
  ) => SelectQuery<S, P, N, D, Override, C>;
  readonly groupBy: {
    <const T extends readonly ExpressionInput[]>(
      ...items: T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override, C>;
    <const T extends ExpressionInput>(
      item: (tables: S) => T & CheckInput<T, S>
    ): SelectQuery<S, P, N, D, Override, C>;
    <const T extends readonly ExpressionInput[]>(
      items: (tables: S) => T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override, C>;
  };
  readonly orderBy: {
    <const T extends readonly OrderItem[]>(
      ...items: T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override, C>;
    <const T extends OrderItem>(
      item: (tables: S) => T & CheckInput<T, S>
    ): SelectQuery<S, P, N, D, Override, C>;
    <const T extends readonly OrderItem[]>(
      items: (tables: S) => T & CheckInput<T[number], S>
    ): SelectQuery<S, P, N, D, Override, C>;
  };
  readonly limit: (count: number) => SelectQuery<S, P, N, D, Override, C>;
  readonly offset: (count: number) => SelectQuery<S, P, N, D, Override, C>;
  readonly distinct: () => SelectQuery<S, P, N, D, Override, C>;
  readonly $if: (
    condition: boolean,
    apply: (
      query: SelectQuery<S, P, N, D, Override, C>
    ) => SelectQuery<S, P, N, D, Override, C>
  ) => SelectQuery<S, P, N, D, Override, C>;
  readonly when: (
    condition: boolean,
    apply: (
      query: SelectQuery<S, P, N, D, Override, C>
    ) => SelectQuery<S, P, N, D, Override, C>
  ) => SelectQuery<S, P, N, D, Override, C>;
  readonly $narrow: <T extends Partial<NonNullable<Result<P, N, Override>>>>(
    ...check: Exclude<
      keyof T,
      keyof NonNullable<Result<P, N, Override>>
    > extends never
      ? []
      : [never]
  ) => SelectQuery<S, P, N, D, Narrow<Result<P, N, Override>, T>, C>;
  readonly $assertType: <T>(
    ...check: Types.Equals<Result<P, N, Override>, T> extends true
      ? []
      : [never]
  ) => SelectQuery<S, P, N, D, T, C>;
  readonly compile: (
    dialect: D & SelectionDialect<P>
  ) => ReturnType<typeof compileSelect>;
  readonly toFragment: (
    dialect?: D & SelectionDialect<P>
  ) => Statement.Fragment;
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
  | { readonly kind: "cross"; readonly source: Source }
  | {
      readonly kind: Exclude<SelectJoin["kind"], "cross">;
      readonly source: Source;
      readonly on: SqlExpression;
    };

interface SelectState {
  readonly source?: Source;
  readonly joins: readonly JoinedSource[];
  readonly scope: Scope;
  readonly ctes: Scope;
  readonly with: readonly Cte[];
  readonly sets: readonly {
    readonly operator: SetOperator;
    readonly operand: QuerySnapshot;
  }[];
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
  ctes: emptyScope,
  groupBy: [],
  joins: [],
  mysql: true,
  nullable: new Set(),
  orderBy: [],
  scope: emptyScope,
  sets: [],
  with: [],
};

const resolve = <T>(scoped: Scoped<T>, scope: Scope) =>
  Predicate.isFunction(scoped) ? scoped(scope) : scoped;

const addSource = (scope: Scope, source: Source) => {
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
  const items = isSource(selection) ? [selection] : Object.values(selection);

  for (const item of items) {
    if (!isSource(item)) {
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

const relation: (
  source: Source,
  plan: ProjectionPlan
) => Relation<Statement.Fragment> = (source, plan) => {
  const presence = plan.presence.get(source.name);

  if (!isDerivedSource(source)) {
    return {
      alias: source.alias,
      kind: "table",
      name: source.identifier,
      presence,
    };
  }

  if (source.relation.kind === "subquery") {
    return {
      alias: source.name,
      kind: "subquery",
      presence,
      query: source.relation.query,
    };
  }

  const { name } = source.relation;

  return {
    alias: name === source.name ? undefined : source.name,
    kind: "table",
    name: { name },
    presence,
  };
};

const supportsMysql = (source: Source) =>
  !isDerivedSource(source) || source.dialects.includes("mysql");

const supportedDialects: (mysql: boolean) => readonly SelectDialect[] = (
  mysql
) => (mysql ? ["pg", "sqlite", "mysql"] : ["pg", "sqlite"]);

const unsupportedSelect = (message: string, cause: unknown = message) =>
  Effect.fail(
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        cause,
        message,
        operation: "SELECT",
      }),
    })
  );

const copySelection = (selection: Selection) => {
  if (isSource(selection)) {
    return selection;
  }

  if (
    Object.getOwnPropertySymbols(selection).some(
      (key) =>
        Object.getOwnPropertyDescriptor(selection, key)?.enumerable === true
    )
  ) {
    throw new TypeError("SELECT projection keys cannot be symbols");
  }

  return Object.freeze({ ...selection });
};

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

  from(input: Scoped<Source>) {
    if (this.#state.source !== undefined) {
      throw new TypeError("SELECT already has a FROM source");
    }

    const source = resolve(input, this.#state.ctes);

    return this.#copy({
      mysql: this.#state.mysql && supportsMysql(source),
      scope: addSource(this.#state.scope, source),
      source,
    });
  }

  [QueryTypeId]() {
    return {
      ast: this.#ast(),
      mysql: this.#state.mysql,
      plan: this.#plan(),
      selection: this.#selection(),
    };
  }

  as(name: string) {
    return makeDerivedSource(
      name,
      this.#plan(),
      { kind: "subquery", query: this.#ast() },
      supportedDialects(this.#state.mysql)
    );
  }

  scalar(key: string) {
    const { fields } = this.#plan();
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;

    if (field === undefined) {
      throw new TypeError(`Unknown scalar SELECT field: ${key}`);
    }

    const alias = "__eqb_scalar";

    const node = {
      kind: "subquery",
      query: {
        from: { relation: { alias, kind: "subquery", query: this.#ast() } },
        kind: "select",
        projections: [
          { expression: { kind: "column", name: field.alias, table: alias } },
        ],
      },
    } satisfies SqlExpression;

    return makeExpression(Schema.NullOr(field.schema), node, []);
  }

  with(name: string, operand: Scoped<QueryOperand>) {
    const { ctes, mysql, with: previous } = this.#state;
    const query = resolve(operand, ctes)[QueryTypeId]();

    const source = makeDerivedSource(
      name,
      query.plan,
      { kind: "cte", name },
      supportedDialects(query.mysql)
    );

    return this.#copy({
      ctes: addSource(ctes, source),
      mysql: mysql && query.mysql,
      with: [...previous, { name, query: query.ast }],
    });
  }

  #set(operator: SetOperator, query: QueryOperand) {
    const operand = query[QueryTypeId]();

    return this.#copy({
      mysql: this.#state.mysql && operand.mysql,
      sets: [...this.#state.sets, { operand, operator }],
    });
  }

  union(query: QueryOperand) {
    return this.#set("UNION", query);
  }

  unionAll(query: QueryOperand) {
    return this.#set("UNION ALL", query);
  }

  intersect(query: QueryOperand) {
    return this.#set("INTERSECT", query);
  }

  except(query: QueryOperand) {
    return this.#set("EXCEPT", query);
  }

  select(selection: Scoped<Selection>) {
    return this.#copy({
      selection: copySelection(resolve(selection, this.#state.scope)),
    });
  }

  #join(
    kind: Exclude<SelectJoin["kind"], "cross">,
    inputSource: Scoped<Source>,
    predicate: Scoped<PredicateInput>
  ) {
    if (this.#state.source === undefined) {
      throw new TypeError("SELECT joins require a FROM source");
    }

    const { ctes, joins, mysql, nullable } = this.#state;
    const source = resolve(inputSource, ctes);
    const scope = addSource(this.#state.scope, source);
    const input = resolve(predicate, scope);
    checkInput(input, scope);

    const on = toExpressionNode(input);

    const leftNulls =
      kind === "right" || kind === "full" ? Object.keys(this.#state.scope) : [];

    const rightNulls = kind === "left" || kind === "full" ? [source.name] : [];

    return this.#copy({
      joins: [...joins, { kind, on, source }],
      mysql: mysql && kind !== "full" && supportsMysql(source),
      nullable: new Set([...nullable, ...leftNulls, ...rightNulls]),
      scope,
    });
  }

  innerJoin(source: Scoped<Source>, on: Scoped<PredicateInput>) {
    return this.#join("inner", source, on);
  }

  leftJoin(source: Scoped<Source>, on: Scoped<PredicateInput>) {
    return this.#join("left", source, on);
  }

  rightJoin(source: Scoped<Source>, on: Scoped<PredicateInput>) {
    return this.#join("right", source, on);
  }

  fullJoin(source: Scoped<Source>, on: Scoped<PredicateInput>) {
    return this.#join("full", source, on);
  }

  crossJoin(input: Scoped<Source>) {
    if (this.#state.source === undefined) {
      throw new TypeError("SELECT joins require a FROM source");
    }

    const source = resolve(input, this.#state.ctes);

    return this.#copy({
      joins: [...this.#state.joins, { kind: "cross", source }],
      mysql: this.#state.mysql && supportsMysql(source),
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

  #selection() {
    const selected = this.#state.selection ?? this.#state.source;

    if (selected === undefined) {
      throw new TypeError("SELECT requires a projection or source");
    }

    return selected;
  }

  #plan() {
    if (this.#planCache === undefined) {
      const { groupBy, nullable, scope } = this.#state;
      const selected = this.#selection();

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
      sets,
      source,
      where,
      with: ctes,
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
      sets: sets.map(({ operand, operator }) => {
        assertCompatibleProjections(plan, operand.plan);

        return { operator, query: operand.ast };
      }),
      where,
      with: Arr.isReadonlyArrayNonEmpty(ctes) ? ctes : undefined,
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

        return unsupportedSelect(message);
      }

      try {
        const sql = client.withoutTransforms();
        const compiled = sql`${this.toFragment(dialect)}`;

        this.#statements.set(client, compiled);

        return Effect.succeed(compiled);
      } catch (error) {
        if (error instanceof UnsupportedDialectClauseError) {
          return unsupportedSelect(error.message, error);
        }

        throw error;
      }
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

export function from<const T extends Source>(
  source: T
): SelectQuery<SourceEntry<T>, T, never, SourceDialect<T>>;
export function from(source: Source) {
  const result: object = new Query(empty).from(source);

  return result;
}

export function select<const T extends Source>(
  selection: T
): SelectQuery<SourceEntry<T>, T, never, SourceDialect<T>>;
export function select<const P extends Exclude<Selection, Source>>(
  selection: P & (Extract<keyof P, symbol> extends never ? unknown : never)
): SelectQuery<EmptyScope, P>;
export function select(selection: Selection) {
  const query = new Query(empty);

  const result: object = isSource(selection)
    ? query.from(selection)
    : query.select(selection);

  return result;
}

export function withCte<const Name extends string, Q extends QueryOperand>(
  name: Name,
  query: Q
): SelectQuery<
  EmptyScope,
  never,
  never,
  OperandDialect<Q>,
  never,
  SourceEntry<OperandSource<Name, Q>>
>;
export function withCte(name: string, query: QueryOperand) {
  const result: object = new Query(empty).with(name, query);

  return result;
}
