import { Database } from "bun:sqlite";
import { expect, expectTypeOf, test } from "bun:test";

import {
  Arbitrary,
  Context,
  DateTime,
  Effect,
  Equal,
  Option,
  Result,
  Schema,
  SchemaTransformation,
  Stream,
} from "effect";
import { Reactivity } from "effect/reactivity";
import * as Model from "effect/schema/Model";
import { SqlClient, Statement } from "effect/sql";
import type { SqlConnection } from "effect/sql";

import { Table } from "../src/index.ts";
import type { TableOptions } from "../src/index.ts";
import type { QualifiedName } from "../src/kernel/ast.ts";

test("chooses verbatim, factory, table, and explicit column names", () => {
  const schema = Schema.Struct({
    displayName: Schema.String,
    externalURL: Schema.String,
    HTTPStatus: Schema.Int,
  });

  const verbatim = Table.fromSchema("users", schema);
  expect(verbatim.c.displayName.name).toBe("displayName");

  const tables = Table.withNaming("snake_case");

  const users = tables.fromSchema("users", schema, {
    columns: { externalURL: { name: "link" } },
  });

  expect(Object.values(users.c).map((column) => column.name)).toEqual([
    "display_name",
    "link",
    "http_status",
  ]);

  const other = tables.fromSchema("users", schema, {
    naming: (key) => `db_${key}`,
  });

  expect(other.c.displayName.name).toBe("db_displayName");
});

test("rejects a column override that collides with another mapped name", () => {
  const schema = Schema.Struct({
    displayName: Schema.String,
    userName: Schema.String,
  });

  expect(() =>
    Table.fromSchema("users", schema, {
      naming: "snake_case",
      columns: { userName: { name: "display_name" } },
    })
  ).toThrow(/duplicate physical column name/iu);
});

test("derives SQL type and nullability from the encoded schema", () => {
  const schema = Schema.Struct({
    displayName: Schema.String,
    count: Schema.Int.pipe(Schema.brand("Count")),
    rating: Schema.Number,
    active: Schema.Boolean,
    enabled: Schema.BooleanFromBit,
    optionalNote: Schema.OptionFromNullOr(Schema.String),
    payload: Schema.NullOr(
      Schema.fromJsonString(Schema.Struct({ tag: Schema.String }))
    ),
    code: Schema.NumberFromString,
    bytes: Schema.instanceOf(Uint8Array),
  });

  const { c } = Table.fromSchema("users", schema, {
    columns: {
      bytes: { sqlType: { pg: "BYTEA", sqlite: "BLOB", mysql: "BLOB" } },
    },
  });

  expect(c.displayName.sqlType.pg).toBe("TEXT");
  expect(c.count.sqlType.sqlite).toBe("INTEGER");
  expect(c.rating.sqlType.pg).toBe("DOUBLE PRECISION");
  expect(c.active.sqlType).toEqual({
    pg: "BOOLEAN",
    sqlite: "INTEGER",
    mysql: "BOOLEAN",
  });
  expect(c.enabled.sqlType.sqlite).toBe("INTEGER");
  expect(c.optionalNote.nullable).toBe(true);
  expect(c.optionalNote.sqlType.sqlite).toBe("TEXT");
  expect(c.payload.nullable).toBe(true);
  expect(c.payload.sqlType).toEqual({
    pg: "JSONB",
    sqlite: "TEXT",
    mysql: "JSON",
  });
  expect(c.code.sqlType.pg).toBe("TEXT");
  expect(c.code.nullable).toBe(false);
  expect(c.bytes.sqlType).toEqual({
    pg: "BYTEA",
    sqlite: "BLOB",
    mysql: "BLOB",
  });
});

test("infers SQL storage from enum values", () => {
  const { c } = Table.fromSchema(
    "jobs",
    Schema.Struct({
      status: Schema.NullOr(Schema.Enum({ Pending: "pending", Done: "done" })),
      priority: Schema.Enum({ Low: 0, High: 1 }),
      weight: Schema.Enum({ Light: 0.25, Heavy: 0.75 }),
    })
  );

  expect(c.status.sqlType).toEqual({
    pg: "TEXT",
    sqlite: "TEXT",
    mysql: "TEXT",
  });
  expect(c.status.nullable).toBe(true);
  expect(c.priority.sqlType).toEqual({
    pg: "INTEGER",
    sqlite: "INTEGER",
    mysql: "INTEGER",
  });
  expect(c.weight.sqlType).toEqual({
    pg: "DOUBLE PRECISION",
    sqlite: "REAL",
    mysql: "DOUBLE",
  });
});

