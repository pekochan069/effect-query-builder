import {
  Array as Arr,
  Cause,
  Effect,
  Effectable,
  Predicate,
  Stream,
} from "effect";
import type { Option, Types, Schema } from "effect";
import { flatMap, forEach, map } from "effect/Effect";
import { identity } from "effect/Function";
import { SqlClient, Statement } from "effect/sql";
import type { SqlConnection, SqlError } from "effect/sql";

import { getClientDialect, unsupportedDialect } from "./dialect.ts";
import type { CheckDialect } from "./dialect.ts";
import {
  isExpression,
  isOrdering,
  makeExpression,
  sqlNullOr,
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
import type { SqlDialect } from "./kernel/compile.ts";
import { UnsupportedDialectClauseError } from "./kernel/errors.ts";
import { compileSelect, toSelectFragment } from "./select-compiler.ts";
import {
  alignSetProjection,
  planProjection,
  withNumericSetTransport,
} from "./select-projection.ts";
import type {
  DecodeServices,
  ProjectionPlan,
  Selected,
  Selection,
} from "./select-projection.ts";
import {
  derivedDefinition,
  isDerivedSource,
  isSource,
  makeDerivedSource,
} from "./select-source.ts";
import type {
  DerivedSelection,
  ScalarKey,
  ScalarSchema,
  ScalarValue,
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

type StatementCache = WeakMap<
  SqlClient.SqlClient,
  Statement.Statement<SqlConnection.Row>
>;

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

type ExcludedSelectionItemDialects<Item> = Item extends Source
  ? Exclude<SqlDialect, SourceDialect<Item>>
  : Exclude<SqlDialect, ExpressionDialect<Item>>;

type ExcludedSelectionDialects<P> = P extends Selection
  ? P extends Source
    ? ExcludedSelectionItemDialects<P>
    : ExcludedSelectionItemDialects<P[keyof P]>
  : never;

type SelectionDialect<P extends Selection> = Exclude<
  SqlDialect,
  ExcludedSelectionDialects<P>
>;

type CheckExpression<Input, S extends Scope, D extends SqlDialect> = CheckInput<
  Input,
  S
> &
  CheckDialect<D & NoInfer<ExpressionDialect<Input>>>;

type CheckSource<T extends Source, D extends SqlDialect> = CheckDialect<
  D & NoInfer<SourceDialect<T>>
>;

type CheckJoin<
  On,
  S extends Scope,
  T extends Source,
  D extends SqlDialect,
> = CheckExpression<
  On,
  S & SourceEntry<NoInfer<T>>,
  D & NoInfer<SourceDialect<T>>
>;

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

export const QueryTypeId = Symbol("effect-query-builder/SelectQuery");

interface QuerySnapshot<P extends Selection = Selection> {
  readonly plan: ProjectionPlan;
  readonly ast: SelectAst;
  readonly selection: P;
}

export interface QueryOperand extends Effect.Effect<
  readonly unknown[],
  SelectError,
  unknown
> {
  readonly [QueryTypeId]: () => QuerySnapshot;
  readonly compile: (dialect: never) => ReturnType<typeof compileSelect>;
}

type OperandRow<Q extends QueryOperand> = Effect.Success<Q>[number];

type ExcludedOperandDialects<Q> = Q extends QueryOperand
  ? Exclude<SqlDialect, Parameters<Q["compile"]>[0]>
  : never;

export type OperandDialect<Q extends QueryOperand> = Exclude<
  SqlDialect,
  ExcludedOperandDialects<Q>
>;

type CheckOperand<Q extends QueryOperand, D extends SqlDialect> = CheckDialect<
  D & NoInfer<OperandDialect<Q>>
>;

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

type SelectBuilder<
  S extends Scope,
  P extends Selection,
  N extends string,
  D extends SqlDialect,
  Override,
  C extends Scope,
  Compound extends boolean,
> = Compound extends true
  ? SelectResult<S, P, N, D, Override, C, Compound>
  : SelectQuery<S, P, N, D, Override, C>;

interface SelectResult<
  S extends Scope,
  P extends Selection,
  N extends string,
  D extends SqlDialect,
  Override,
  C extends Scope,
  Compound extends boolean,
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
    D & SelectionDialect<P>,
    ScalarValue<P, Key>
  >;
  readonly with: <const Name extends string, Q extends QueryOperand>(
    name: Name & (Name extends keyof C ? never : unknown),
    query: Scoped<Q & CheckOperand<Q, D & SelectionDialect<P>>, C>
  ) => SelectBuilder<
    S,
    P,
    N,
    D & OperandDialect<Q>,
    Override,
    C & SourceEntry<OperandSource<Name, Q>>,
    Compound
  >;
  readonly union: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>> &
      CheckOperand<Q, D & SelectionDialect<P>>
  ) => SelectResult<S, P, N, D & OperandDialect<Q>, Override, C, true>;
  readonly unionAll: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>> &
      CheckOperand<Q, D & SelectionDialect<P>>
  ) => SelectResult<S, P, N, D & OperandDialect<Q>, Override, C, true>;
  readonly intersect: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>> &
      CheckOperand<Q, D & SelectionDialect<P>>
  ) => SelectResult<S, P, N, D & OperandDialect<Q>, Override, C, true>;
  readonly except: <Q extends QueryOperand>(
    query: SetOperand<Q, Result<P, N, Override>> &
      CheckOperand<Q, D & SelectionDialect<P>>
  ) => SelectResult<S, P, N, D & OperandDialect<Q>, Override, C, true>;
  readonly $if: (
    condition: boolean,
    apply: (
      query: SelectBuilder<S, P, N, D, Override, C, Compound>
    ) => SelectBuilder<S, P, N, D, Override, C, Compound>
  ) => SelectBuilder<S, P, N, D, Override, C, Compound>;
  readonly when: (
    condition: boolean,
    apply: (
      query: SelectBuilder<S, P, N, D, Override, C, Compound>
    ) => SelectBuilder<S, P, N, D, Override, C, Compound>
  ) => SelectBuilder<S, P, N, D, Override, C, Compound>;
  readonly $narrow: <T extends Partial<NonNullable<Result<P, N, Override>>>>(
    ...check: Exclude<
      keyof T,
      keyof NonNullable<Result<P, N, Override>>
    > extends never
      ? []
      : [never]
  ) => SelectBuilder<
    S,
    P,
    N,
    D,
    Narrow<Result<P, N, Override>, T>,
    C,
    Compound
  >;
  readonly $assertType: <T>(
    ...check: Types.Equals<Result<P, N, Override>, T> extends true
      ? []
      : [never]
  ) => SelectBuilder<S, P, N, D, T, C, Compound>;
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

