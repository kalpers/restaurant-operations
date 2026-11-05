import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { getEnv } from "../../src/config/env";
import {
  loadLocalEnv,
  readExplicitNodeEnv,
  requireTestDatabaseUrl,
} from "../../src/config/tooling-env";
import { applyMigrations } from "../../src/db/maintenance/apply-migrations";
import { assertTestDatabaseAllowed } from "../../src/db/maintenance/database-safety";
import type { Database } from "../../src/db";
import * as schema from "../../src/db/schema";
import { seeds } from "../../src/db/seeds/registry";
import { runSeeds } from "../../src/db/seeds/run-seeds";

function urlForDatabase(serverUrl: string, databaseName: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function withMaintenanceConnection(
  serverUrl: string,
  callback: (client: postgres.Sql) => Promise<void>,
): Promise<void> {
  const client = postgres(urlForDatabase(serverUrl, "postgres"), {
    max: 1,
    onnotice: () => {},
  });

  try {
    await callback(client);
  } finally {
    await client.end();
  }
}

export async function dropDatabase(
  serverUrl: string,
  databaseName: string,
): Promise<void> {
  await withMaintenanceConnection(serverUrl, async (client) => {
    await client`DROP DATABASE IF EXISTS ${client(databaseName)} WITH (FORCE)`;
  });
}

/** Creates an empty database on the same server and returns its URL. */
export async function recreateEmptyDatabase(
  serverUrl: string,
  databaseName: string,
): Promise<string> {
  await withMaintenanceConnection(serverUrl, async (client) => {
    await client`DROP DATABASE IF EXISTS ${client(databaseName)} WITH (FORCE)`;
    await client`CREATE DATABASE ${client(databaseName)}`;
  });

  return urlForDatabase(serverUrl, databaseName);
}

/** Uses its own connection, because getDatabase() may point at development here. */
async function seedDatabase(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, { max: 1, onnotice: () => {} });

  try {
    await runSeeds(drizzle(client, { schema }) as unknown as Database, seeds);
  } finally {
    await client.end();
  }
}

/** Guards, recreates, migrates and seeds the isolated test database. */
export async function prepareTestDatabase(): Promise<void> {
  loadLocalEnv();

  const testDatabaseUrl = requireTestDatabaseUrl();
  const databaseName = assertTestDatabaseAllowed({
    nodeEnv: readExplicitNodeEnv(),
    databaseUrl: getEnv().DATABASE_URL,
    testDatabaseUrl,
  });

  await recreateEmptyDatabase(testDatabaseUrl, databaseName);
  await applyMigrations(testDatabaseUrl);
  await seedDatabase(testDatabaseUrl);
}
