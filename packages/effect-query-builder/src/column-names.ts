//@ option string-semantics javascript-utf16
//@ option dafny-library local

export type ColumnNaming = "snake_case" | ((key: string) => string);

export const columnName = (key: string, naming: ColumnNaming | undefined) => {
  if (naming === "snake_case") {
    return key
      .replaceAll(
        /(?<acronym>[A-Z])(?<word>[A-Z][a-z])/gu,
        "$<acronym>_$<word>"
      )
      .replaceAll(/(?<end>[a-z0-9])(?<start>[A-Z])/gu, "$<end>_$<start>")
      .toLowerCase();
  }

  return naming === undefined ? key : naming(key);
};

export const hasDuplicateColumnNames = (names: readonly string[]) => {
  //@ verify
  //@ contract The result is true exactly when two distinct positions hold the same column name.
  //@ ensures \result === exists(later: int, 0 <= later && later < names.length && exists(earlier: int, 0 <= earlier && earlier < later && names[earlier] === names[later]))
  for (let current = 0; current < names.length; current += 1) {
    //@ invariant 0 <= current && current <= names.length
    //@ invariant forall(later: int, 0 <= later && later < current ==> forall(earlier: int, 0 <= earlier && earlier < later ==> names[earlier] !== names[later]))
    for (let previous = 0; previous < current; previous += 1) {
      //@ invariant 0 <= previous && previous <= current
      //@ invariant forall(earlier: int, 0 <= earlier && earlier < previous ==> names[earlier] !== names[current])
      if (names[current] === names[previous]) {
        return true;
      }
    }
  }

  return false;
};
