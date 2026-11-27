import { selectForDialect } from "./select.ts";
import type { SelectEntrypoints } from "./select.ts";

const scoped = selectForDialect("mysql");

export const from: SelectEntrypoints<"mysql">["from"] = scoped.from;
export const select: SelectEntrypoints<"mysql">["select"] = scoped.select;
export const withCte: SelectEntrypoints<"mysql">["withCte"] = scoped.withCte;
