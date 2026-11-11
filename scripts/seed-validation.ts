import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import { VALIDATION_LABOR_SEED_KEY, VALIDATION_SEED_KEY } from "../src/db/demo/validation-fixture";

import { assertLocalDevelopment, mainOwnerActor } from "./local-seed-guard";
import { seedValidationFixture } from "./validation-fixture";
import { seedValidationLaborTips } from "./validation-labor";

/**
 * `npm run db:seed:validation`: the opt-in Phase 13 validation fixture, for a local
 * development database only. Needs `db:migrate`, `db:seed` and `bootstrap:owner` first.
 * See docs/Phase-13-Validation-Seed-Data.md.
 */
async function main(): Promise<void> {
  loadLocalEnv();
  assertLocalDevelopment("Validation data");

  try {
    const actor = await mainOwnerActor("employees.create");
    const result = await seedValidationFixture(getDatabase(), actor);

    if (result.skipped) {
      console.log(`Validation data: ${VALIDATION_SEED_KEY} already applied; nothing to do.`);
    } else {
      console.log(
        `Validation data: ${result.employees} employees added; schedule ${result.schedule ? "published" : "already present"}; ` +
          `dine-in visit ${result.dineIn ? "recorded" : "already present"}; takeout ${result.takeout ? "recorded" : "already present"}; ` +
          `upcoming reservation ${result.upcoming ? "created" : "already present"}. Recorded as ${VALIDATION_SEED_KEY}.`,
      );
    }

    // Phase 18, under its own key, so a database seeded before Phase 18 gets it too.
    const labor = await seedValidationLaborTips(getDatabase(), await mainOwnerActor("timeclock.manage"));

    if (labor.skipped) {
      console.log(`Labor and tips: ${VALIDATION_LABOR_SEED_KEY} already applied; nothing to do.`);
    } else {
      console.log(
        `Labor and tips: server time entry ${labor.entry ? "recorded" : "already present"}; tip pool ${labor.pool ? "created" : "already present"}; ` +
          `distribution ${labor.distribution}. Recorded as ${VALIDATION_LABOR_SEED_KEY}.`,
      );
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Validation seeding failed.");
  process.exitCode = 1;
});
