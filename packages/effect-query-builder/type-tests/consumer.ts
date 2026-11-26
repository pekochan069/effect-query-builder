import { Schema } from "effect";
import { Table } from "effect-query-builder";
import * as Model from "effect/schema/Model";

class User extends Model.Class<User>("User")({
  name: Schema.String,
  active: Model.BooleanSqlite,
}) {}

const users = Table.fromModel("users", User);

users.encodeUpdate({});

users.encodeUpdate({ active: false });

// @ts-expect-error The update expects a decoded boolean.
users.encodeUpdate({ active: 0 });