test("leaves enum storage unspecified for incompatible member types", () => {
  const { c } = Table.fromSchema(
    "jobs",
    Schema.Struct({ status: Schema.Enum({ Pending: "pending", Done: 1 }) }),
    { columns: { status: { sqlType: { pg: "TEXT" } } } }
  );

  expect(c.status.sqlType).toEqual({
    pg: "TEXT",
    sqlite: undefined,
    mysql: undefined,
  });
});

test("applies a SQL type override ahead of the inferred dialect type", () => {
  const { c } = Table.fromSchema(
    "users",
    Schema.Struct({ name: Schema.String }),
    {
      columns: { name: { sqlType: { pg: "VARCHAR(80)" } } },
    }
  );

  expect(c.name.sqlType).toEqual({
    pg: "VARCHAR(80)",
    sqlite: "TEXT",
    mysql: "TEXT",
  });
});

const UserId = Schema.Int.pipe(Schema.brand("UserId"));

const userFields = {
  id: Model.GeneratedByDb(UserId),
  displayName: Schema.String,
  optionalName: Model.FieldOption(Schema.String),
  active: Model.BooleanSqlite,
  createdAt: Model.DateTimeInsert,
  updatedAt: Model.DateTimeUpdate,
  profile: Model.JsonFromString(Schema.Struct({ tag: Schema.String })),
};

class User extends Model.Class<User>("User")(userFields) {}

test("preserves model class reads and native insert and partial update codecs", () => {
  const users = Table.fromModel("users", User, { naming: "snake_case" });
  const timestamp = "2025-05-01T10:00:00.000Z";

  const read = Effect.runSync(
    users.decodeRow({
      id: 42,
      display_name: "Ada",
      optional_name: null,
      active: 1,
      created_at: timestamp,
      updated_at: timestamp,
      profile: '{"tag":"staff"}',
    })
  );

  expect(read).toBeInstanceOf(User);
  expect(read.id).toBe(UserId.make(42));
  expect(read.optionalName).toEqual(Option.none());
  expect(read.active).toBe(true);
  expect(DateTime.formatIso(read.createdAt)).toBe(timestamp);
  expect(read.profile).toEqual({ tag: "staff" });

  const now = Model.Override(DateTime.makeUnsafe(timestamp));
  expect(users.insert).toBe(User.insert);

  const insert = users.insert.make({
    displayName: "Ada",
    optionalName: Option.some("A"),
    active: true,
    createdAt: now,
    updatedAt: now,
    profile: { tag: "staff" },
  });

  expect(Effect.runSync(users.encodeInsert(insert))).toEqual({
    display_name: "Ada",
    optional_name: "A",
    active: 1,
    created_at: timestamp,
    updated_at: timestamp,
    profile: '{"tag":"staff"}',
  });

  expect(Effect.runSync(users.encodeUpdate({}))).toEqual({});
  expect(
    Effect.runSync(
      users.encodeUpdate({
        active: false,
        optionalName: Option.none(),
        updatedAt: now,
      })
    )
  ).toEqual({
    active: 0,
    optional_name: null,
    updated_at: timestamp,
  });
  expect(users.c.optionalName.nullable).toBe(true);
  expect(users.c.profile.sqlType.pg).toBe("JSONB");
});

test("extracts database variants from Model.Struct", () => {
  const model = Model.Struct({
    id: Model.GeneratedByDb(UserId),
    active: Model.BooleanSqlite,
    writeOnly: Model.FieldOnly(["insert"])(Schema.String),
    jsonOnly: Model.FieldOnly(["json"])(Schema.String),
  });

  const table = Table.fromModel("users", model);
  expect(Effect.runSync(table.decodeRow({ id: 42, active: 1 }))).toEqual({
    id: UserId.make(42),
    active: true,
  });
  expect(
    Effect.runSync(table.encodeInsert({ active: true, writeOnly: "secret" }))
  ).toEqual({ active: 1, writeOnly: "secret" });
  expect(Object.keys(table.c)).toEqual(["id", "active", "writeOnly"]);
});

