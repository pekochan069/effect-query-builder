import { selectForDialect } from "./select.ts";
import type { SelectEntrypoints } from "./select.ts";
import { writeForDialect } from "./write.ts";
import type { WriteEntrypoints } from "./write.ts";

export {
  ilike,
  jsonbContains,
  jsonbGet,
  jsonbHasKey,
  jsonbText,
} from "./expression.ts";

const scoped = selectForDialect("pg");

export const from: SelectEntrypoints<"pg">["from"] = scoped.from;
export const select: SelectEntrypoints<"pg">["select"] = scoped.select;
export const withCte: SelectEntrypoints<"pg">["withCte"] = scoped.withCte;

const writes = writeForDialect("pg");

export const insertInto: WriteEntrypoints<"pg", false>["insertInto"] =
  writes.insertInto;

export const update: WriteEntrypoints<"pg", false>["update"] = writes.update;

export const deleteFrom: WriteEntrypoints<"pg", false>["deleteFrom"] =
  writes.deleteFrom;
