import { selectForDialect } from "./select.ts";
import type { SelectEntrypoints } from "./select.ts";
import { writeForDialect } from "./write.ts";
import type { WriteEntrypoints } from "./write.ts";

export { jsonArrayLength, jsonExtract, jsonType } from "./expression.ts";

const scoped = selectForDialect("sqlite");

export const from: SelectEntrypoints<"sqlite">["from"] = scoped.from;
export const select: SelectEntrypoints<"sqlite">["select"] = scoped.select;
export const withCte: SelectEntrypoints<"sqlite">["withCte"] = scoped.withCte;

const writes = writeForDialect("sqlite");

export const insertInto: WriteEntrypoints<"sqlite", false>["insertInto"] =
  writes.insertInto;

export const update: WriteEntrypoints<"sqlite", false>["update"] =
  writes.update;

export const deleteFrom: WriteEntrypoints<"sqlite", false>["deleteFrom"] =
  writes.deleteFrom;