test("omits generated fields, permits DB defaults on insert, and makes the update a patch", () => {
  const schema = Schema.Struct({
    id: Schema.Int,
    title: Schema.String,
    viewCount: Schema.Int,
    ownerId: Schema.Int,
  });

  const owners = Table.fromSchema("owners", Schema.Struct({ id: Schema.Int }));

  const posts = Table.fromSchema("posts", schema, {
    naming: "snake_case",
    columns: { id: { generated: true }, viewCount: { default: "0" } },
    primaryKey: ["id", "ownerId"],
    foreignKeys: [{ columns: ["ownerId"], references: [owners.c.id] }],
    unique: [["title"]],
    indexes: [{ columns: ["ownerId"], name: "posts_owner_idx" }],
  });

  expect(
    Effect.runSync(posts.encodeInsert({ title: "Example", ownerId: 11 }))
  ).toEqual({
    title: "Example",
    owner_id: 11,
  });
  expect(
    Effect.runSync(
      posts.encodeInsert({ title: "Example", viewCount: 5, ownerId: 11 })
    )
  ).toEqual({
    title: "Example",
    view_count: 5,
    owner_id: 11,
  });
  expect(Effect.runSync(posts.encodeUpdate({ viewCount: 2 }))).toEqual({
    view_count: 2,
  });
  expect(posts.c.viewCount.default).toBe("0");
  expect(posts.c.id.generated).toBe(true);
  expect(posts.constraints).toEqual({
    primaryKey: ["id", "ownerId"],
    foreignKeys: [{ columns: ["ownerId"], references: [owners.c.id] }],
    unique: [["title"]],
    indexes: [{ columns: ["ownerId"], name: "posts_owner_idx" }],
  });
});

test("requires insert fields unless their metadata guarantees omission", () => {
  const schema = Schema.Struct({ title: Schema.String });
  const options: TableOptions<"title"> = { naming: "snake_case" };
  const broad = Table.fromSchema("posts", schema, options);

  const dynamic = (generated: boolean, useDefault: boolean) =>
    Table.fromSchema("posts", schema, {
      columns: {
        title: useDefault ? { default: "'Post'", generated } : { generated },
      },
    });

  const columns: Readonly<Record<string, { readonly default: string }>> = {};
  const sparse = Table.fromSchema("posts", schema, { columns });

  const optional = (metadata?: {
    readonly columns: { readonly title: { readonly default: string } };
  }) => Table.fromSchema("posts", schema, metadata);

  expectTypeOf<Parameters<typeof broad.encodeInsert>[0]>().toEqualTypeOf<{
    readonly title: string;
  }>();
  expectTypeOf<
    Parameters<ReturnType<typeof dynamic>["encodeInsert"]>[0]
  >().toEqualTypeOf<{ readonly title: string }>();
  expectTypeOf<Parameters<typeof sparse.encodeInsert>[0]>().toEqualTypeOf<{
    readonly title: string;
  }>();
  expectTypeOf<
    Parameters<ReturnType<typeof optional>["encodeInsert"]>[0]
  >().toEqualTypeOf<{ readonly title: string }>();

  expect(
    Effect.runSync(dynamic(false, false).encodeInsert({ title: "Post" }))
  ).toEqual({
    title: "Post",
  });
});

test("executes and decodes a SQLite statement using the table's physical keys", () => {
  using db = new Database(":memory:");
  db.run("CREATE TABLE users (display_name TEXT NOT NULL)");
  db.run("INSERT INTO users VALUES ('Ada')");

  const execute: SqlConnection.Connection["execute"] = (
    sql,
    params,
    transform
  ) =>
    Effect.sync(() => {
      expect(params).toEqual([]);
      const rows = db.query<object, []>(sql).all();

      return transform === undefined ? rows : transform(rows);
    });

  const values: SqlConnection.Connection["executeValues"] = (sql) =>
    Effect.sync(() => db.query(sql).values());

  const sql = Effect.runSync(
    SqlClient.make({
      driver: "sqlite-bun",
      spanAttributes: [],
      compiler: Statement.makeCompilerSqlite((key) => `driver_${key}`),
      transformRows: Statement.defaultTransforms((key) => `driver_${key}`)
        .array,
      acquirer: Effect.succeed({
        execute,
        executeRaw: (query, params) => execute(query, params, undefined),
        executeUnprepared: execute,
        executeValues: values,
        executeValuesUnprepared: values,
        executeStream: (query, params, transform) =>
          Stream.fromEffect(execute(query, params, transform)).pipe(
            Stream.flatMap(Stream.fromIterable)
          ),
      }),
    }).pipe(Effect.provide(Reactivity.layer))
  );

  const users = Table.withNaming("snake_case").fromSchema(
    "users",
    Schema.Struct({ displayName: Schema.String })
  );

  const query = sql`SELECT display_name FROM users`;

  expect(Effect.runSync(query)).toEqual([{ driver_display_name: "Ada" }]);
  expect(Effect.runSync(Effect.result(users.selectRows(query)))).toEqual(
    Result.succeed([{ displayName: "Ada" }])
  );
});

