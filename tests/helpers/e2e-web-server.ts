import { spawn } from "node:child_process";

import { requireTestDatabaseUrl } from "../../src/config/tooling-env";
import { prepareTestDatabase } from "./prepare-test-database";

/**
 * Playwright's web server command. Playwright starts the web server before it runs
 * `globalSetup`, so preparing the test database there let the server's outbox
 * processor query tables that didn't exist yet (42P01). Here the database is
 * recreated, migrated and seeded first, and only then is the app started on it.
 *
 * The guard in `prepareTestDatabase` compares DATABASE_URL (development) with
 * TEST_DATABASE_URL, so DATABASE_URL is switched to the test database only for the
 * child process.
 */
async function main(): Promise<void> {
  const mode = process.argv[2] === "start" ? "start" : "dev";

  await prepareTestDatabase();

  const child = spawn(`npx next ${mode}`, {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, DATABASE_URL: requireTestDatabaseUrl() },
  });

  const stop = () => child.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "E2E web server failed.");
  process.exit(1);
});
