//@ option string-semantics javascript-utf16
//@ option dafny-library local

export type SqlToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "bind"; readonly value: unknown };

export interface RenderedTokens {
  readonly sql: string;
  readonly params: readonly unknown[];
}

//@ verify
//@ contract Distinct projection positions produce distinct internal SQL aliases.
//@ requires 0 <= index && index <= 9007199254740991
//@ ensures forall(other: int, 0 <= other && other <= 9007199254740991 && other !== index ==> \result !== projectionAlias(other))
export const projectionAlias = (index: number) => `__eqb_${index}`;

export const renderTokens = (
  tokens: readonly SqlToken[],
  numbered: boolean
) => {
  //@ verify
  //@ contract Each bind token emits one placeholder and contributes its value in token order.
  //@ ensures \result.params.length <= tokens.length
  const params: unknown[] = [];
  let sql = "";

  for (const token of tokens) {
    if (token.kind === "bind") {
      params.push(token.value);
      sql += numbered ? `$${params.length}` : "?";
    } else {
      sql += token.text;
    }
  }

  const rendered: RenderedTokens = { sql, params };

  return rendered;
};

export const quoteWithDoubledDelimiter = (value: string, delimiter: string) => {
  //@ verify
  //@ contract The delimiter surrounds the value and occurs only in pairs inside it.
  //@ requires delimiter.length === 1
  //@ ensures \result.startsWith(delimiter) && \result.endsWith(delimiter)
  //@ ensures value.length + 2 <= \result.length && \result.length <= value.length * 2 + 2
  let escaped = delimiter;

  for (let index = 0; index < value.length; index += 1) {
    const character = value.slice(index, index + 1);
    escaped += character === delimiter ? delimiter + delimiter : character;
  }

  return escaped + delimiter;
};

export const supportsClause = (dialect: string, clause: string) => {
  //@ verify
  //@ contract A clause is supported exactly by the corresponding dialect profiles.
  //@ ensures \result === ((dialect === "pg" || dialect === "sqlite" || (dialect === "mariadb" && (clause === "insertReturning" || clause === "deleteReturning"))) && (clause === "fullJoin" || clause === "insertReturning" || clause === "updateReturning" || clause === "deleteReturning"))
  if (clause === "insertReturning" || clause === "deleteReturning") {
    return dialect === "pg" || dialect === "sqlite" || dialect === "mariadb";
  }

  if (clause === "fullJoin" || clause === "updateReturning") {
    return dialect === "pg" || dialect === "sqlite";
  }

  return false;
};
