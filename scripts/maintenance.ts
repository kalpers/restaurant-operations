import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import { runMaintenance } from "../src/infrastructure/maintenance/run-maintenance";

/** `npm run maintenance`: one retention run. Prints counts only. */
async function main(): Promise<void> {
  loadLocalEnv();

  try {
    const result = await runMaintenance(getDatabase());

    console.log(
      result.skipped
        ? "Maintenance skipped: another run holds the maintenance lock."
        : `Maintenance complete: ${result.outboxEventsDeleted} published outbox events and ${result.loginThrottlesDeleted} expired sign-in throttles deleted.`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.name : "Maintenance failed.");
  process.exitCode = 1;
});
