import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle", "migrations");

/** Applies checked-in migrations using a short-lived connection. */
export async function applyMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await client.end();
  }
}

/**
 * Drops all application data and migration history, then rebuilds from checked-in
 * migrations. Callers must pass a safety guard first; this function does not check.
 */
export async function rebuildFromMigrations(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await client.begin(async (transaction) => {
      await transaction`DROP SCHEMA IF EXISTS drizzle CASCADE`;
      await transaction`DROP SCHEMA IF EXISTS public CASCADE`;
      await transaction`CREATE SCHEMA public`;
    });
  } finally {
    await client.end();
  }

  await applyMigrations(databaseUrl);
}
