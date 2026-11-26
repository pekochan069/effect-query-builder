import { Schema } from "effect";
import type { Table } from "effect-query-builder";
import * as Model from "effect/schema/Model";

class User extends Model.Class<User>("User")({
  name: Schema.String,
  active: Model.BooleanSqlite,
}) {}

type Users = ReturnType<typeof Table.fromModel<"users", typeof User>>;

type Update = Parameters<Users["encodeUpdate"]>[0];

type AcceptsUpdate<Input extends Update> = Input;

export type EmptyUpdate = AcceptsUpdate<Record<string, never>>;

export type PartialUpdate = AcceptsUpdate<{ active: false }>;

// @ts-expect-error The update expects a decoded boolean.
export type NumericUpdate = AcceptsUpdate<{ active: 0 }>;
