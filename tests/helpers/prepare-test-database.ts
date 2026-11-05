import postgres from "postgres";

import { getEnv } from "../../src/config/env";
import {
  loadLocalEnv,
  readExplicitNodeEnv,
  requireTestDatabaseUrl,
} from "../../src/config/tooling-env";
import { applyMigrations } from "../../src/db/maintenance/apply-migrations";
import { assertTestDatabaseAllowed } from "../../src/db/maintenance/database-safety";

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

/** Guards, recreates and migrates the isolated test database. */
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
}
