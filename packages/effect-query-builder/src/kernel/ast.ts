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
  | "OR";

export type Expression =
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
      readonly left: Expression;
      readonly right: Expression;
    }
  | {
      readonly kind: "not";
      readonly operand: Expression;
    }
  | {
      readonly kind: "nullCheck";
      readonly operand: Expression;
      readonly negate?: boolean;
    }
  | {
      readonly kind: "subquery";
      readonly query: SelectStatement;
    };

export type Relation =
  | {
      readonly kind: "table";
      readonly name: QualifiedName;
      readonly alias?: string;
    }
  | {
      readonly kind: "subquery";
      readonly query: SelectStatement;
      readonly alias: string;
    };

export type Join =
  | {
      readonly kind: "cross";
      readonly relation: Relation;
    }
  | {
      readonly kind: "inner" | "left" | "right" | "full";
      readonly relation: Relation;
      readonly on: Expression;
    };

export interface Projection {
  readonly expression: Expression;
  readonly alias?: string;
}

interface CommonTableExpression {
  readonly name: string;
  readonly query: SelectStatement;
}

interface OrderBy {
  readonly expression: Expression;
  readonly direction: "asc" | "desc";
}

export interface SelectStatement {
  readonly kind: "select";
  readonly with?: NonEmpty<CommonTableExpression>;
  readonly projections: NonEmpty<Projection>;
  readonly from?: {
    readonly relation: Relation;
    readonly joins?: NonEmpty<Join>;
  };
  readonly where?: Expression;
  readonly groupBy?: NonEmpty<Expression>;
  readonly having?: Expression;
  readonly orderBy?: NonEmpty<OrderBy>;
  readonly limit?: {
    readonly count: number;
    readonly offset?: number;
  };
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

export type Statement =
  | SelectStatement
  | InsertStatement
  | UpdateStatement
  | DeleteStatement
  | CreateTableStatement
  | DropTableStatement;
