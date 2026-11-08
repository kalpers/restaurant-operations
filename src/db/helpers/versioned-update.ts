import { and, eq, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

import type { DatabaseExecutor } from "../transactions/transaction-context";
import { ConcurrencyError } from "../../shared/errors/concurrency-error";
import { NotFoundError } from "../../shared/errors/app-error";
import { nextVersion } from "./versioning";

type VersionedTable = PgTable & {
  id: PgColumn;
  organizationId: PgColumn;
  version: PgColumn;
  updatedAt: PgColumn;
};

/**
 * `UPDATE ... WHERE id AND organization AND version = expected`, bumping the version.
 * No row means either the record isn't in this organization (not found) or someone else
 * changed it (concurrency conflict); the two are told apart with one follow-up read.
 */
export async function updateVersioned<Table extends VersionedTable>(
  executor: DatabaseExecutor,
  table: Table,
  args: {
    id: string;
    organizationId: string;
    expectedVersion: number;
    values: Record<string, unknown>;
    label: string;
    extraWhere?: SQL;
  },
): Promise<Table["$inferSelect"]> {
  const where = and(
    eq(table.id, args.id),
    eq(table.organizationId, args.organizationId),
    eq(table.version, args.expectedVersion),
    args.extraWhere,
  );
  const rows = (await executor
    .update(table)
    .set({
      ...args.values,
      version: nextVersion(table.version),
      updatedAt: new Date(),
    } as never)
    .where(where)
    .returning()) as Table["$inferSelect"][];

  if (rows[0]) {
    return rows[0];
  }

  const [existing] = await executor
    .select({ id: table.id })
    .from(table as PgTable)
    .where(and(eq(table.id, args.id), eq(table.organizationId, args.organizationId)));

  if (!existing) {
    throw new NotFoundError(args.label);
  }

  throw new ConcurrencyError(args.label, args.id);
}
