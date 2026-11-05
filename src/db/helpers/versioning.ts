import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import { integer } from "drizzle-orm/pg-core";

import { ConcurrencyError } from "../../shared/errors/concurrency-error";

/** Optimistic concurrency, only for mutable high-contention records. */
export function versionColumn() {
  return integer("version").notNull().default(1);
}

/** Use in `.set({ version: nextVersion(table.version) })`. */
export function nextVersion(column: AnyColumn): SQL<number> {
  return sql<number>`${column} + 1`;
}

/**
 * Checks the rows returned by `UPDATE ... WHERE id = ? AND version = ? RETURNING`.
 * No row means the record changed or no longer exists, so the caller's data is stale.
 */
export function assertVersionMatched<Row>(
  updatedRows: readonly Row[],
  entity: { type: string; id: string },
): Row {
  const [row] = updatedRows;

  if (row === undefined) {
    throw new ConcurrencyError(entity.type, entity.id);
  }

  return row;
}
