import { and, eq } from "drizzle-orm";

import type { Database } from "../src/db";
import { VALIDATION_SERVICE_POLISH_SEED_KEY } from "../src/db/demo/validation-fixture";
import { modifierOutages, modifiers, seedRuns } from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { markModifierOut } from "../src/modules/menu/services/outage-service";

export type ValidationServicePolishResult = { skipped: true } | { skipped: false; modifierOut: boolean };

const EXTRA_BACON = "EXTRA_BACON";

/**
 * Phase 20 additions to the validation fixture, through the services as the MAIN Owner: the
 * Extra Bacon modifier 86'd at MAIN, so the 86 board shows a modifier 86 and the order screen
 * leaves it out. Needs the demo kitchen (`db:seed:demo`). Recorded as
 * VALIDATION_SERVICE_POLISH_SEED_KEY once done.
 */
export async function seedValidationServicePolish(database: Database, actor: Actor): Promise<ValidationServicePolishResult> {
  const [done] = await database
    .select({ id: seedRuns.id })
    .from(seedRuns)
    .where(eq(seedRuns.seedKey, VALIDATION_SERVICE_POLISH_SEED_KEY));

  if (done) {
    return { skipped: true };
  }

  const [bacon] = await database
    .select({ id: modifiers.id })
    .from(modifiers)
    .where(and(eq(modifiers.organizationId, actor.organizationId), eq(modifiers.code, EXTRA_BACON)));

  if (!bacon) {
    throw new Error("The demo kitchen isn't seeded. Run `npm run db:seed:demo` first.");
  }

  const [active] = await database
    .select({ id: modifierOutages.id })
    .from(modifierOutages)
    .where(
      and(
        eq(modifierOutages.modifierId, bacon.id),
        eq(modifierOutages.locationId, actor.locationId),
        eq(modifierOutages.status, "ACTIVE"),
      ),
    );

  if (!active) {
    await markModifierOut(database, actor, { modifierId: bacon.id, reason: "Validation: out of bacon for the extra" });
  }

  await database.insert(seedRuns).values({ seedKey: VALIDATION_SERVICE_POLISH_SEED_KEY });

  return { skipped: false, modifierOut: !active };
}
