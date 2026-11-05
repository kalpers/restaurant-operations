import { sql } from "drizzle-orm";

import type { Database } from "@/db";

export type HealthDatabase = Pick<Database, "execute">;

export type DatabaseHealth =
  | { status: "ok"; database: "connected" }
  | { status: "unavailable"; database: "disconnected" };

/**
 * Checks that PostgreSQL answers a query. Takes a resolver rather than an open
 * database because resolving can itself fail on invalid configuration, which
 * must also report as unavailable.
 *
 * Only the error's name and code are logged: driver messages can contain the
 * database host and port.
 */
export async function checkDatabaseHealth(
  resolveDatabase: () => HealthDatabase,
): Promise<DatabaseHealth> {
  try {
    await resolveDatabase().execute(sql`SELECT 1`);
    return { status: "ok", database: "connected" };
  } catch (error) {
    console.error(
      JSON.stringify({
        severity: "error",
        module: "infrastructure.health",
        operation: "check-database-health",
        message: "Database health check failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
        errorCode: readErrorCode(error),
      }),
    );
    return { status: "unavailable", database: "disconnected" };
  }
}

/** Drizzle wraps driver errors, so the driver's code can be on the `cause` chain. */
export function readErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }
  if ("code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "cause" in error ? readErrorCode(error.cause) : undefined;
}
