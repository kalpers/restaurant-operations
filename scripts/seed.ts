import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import { seeds } from "../src/db/seeds/registry";
import { runSeeds } from "../src/db/seeds/run-seeds";

async function main(): Promise<void> {
  loadLocalEnv();

  try {
    const result = await runSeeds(getDatabase(), seeds);
    console.log(
      `Seeds complete: ${result.applied.length} applied, ${result.skipped.length} already applied.`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Seeding failed.");
  process.exitCode = 1;
});
