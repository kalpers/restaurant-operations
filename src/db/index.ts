import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "../config/env";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

type DatabaseConnection = {
  client: postgres.Sql;
  database: Database;
};

// Stored on globalThis so dev-server hot reloads reuse one connection pool.
const connectionStore = globalThis as typeof globalThis & {
  restaurantOpsConnection?: DatabaseConnection;
};

/**
 * The application database. The pool is created on first use; connections open
 * on the first query.
 */
export function getDatabase(): Database {
  if (!connectionStore.restaurantOpsConnection) {
    const client = postgres(getEnv().DATABASE_URL, {
      max: 10,
      connect_timeout: 10,
    });

    connectionStore.restaurantOpsConnection = {
      client,
      database: drizzle(client, { schema }),
    };
  }

  return connectionStore.restaurantOpsConnection.database;
}

/** Closes the pool so short-lived processes such as test runs can exit. */
export async function closeDatabase(): Promise<void> {
  const connection = connectionStore.restaurantOpsConnection;

  if (connection) {
    connectionStore.restaurantOpsConnection = undefined;
    await connection.client.end();
  }
}
