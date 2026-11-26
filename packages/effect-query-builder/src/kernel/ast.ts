type NonEmpty<T> = readonly [T, ...T[]];

export interface QualifiedName {
  readonly name: string;
  readonly schema?: string;
}

type BinaryOperator =
  | "="
  | "<>"
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "AND"
  | "LIKE"
  | "OR";

export type Expression<Raw = never> =
  | {
      readonly kind: "column";
      readonly name: string;
      readonly table?: string;
    }
  | {
      readonly kind: "parameter";
      readonly value: unknown;
    }
  | {
      readonly kind: "stringLiteral";
      readonly value: string;
    }
  | {
      readonly kind: "numberLiteral";
      readonly value: number;
    }
  | {
      readonly kind: "booleanLiteral";
      readonly value: boolean;
    }
  | { readonly kind: "nullLiteral" }
  | {
      readonly kind: "binary";
      readonly operator: BinaryOperator;
      readonly left: Expression<Raw>;
      readonly right: Expression<Raw>;
    }
  | {
      readonly kind: "not";
      readonly operand: Expression<Raw>;
    }
  | {
      readonly kind: "nullCheck";
      readonly operand: Expression<Raw>;
      readonly negate?: boolean;
    }
  | {
      readonly kind: "in";
      readonly operand: Expression<Raw>;
      readonly values: readonly Expression<Raw>[] | SelectStatement<Raw>;
      readonly negate?: boolean;
    }
  | {
      readonly kind: "between";
      readonly operand: Expression<Raw>;
      readonly lower: Expression<Raw>;
      readonly upper: Expression<Raw>;
    }
  | {
      readonly kind: "aggregate";
      readonly name: "COUNT" | "SUM" | "AVG" | "MIN" | "MAX";
      readonly operand?: Expression<Raw>;
      readonly distinct?: boolean;
    }
  | {
      readonly kind: "raw";
      readonly value: Raw;
    }
  | {
      readonly kind: "subquery";
      readonly query: SelectStatement<Raw>;
    };

export type Relation<Raw = never> =
  | {
      readonly kind: "table";
      readonly name: QualifiedName;
      readonly alias?: string;
      readonly presence?: string;
    }
  | {
      readonly kind: "subquery";
      readonly query: SelectStatement<Raw>;
      readonly alias: string;
      readonly presence?: string;
    };

export type Join<Raw = never> =
  | {
      readonly kind: "cross";
      readonly relation: Relation<Raw>;
    }
  | {
      readonly kind: "inner" | "left" | "right" | "full";
      readonly relation: Relation<Raw>;
      readonly on: Expression<Raw>;
    };

export interface Projection<Raw = never> {
  readonly expression: Expression<Raw>;
  readonly alias?: string;
}

interface CommonTableExpression<Raw> {
  readonly name: string;
  readonly query: SelectStatement<Raw>;
}

interface OrderBy<Raw> {
  readonly expression: Expression<Raw>;
  readonly direction: "asc" | "desc";
}

export interface SelectStatement<Raw = never> {
  readonly kind: "select";
  readonly with?: NonEmpty<CommonTableExpression<Raw>>;
  readonly distinct?: boolean;
  readonly projections: NonEmpty<Projection<Raw>>;
  readonly from?: {
    readonly relation: Relation<Raw>;
    readonly joins?: NonEmpty<Join<Raw>>;
  };
  readonly where?: Expression<Raw>;
  readonly groupBy?: NonEmpty<Expression<Raw>>;
  readonly having?: Expression<Raw>;
  readonly orderBy?: NonEmpty<OrderBy<Raw>>;
  readonly limit?: {
    readonly count: number;
    readonly offset?: number;
  };
  readonly offset?: number;
  readonly sets?: readonly {
    readonly operator: "UNION" | "UNION ALL" | "INTERSECT" | "EXCEPT";
    readonly query: SelectStatement<Raw>;
  }[];
}

interface InsertStatement {
  readonly kind: "insert";
  readonly table: QualifiedName;
  readonly columns: NonEmpty<string>;
  readonly rows: NonEmpty<NonEmpty<Expression>>;
  readonly returning?: NonEmpty<Projection>;
}

interface UpdateStatement {
  readonly kind: "update";
  readonly table: QualifiedName;
  readonly assignments: NonEmpty<{
    readonly column: string;
    readonly value: Expression;
  }>;
  readonly where?: Expression;
  readonly returning?: NonEmpty<Projection>;
}

interface DeleteStatement {
  readonly kind: "delete";
  readonly table: QualifiedName;
  readonly where?: Expression;
  readonly returning?: NonEmpty<Projection>;
}

interface CreateTableStatement {
  readonly kind: "createTable";
  readonly table: QualifiedName;
  readonly ifNotExists?: boolean;
  readonly columns: NonEmpty<{
    readonly name: string;
    readonly type: "INTEGER" | "BIGINT" | "TEXT" | "BOOLEAN";
    readonly notNull?: boolean;
  }>;
}

interface DropTableStatement {
  readonly kind: "dropTable";
  readonly table: QualifiedName;
  readonly ifExists?: boolean;
}

export type Statement<Raw = never> =
  | SelectStatement<Raw>
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | CreateTableStatement
  | DropTableStatement;
