import { selectForDialect } from "./select.ts";
import type { SelectEntrypoints } from "./select.ts";

export { jsonArrayLength, jsonExtract, jsonType } from "./expression.ts";

const scoped = selectForDialect("sqlite");

export const from: SelectEntrypoints<"sqlite">["from"] = scoped.from;
export const select: SelectEntrypoints<"sqlite">["select"] = scoped.select;
export const withCte: SelectEntrypoints<"sqlite">["withCte"] = scoped.withCte;