interface DecodePrefix {
  readonly decodePrefix: string;
}

interface EncodePrefix {
  readonly encodePrefix: string;
}

const DecodePrefixService = Context.Service<DecodePrefix, string>(
  "tests/DecodePrefix"
);

const EncodePrefixService = Context.Service<EncodePrefix, string>(
  "tests/EncodePrefix"
);

test("decodes projected physical columns without exposing parse options", () => {
  const table = Table.fromSchema(
    "users",
    Schema.Struct({ displayName: Schema.String }),
    { naming: "snake_case" }
  );

  expectTypeOf(table.decodeRow).parameters.toEqualTypeOf<[row: unknown]>();
  expect(
    Effect.runSync(
      table.decodeRow({
        display_name: "Ada",
        displayName: "ignored",
        unrelated_column: 2,
      })
    )
  ).toEqual({ displayName: "Ada" });
  expect(
    Effect.runSync(Effect.result(table.decodeRow({ displayName: "ignored" })))
      ._tag
  ).toBe("Failure");
});

test("uses and tracks each schema's encoding and decoding services", () => {
  const field = Schema.String.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformEffect({
        decode: (value) =>
          DecodePrefixService.useSync((prefix) => prefix + value),
        encode: (value) =>
          EncodePrefixService.useSync((prefix) => prefix + value),
      })
    )
  );

  const schema = Schema.Struct({ externalName: field });
  const table = Table.fromSchema("items", schema, { naming: "snake_case" });
  const read = table.decodeRow({ external_name: "item" });
  const insert = table.encodeInsert({ externalName: "item" });
  const update = table.encodeUpdate({ externalName: "item" });
  expectTypeOf<Effect.Services<typeof read>>().toEqualTypeOf<DecodePrefix>();
  expectTypeOf<Effect.Services<typeof insert>>().toEqualTypeOf<EncodePrefix>();
  expectTypeOf<Effect.Services<typeof update>>().toEqualTypeOf<EncodePrefix>();
  expectTypeOf<
    typeof table.insert.DecodingServices
  >().toEqualTypeOf<DecodePrefix>();
  expectTypeOf<
    typeof table.update.DecodingServices
  >().toEqualTypeOf<DecodePrefix>();
  expect(
    Effect.runSync(Effect.provideService(read, DecodePrefixService, "read:"))
  ).toEqual({ externalName: "read:item" });
  expect(
    Effect.runSync(Effect.provideService(insert, EncodePrefixService, "write:"))
  ).toEqual({ external_name: "write:item" });
});

test("brands columns with the table scope, field, type, encoding and nullability", () => {
  const schema = Schema.Struct({
    id: UserId,
    sibling: UserId,
    label: Schema.OptionFromNullOr(Schema.String),
  });

  const users = Table.fromSchema("users", schema);
  const archive = Table.fromSchema("archive", schema);
  const audit = Table.fromSchema({ schema: "audit", name: "users" }, schema);
  const live = Table.fromSchema({ schema: "live", name: "users" }, schema);

  expectTypeOf(users.c.id).not.toExtend<typeof archive.c.id>();
  expectTypeOf(users.c.id).not.toExtend<typeof users.c.sibling>();
  expectTypeOf(audit.c.id).not.toExtend<typeof live.c.id>();
  expectTypeOf(audit.c.id).not.toExtend<typeof users.c.id>();
  expectTypeOf(users.c.id).not.toExtend<typeof audit.c.id>();
  expectTypeOf(audit.c.id.table).toExtend<QualifiedName>();
  expectTypeOf(users.c.id.table).toExtend<QualifiedName>();
  expectTypeOf(users.c.id.key).toEqualTypeOf<"id">();
  expectTypeOf<typeof users.c.label.schema.Type>().toEqualTypeOf<
    Option.Option<string>
  >();
  expectTypeOf<typeof users.c.label.schema.Encoded>().toEqualTypeOf<
    string | null
  >();
  expectTypeOf(users.c.label.nullable).toEqualTypeOf<true>();
  expectTypeOf(users.c.id.nullable).toEqualTypeOf<false>();

  const model = Table.fromModel("users", User);
  expectTypeOf<typeof model.c.id.schema.Type>().toEqualTypeOf<
    typeof UserId.Type
  >();
  expectTypeOf<typeof model.c.active.schema.Encoded>().toEqualTypeOf<0 | 1>();
  expectTypeOf<keyof typeof model.insert.Type>().toEqualTypeOf<
    | "displayName"
    | "optionalName"
    | "active"
    | "createdAt"
    | "updatedAt"
    | "profile"
  >();
  expectTypeOf<keyof typeof model.update.Type>().toEqualTypeOf<
    "displayName" | "optionalName" | "active" | "updatedAt" | "profile"
  >();
  expectTypeOf<Record<string, never>>().toExtend<typeof model.update.Type>();

  const derived = Table.fromSchema("users", schema, {
    columns: { id: { generated: true }, label: { default: "NULL" } },
  });

  expectTypeOf<keyof typeof derived.insert.Type>().toEqualTypeOf<
    "label" | "sibling"
  >();
  expectTypeOf<{ sibling: typeof UserId.Type }>().toExtend<
    typeof derived.insert.Type
  >();
  expectTypeOf<Record<string, never>>().not.toExtend<
    typeof derived.insert.Type
  >();
  expectTypeOf<Record<string, never>>().toExtend<typeof derived.update.Type>();
});

