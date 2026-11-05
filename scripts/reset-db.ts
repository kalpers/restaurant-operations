import { getEnv } from "../src/config/env";
import { loadLocalEnv, readExplicitNodeEnv } from "../src/config/tooling-env";
import { assertResetAllowed } from "../src/db/maintenance/database-safety";
import { rebuildFromMigrations } from "../src/db/maintenance/apply-migrations";

async function main(): Promise<void> {
  loadLocalEnv();

  const { DATABASE_URL: databaseUrl } = getEnv();
  assertResetAllowed({ nodeEnv: readExplicitNodeEnv(), databaseUrl });

  await rebuildFromMigrations(databaseUrl);
  console.log("Database reset and rebuilt from checked-in migrations.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database reset failed.");
  process.exitCode = 1;
});