export interface SelectQuery<
  S extends Scope,
  P extends Selection,
  N extends string = never,
  D extends SqlDialect = SqlDialect,
  Override = never,
  C extends Scope = EmptyScope,
> extends SelectResult<S, P, N, D, Override, C, false> {
  readonly from: <const T extends Source>(
    source: Scoped<
      T &
        (keyof S extends never ? unknown : never) &
        CheckFrom<P, NoInfer<T>> &
        CheckSource<T, D & SelectionDialect<P>>,
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
    selection: Scoped<
      Next &
        CheckSelection<Next, S> &
        CheckDialect<D & NoInfer<SelectionDialect<Next>>>,
      S
    >
  ) => SelectQuery<S, Next, N, D, never, C>;
  readonly innerJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<
      NewSource<S, T> & CheckSource<T, D & SelectionDialect<P>>,
      C
    >,
    on: Scoped<
      On & CheckJoin<On, S, T, D & SelectionDialect<P>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N,
    D & SourceDialect<T> & ExpressionDialect<On>,
    Override,
    C
  >;
  readonly leftJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<
      NewSource<S, T> & CheckSource<T, D & SelectionDialect<P>>,
      C
    >,
    on: Scoped<
      On & CheckJoin<On, S, T, D & SelectionDialect<P>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N | T["name"],
    D & SourceDialect<T> & ExpressionDialect<On>,
    Override,
    C
  >;
  readonly rightJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<
      NewSource<S, T> & CheckSource<T, D & SelectionDialect<P>>,
      C
    >,
    on: Scoped<
      On & CheckJoin<On, S, T, D & SelectionDialect<P>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N | Extract<keyof S, string>,
    D & SourceDialect<T> & ExpressionDialect<On>,
    never,
    C
  >;
  readonly fullJoin: <const T extends Source, const On extends PredicateInput>(
    source: Scoped<
      NewSource<S, T> &
        CheckSource<T, Exclude<D, "mysql"> & SelectionDialect<P>>,
      C
    >,
    on: Scoped<
      On & CheckJoin<On, S, T, Exclude<D, "mysql"> & SelectionDialect<P>>,
      S & SourceEntry<NoInfer<T>>
    >
  ) => SelectQuery<
    S & SourceEntry<T>,
    P,
    N | Extract<keyof S, string> | T["name"],
    Exclude<D & SourceDialect<T> & ExpressionDialect<On>, "mysql">,
    never,
    C
  >;
  readonly crossJoin: <const T extends Source>(
    source: Scoped<NewSource<S, T> & CheckSource<T, D & SelectionDialect<P>>, C>
  ) => SelectQuery<S & SourceEntry<T>, P, N, D & SourceDialect<T>, Override, C>;
  readonly where: <const T extends PredicateInput>(
    predicate: Scoped<T & CheckExpression<T, S, D & SelectionDialect<P>>, S>
  ) => SelectQuery<S, P, N, D & ExpressionDialect<T>, Override, C>;
  readonly having: <const T extends PredicateInput>(
    predicate: Scoped<T & CheckExpression<T, S, D & SelectionDialect<P>>, S>
  ) => SelectQuery<S, P, N, D & ExpressionDialect<T>, Override, C>;
  readonly groupBy: {
    <const T extends readonly ExpressionInput[]>(
      ...items: T & CheckExpression<T[number], S, D & SelectionDialect<P>>
    ): SelectQuery<S, P, N, D & ExpressionDialect<T[number]>, Override, C>;
    <const T extends ExpressionInput>(
      item: (tables: S) => T & CheckExpression<T, S, D & SelectionDialect<P>>
    ): SelectQuery<S, P, N, D & ExpressionDialect<T>, Override, C>;
    <const T extends readonly ExpressionInput[]>(
      items: (
        tables: S
      ) => T & CheckExpression<T[number], S, D & SelectionDialect<P>>
    ): SelectQuery<S, P, N, D & ExpressionDialect<T[number]>, Override, C>;
  };
  readonly orderBy: {
    <const T extends readonly OrderItem[]>(
      ...items: T & CheckExpression<T[number], S, D & SelectionDialect<P>>
    ): SelectQuery<S, P, N, D & ExpressionDialect<T[number]>, Override, C>;
    <const T extends OrderItem>(
      item: (tables: S) => T & CheckExpression<T, S, D & SelectionDialect<P>>
    ): SelectQuery<S, P, N, D & ExpressionDialect<T>, Override, C>;
    <const T extends readonly OrderItem[]>(
      items: (
        tables: S
      ) => T & CheckExpression<T[number], S, D & SelectionDialect<P>>
    ): SelectQuery<S, P, N, D & ExpressionDialect<T[number]>, Override, C>;
  };
  readonly limit: (count: number) => SelectQuery<S, P, N, D, Override, C>;
  readonly offset: (count: number) => SelectQuery<S, P, N, D, Override, C>;
  readonly distinct: () => SelectQuery<S, P, N, D, Override, C>;
  readonly distinctOn: <
    const T extends readonly [ExpressionInput, ...ExpressionInput[]],
  >(
    ...items: T & CheckExpression<T[number], S, D & SelectionDialect<P> & "pg">
  ) => SelectQuery<
    S,
    P,
    N,
    D & "pg" & ExpressionDialect<T[number]>,
    Override,
    C
  >;
  readonly forUpdate: (
    ...check: [D & SelectionDialect<P> & ("pg" | "mysql")] extends [never]
      ? [never]
      : []
  ) => SelectQuery<S, P, N, D & ("pg" | "mysql"), Override, C>;
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
  readonly distinct?: true | readonly [SqlExpression, ...SqlExpression[]];
  readonly dialect?: SqlDialect;
  readonly forUpdate?: true;
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

  const { relation: definition } = derivedDefinition(source);

  if (definition.kind === "subquery") {
    return {
      alias: source.name,
      kind: "subquery",
      presence,
      query: definition.query,
    };
  }

  const { name } = definition;

  return {
    alias: name === source.name ? undefined : source.name,
    kind: "table",
    name: { name },
    presence,
  };
};

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
  readonly #statements: StatementCache = new WeakMap();
  #firstStatements?: StatementCache;
  #planCache?: ProjectionPlan;
  #fragment?: Statement.Fragment;

  constructor(state: SelectState) {
    super();
    this.#state = state;
  }

  #copy(changes: Partial<SelectState>) {
    return new Query({ ...this.#state, ...changes });
  }

  #requireSimpleSelect() {
    if (this.#state.sets.length > 0) {
      throw new TypeError(
        "Wrap the compound SELECT with .as() and from() to add clauses"
      );
    }
  }

  from(input: Scoped<Source>) {
    this.#requireSimpleSelect();

    if (this.#state.source !== undefined) {
      throw new TypeError("SELECT already has a FROM source");
    }

    const source = resolve(input, this.#state.ctes);

    return this.#copy({
      scope: addSource(this.#state.scope, source),
      source,
    });
  }

  [QueryTypeId]() {
    return {
      ast: this.#ast(),
      plan: this.#plan(),
      selection: this.#selection(),
    };
  }

  as(name: string) {
    return makeDerivedSource(name, {
      plan: this.#plan(),
      relation: { kind: "subquery", query: this.#ast() },
    });
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

    return makeExpression(
      sqlNullOr(field.resultSchema ?? field.schema),
      node,
      []
    );
  }

  with(name: string, operand: Scoped<QueryOperand>) {
    const { ctes, with: previous } = this.#state;
    const query = resolve(operand, ctes)[QueryTypeId]();

    const source = makeDerivedSource(name, {
      plan: query.plan,
      relation: { kind: "cte", name },
    });

    return this.#copy({
      ctes: addSource(ctes, source),
      with: [...previous, { name, query: query.ast }],
    });
  }

  #set(operator: SetOperator, query: QueryOperand) {
    const operand = query[QueryTypeId]();

    return this.#copy({
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
    this.#requireSimpleSelect();

    return this.#copy({
      selection: copySelection(resolve(selection, this.#state.scope)),
    });
  }

  #join(
    kind: Exclude<SelectJoin["kind"], "cross">,
    inputSource: Scoped<Source>,
    predicate: Scoped<PredicateInput>
  ) {
    this.#requireSimpleSelect();

    if (this.#state.source === undefined) {
      throw new TypeError("SELECT joins require a FROM source");
    }

    const { ctes, joins, nullable } = this.#state;
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
    this.#requireSimpleSelect();

    if (this.#state.source === undefined) {
      throw new TypeError("SELECT joins require a FROM source");
    }

    const source = resolve(input, this.#state.ctes);

    return this.#copy({
      joins: [...this.#state.joins, { kind: "cross", source }],
      scope: addSource(this.#state.scope, source),
    });
  }

  where(predicate: Scoped<PredicateInput>) {
    this.#requireSimpleSelect();

    const input = resolve(predicate, this.#state.scope);
    checkInput(input, this.#state.scope);

    return this.#copy({
      where: constrain(this.#state.where, toExpressionNode(input)),
    });
  }

  having(predicate: Scoped<PredicateInput>) {
    this.#requireSimpleSelect();

    const input = resolve(predicate, this.#state.scope);
    checkInput(input, this.#state.scope);

    return this.#copy({
      having: constrain(this.#state.having, toExpressionNode(input)),
    });
  }

  groupBy(
    ...items: readonly Scoped<ExpressionInput | readonly ExpressionInput[]>[]
  ) {
    this.#requireSimpleSelect();

    const nodes = items
      .flatMap((item) => resolve(item, this.#state.scope))
      .map((item) => {
        checkInput(item, this.#state.scope);

        return toExpressionNode(item);
      });

    return this.#copy({ groupBy: [...this.#state.groupBy, ...nodes] });
  }

  orderBy(...items: readonly Scoped<OrderItem | readonly OrderItem[]>[]) {
    this.#requireSimpleSelect();

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
    this.#requireSimpleSelect();

    return this.#copy({ limit });
  }

  offset(offset: number) {
    this.#requireSimpleSelect();

    return this.#copy({ offset });
  }

  distinct() {
    this.#requireSimpleSelect();

    return this.#copy({ distinct: true });
  }

  distinctOn(...items: readonly ExpressionInput[]) {
    this.#requireSimpleSelect();

    if (!Arr.isReadonlyArrayNonEmpty(items)) {
      throw new TypeError("DISTINCT ON requires at least one expression");
    }

    for (const item of items) {
      checkInput(item, this.#state.scope);
    }

    const [first, ...rest] = items;

    return this.#copy({
      distinct: [toExpressionNode(first), ...rest.map(toExpressionNode)],
    });
  }

  forUpdate() {
    this.#requireSimpleSelect();

    return this.#copy({ forUpdate: true });
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
      const { groupBy, nullable, scope, sets } = this.#state;
      const selected = this.#selection();

      checkSelection(selected, scope);

      const plan = planProjection(
        selected,
        scope,
        nullable,
        groupBy.length > 0
      );

      this.#planCache =
        sets.length > 0
          ? withNumericSetTransport(
              plan,
              sets.map(({ operand }) => operand.plan)
            )
          : plan;
    }

    return this.#planCache;
  }

  #ast() {
    const {
      dialect,
      distinct,
      forUpdate,
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
      dialect,
      distinct,
      forUpdate,
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
      limit,
      offset,
      orderBy: Arr.isReadonlyArrayNonEmpty(orderBy) ? orderBy : undefined,
      projections: plan.columns,
      sets: sets.map(({ operand, operator }) => ({
        operator,
        query: alignSetProjection(plan, operand.plan, operand.ast),
      })),
      where,
      with: Arr.isReadonlyArrayNonEmpty(ctes) ? ctes : undefined,
    } satisfies SelectAst;
  }

  #firstAst() {
    const query = this.#ast();

    if (query.sets.length === 0) {
      const { limit } = query;

      return limit === undefined || (Number.isSafeInteger(limit) && limit > 1)
        ? { ...query, limit: 1 }
        : query;
    }

    const table = "__eqb_first";
    const [first, ...rest] = query.projections;

    const project = ({ alias }: typeof first) => ({
      alias,
      expression: { kind: "column" as const, name: alias, table },
    });

    return {
      from: { relation: { alias: table, kind: "subquery", query } },
      kind: "select",
      limit: 1,
      projections: [project(first), ...rest.map(project)],
    } satisfies SelectAst;
  }

  toFragment(dialect?: SqlDialect) {
    if (dialect !== undefined) {
      return toSelectFragment(this.#ast(), dialect);
    }

    this.#fragment ??= toSelectFragment(this.#ast());

    return this.#fragment;
  }

  get segments() {
    return this.toFragment().segments;
  }

  compile(dialect: SqlDialect) {
    return compileSelect(this.#ast(), dialect);
  }

  #statement(firstRowOnly = false) {
    return flatMap(SqlClient.SqlClient, (client) => {
      const statements = firstRowOnly
        ? (this.#firstStatements ??= new WeakMap())
        : this.#statements;

      const statement = statements.get(client);

      if (statement !== undefined) {
        return Effect.succeed(statement);
      }

      const dialect = getClientDialect(client);

      if (dialect === null) {
        return unsupportedDialect(
          "SELECT",
          "SELECT is unsupported by this SQL driver"
        );
      }

      try {
        const sql = client.withoutTransforms();

        const fragment = firstRowOnly
          ? toSelectFragment(this.#firstAst(), dialect)
          : this.toFragment(dialect);

        const compiled = sql`${fragment}`;

        statements.set(client, compiled);

        return Effect.succeed(compiled);
      } catch (error) {
        if (error instanceof UnsupportedDialectClauseError) {
          return unsupportedDialect("SELECT", error.message, error);
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
    return flatMap(this.#statement(true), (statement) =>
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

export interface SelectEntrypoints<D extends SqlDialect> {
  readonly from: <const T extends Source>(
    source: T & CheckSource<T, D>
  ) => SelectQuery<SourceEntry<T>, T, never, D & SourceDialect<T>>;
  readonly select: {
    <const T extends Source>(
      selection: T & CheckSource<T, D>
    ): SelectQuery<SourceEntry<T>, T, never, D & SourceDialect<T>>;
    <const P extends Exclude<Selection, Source>>(
      selection: P &
        (Extract<keyof P, symbol> extends never ? unknown : never) &
        CheckDialect<D & NoInfer<SelectionDialect<P>>>
    ): SelectQuery<EmptyScope, P, never, D>;
  };
  readonly withCte: <const Name extends string, Q extends QueryOperand>(
    name: Name,
    query: Q & CheckOperand<Q, D>
  ) => SelectQuery<
    EmptyScope,
    never,
    never,
    D & OperandDialect<Q>,
    never,
    SourceEntry<OperandSource<Name, Q>>
  >;
}

export function selectForDialect<const D extends SqlDialect = SqlDialect>(
  dialect?: D
): SelectEntrypoints<D>;
export function selectForDialect(dialect?: SqlDialect) {
  const state: SelectState = { ...empty, dialect };

  return identity<object>({
    from: (source: Source) => new Query(state).from(source),
    select: (selection: Selection) => {
      const query = new Query(state);

      return isSource(selection)
        ? query.from(selection)
        : query.select(selection);
    },
    withCte: (name: string, query: QueryOperand) =>
      new Query(state).with(name, query),
  });
}

const portable = selectForDialect();

export const from: SelectEntrypoints<SqlDialect>["from"] = portable.from;
export const select: SelectEntrypoints<SqlDialect>["select"] = portable.select;

export const withCte: SelectEntrypoints<SqlDialect>["withCte"] =
  portable.withCte;
