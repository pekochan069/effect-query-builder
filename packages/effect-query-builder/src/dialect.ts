import { Effect } from "effect";
import { SqlError } from "effect/sql";
import type { SqlClient } from "effect/sql";

import type { SqlDialect } from "./kernel/compile.ts";

export type Dialect = "portable" | SqlDialect;

export type CheckDialect<D extends SqlDialect> = [D] extends [never]
  ? never
  : unknown;

export const getClientDialect = (client: SqlClient.SqlClient) =>
  client.onDialectOrElse({
    mysql: () => "mysql" as const,
    orElse: () => null,
    pg: () => "pg" as const,
    sqlite: () => "sqlite" as const,
  });

export const unsupportedDialect = (
  operation: string,
  message: string,
  cause: unknown = message
) =>
  Effect.fail(
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({ cause, message, operation }),
    })
  );