test("supports numeric fields and handles inherited metadata names as own keys", () => {
  const table = Table.fromSchema(
    "columns",
    Schema.Struct({
      1: Schema.Int,
      constructor: Schema.String,
      toString: Schema.String,
    }),
    {
      columns: { 1: { name: "first" } },
    }
  );

  expect(table.c[1].key).toBe("1");
  expect(table.c.constructor.name).toBe("constructor");
  expect(table.c.toString.name).toBe("toString");
  expect(
    Effect.runSync(
      table.decodeRow({ first: 1, constructor: "construct", toString: "text" })
    )
  ).toEqual({
    1: 1,
    constructor: "construct",
    toString: "text",
  });
});

test("rejects symbol keys that cannot identify SQL columns", () => {
  const key = Symbol("private");
  const schema = Schema.Struct({ [key]: Schema.String });
  expect(() => Table.fromSchema("users", schema)).toThrow(
    /must use string or numeric keys/iu
  );
});

test("keeps whole-row checks on unchanged plain struct inserts", () => {
  const schema = Schema.Struct({
    min: Schema.Int,
    max: Schema.Int,
  }).check(Schema.makeFilter(({ min, max }) => min <= max));

  const table = Table.fromSchema("ranges", schema, { naming: "snake_case" });
  expect(
    Effect.runSync(Effect.result(table.encodeInsert({ min: 2, max: 1 })))._tag
  ).toBe("Failure");
  expect(Effect.runSync(table.encodeUpdate({ min: 2 }))).toEqual({ min: 2 });
});

test.each([
  ["generated", { generated: true }],
  ["defaulted", { default: "0" }],
])(
  "rejects a %s insert field on a struct with a whole-row check",
  (_, column) => {
    const schema = Schema.Struct({
      min: Schema.Int,
      max: Schema.Int,
    }).check(Schema.makeFilter(({ min, max }) => min <= max));

    expect(() =>
      Table.fromSchema("ranges", schema, { columns: { min: column } })
    ).toThrow(/whole-row checks/iu);
  }
);

test("round-trips generated values through physical row codecs", () => {
  const schema = Schema.Struct({
    displayName: Schema.String,
    active: Schema.BooleanFromBit,
    profile: Schema.fromJsonString(Schema.Struct({ tag: Schema.String })),
    optionalLabel: Schema.OptionFromNullOr(Schema.String),
  });

  const table = Table.withNaming("snake_case").fromSchema("users", schema, {
    columns: { displayName: { name: "col_name" } },
  });

  const check = Arbitrary.checkEffect(
    Arbitrary.schema(schema),
    (row) =>
      Effect.gen(function* roundTrip() {
        const encoded = yield* table.encodeInsert(row);
        const decoded = yield* table.decodeRow(encoded);

        return Equal.equals(decoded, row);
      }),
    { seed: process.env.EQB_CODEC_SEED ?? "table-codecs", runs: 100 }
  );

  expect(Arbitrary.formatCheckFailure(Effect.runSync(check))).toBeUndefined();
});
