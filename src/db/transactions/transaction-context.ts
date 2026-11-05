import type { Database } from "../index";

export type DatabaseTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

/**
 * What repositories and domain operations accept, so they work alone with the
 * database or as part of a caller's transaction.
 */
export type DatabaseExecutor = Database | DatabaseTransaction;

/**
 * Runs the callback in one transaction: it commits when the callback resolves and
 * rolls back when it rejects. Pass the transaction to every participating operation.
 * An operation that uses a different connection is not part of the unit of work.
 */
export function withTransaction<Result>(
  database: Database,
  callback: (transaction: DatabaseTransaction) => Promise<Result>,
): Promise<Result> {
  return database.transaction(callback);
}
