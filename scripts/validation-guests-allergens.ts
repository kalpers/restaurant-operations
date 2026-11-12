import { eq } from "drizzle-orm";

import type { Database } from "../src/db";
import { VALIDATION_GUESTS_ALLERGENS_SEED_KEY } from "../src/db/demo/validation-fixture";
import { seedRuns } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";

import { seedDeclaredAllergens, seedGuestProfiles, seedIngredientAllergens, type DemoProfile } from "./demo-guests-allergens";

export type ValidationGuestsAllergensResult =
  | { skipped: true }
  | { skipped: false; ingredientsTagged: number; declared: number; profiles: number };

/** Phase 21 validation guests (Phase 22 policy 24): a severe peanut VIP, a milk allergy, a merged duplicate. */
export const VALIDATION_PROFILES: readonly DemoProfile[] = [
  {
    displayName: "Phase 21 Validation Peanut",
    vip: true,
    vipReason: "Regular",
    preferences: "Booth",
    allergies: [{ allergen: "PEANUTS", severity: "SEVERE" }],
  },
  {
    displayName: "Phase 21 Validation Milk",
    vip: false,
    vipReason: null,
    preferences: null,
    allergies: [{ allergen: "MILK", severity: "ALLERGY" }],
  },
  {
    displayName: "Phase 21 Validation Milk (duplicate)",
    vip: false,
    vipReason: null,
    preferences: null,
    allergies: [{ allergen: "MILK", severity: "SEVERE" }],
    mergeInto: "Phase 21 Validation Milk",
  },
];

/**
 * Phase 21 additions to the validation fixture, through the services as the MAIN Owner: the
 * demo ingredients tagged and reviewed, French Fries declared MAY_CONTAIN wheat, and three
 * profiles, one merged into another. Needs the demo kitchen (`db:seed:demo`). Recorded as
 * VALIDATION_GUESTS_ALLERGENS_SEED_KEY once done.
 */
export async function seedValidationGuestsAllergens(database: Database, actor: Actor): Promise<ValidationGuestsAllergensResult> {
  const [done] = await database
    .select({ id: seedRuns.id })
    .from(seedRuns)
    .where(eq(seedRuns.seedKey, VALIDATION_GUESTS_ALLERGENS_SEED_KEY));

  if (done) {
    return { skipped: true };
  }

  const ingredientsTagged = await seedIngredientAllergens(database, actor);
  const declared = await seedDeclaredAllergens(database, actor);
  const profiles = await seedGuestProfiles(database, actor, VALIDATION_PROFILES);

  await database.insert(seedRuns).values({ seedKey: VALIDATION_GUESTS_ALLERGENS_SEED_KEY });

  return { skipped: false, ingredientsTagged, declared, profiles };
}
