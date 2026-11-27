import { selectForDialect } from "./select.ts";
import type { SelectEntrypoints } from "./select.ts";
import { writeForDialect } from "./write.ts";
import type { WriteEntrypoints } from "./write.ts";

const scoped = selectForDialect("mysql");

export const from: SelectEntrypoints<"mysql">["from"] = scoped.from;
export const select: SelectEntrypoints<"mysql">["select"] = scoped.select;
export const withCte: SelectEntrypoints<"mysql">["withCte"] = scoped.withCte;

const writes = writeForDialect("mysql");

export const insertInto: WriteEntrypoints<"mysql", false>["insertInto"] =
  writes.insertInto;

export const update: WriteEntrypoints<"mysql", false>["update"] = writes.update;

export const deleteFrom: WriteEntrypoints<"mysql", false>["deleteFrom"] =
  writes.deleteFrom;

export const mariadb: WriteEntrypoints<"mysql", true> = writeForDialect(
  "mysql",
  true
);
