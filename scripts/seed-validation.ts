import { loadLocalEnv } from "../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../src/db";
import {
  VALIDATION_LABOR_SEED_KEY,
  VALIDATION_MENU_STOCK_SEED_KEY,
  VALIDATION_GUESTS_ALLERGENS_SEED_KEY,
  VALIDATION_LOTS_SEED_KEY,
  VALIDATION_SEED_KEY,
  VALIDATION_SERVICE_POLISH_SEED_KEY,
} from "../src/db/demo/validation-fixture";

import { assertLocalDevelopment, mainOwnerActor } from "./local-seed-guard";
import { seedValidationFixture } from "./validation-fixture";
import { seedValidationGuestsAllergens } from "./validation-guests-allergens";
import { seedValidationLaborTips } from "./validation-labor";
import { seedValidationLots } from "./validation-lots";
import { seedValidationMenuStock } from "./validation-menu-stock";
import { seedValidationServicePolish } from "./validation-service-polish";

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

    // Phase 19, under its own key, so a database seeded before Phase 19 gets it too.
    const signals = await seedValidationMenuStock(getDatabase(), await mainOwnerActor("menu.availability.manage"));

    if (signals.skipped) {
      console.log(`Menu and stock signals: ${VALIDATION_MENU_STOCK_SEED_KEY} already applied; nothing to do.`);
    } else {
      console.log(
        `Menu and stock signals: Buffalo Wings ${signals.outage ? "86'd" : "already 86'd"}; pickle-chip alert ${signals.alert ? "opened" : "already open or no stock"}; ` +
          `${signals.drafts} suggested draft order(s). Recorded as ${VALIDATION_MENU_STOCK_SEED_KEY}.`,
      );
    }

    // Phase 20, under its own key, so a database seeded before Phase 20 gets it too.
    const polish = await seedValidationServicePolish(getDatabase(), await mainOwnerActor("menu.availability.manage"));

    console.log(
      polish.skipped
        ? `Service polish: ${VALIDATION_SERVICE_POLISH_SEED_KEY} already applied; nothing to do.`
        : `Service polish: Extra Bacon ${polish.modifierOut ? "86'd" : "already 86'd"}. Recorded as ${VALIDATION_SERVICE_POLISH_SEED_KEY}.`,
    );

    // Phase 21 (added in Phase 22), under its own key, so an earlier database gets it too.
    const guests = await seedValidationGuestsAllergens(getDatabase(), await mainOwnerActor("guests.manage"));

    console.log(
      guests.skipped
        ? `Guests and allergens: ${VALIDATION_GUESTS_ALLERGENS_SEED_KEY} already applied; nothing to do.`
        : `Guests and allergens: ${guests.ingredientsTagged} ingredients tagged, ${guests.declared} declared allergen(s), ${guests.profiles} guest profiles. Recorded as ${VALIDATION_GUESTS_ALLERGENS_SEED_KEY}.`,
    );

    // Phase 23, under its own key, so an earlier database gets it too.
    const lots = await seedValidationLots(getDatabase(), await mainOwnerActor("inventory.configure"));

    console.log(
      lots.skipped
        ? `Lots: ${VALIDATION_LOTS_SEED_KEY} already applied; nothing to do.`
        : `Lots: bacon ${lots.tracked ? "now" : "already"} tracked in lots, with a dated lot at MAIN. Recorded as ${VALIDATION_LOTS_SEED_KEY}.`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Validation seeding failed.");
  process.exitCode = 1;
});
