import { selectForDialect } from "./select.ts";
import type { SelectEntrypoints } from "./select.ts";

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
