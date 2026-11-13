import { and, eq } from "drizzle-orm";

import type { Database } from "../src/db";
import { VALIDATION_LOTS_SEED_KEY } from "../src/db/demo/validation-fixture";
import { inventoryItems, seedRuns } from "../src/db/schema";
import { getUserAuthContext, requirePermission } from "../src/modules/auth/services/permission-service";
import type { Actor } from "../src/modules/auth/types";
import { enableLotTracking } from "../src/modules/inventory/services/lot-service";
import { recordAdjustment } from "../src/modules/inventory/services/stock-operations";

export type ValidationLotsResult = { skipped: true } | { skipped: false; tracked: boolean };

const BACON = "BACON";

/**
 * Phase 23 additions to the validation fixture, through the services as the MAIN Owner: bacon
 * tracked in lots, with a dated lot found at MAIN that expires in three days, so the lots page,
 * the expiry warning and the lot trace have something to show. A transfer needs a second
 * location, which the validation fixture doesn't have; the demo data has one. Needs the demo
 * kitchen (`db:seed:demo`). Recorded as VALIDATION_LOTS_SEED_KEY once done.
 */
export async function seedValidationLots(database: Database, owner: Actor): Promise<ValidationLotsResult> {
  const [done] = await database.select({ id: seedRuns.id }).from(seedRuns).where(eq(seedRuns.seedKey, VALIDATION_LOTS_SEED_KEY));

  if (done) {
    return { skipped: true };
  }

  const [bacon] = await database
    .select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId, lotTracked: inventoryItems.lotTracked, version: inventoryItems.version })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, owner.organizationId), eq(inventoryItems.code, BACON)));

  if (!bacon) {
    throw new Error("The demo kitchen isn't seeded. Run `npm run db:seed:demo` first.");
  }

  const context = await getUserAuthContext(database, owner.userId);
  const at = (permission: "inventory.configure" | "inventory.adjust") =>
    requirePermission(context!, { permission, locationId: owner.locationId });

  if (!bacon.lotTracked) {
    await enableLotTracking(database, at("inventory.configure"), bacon.id, bacon.version);
  }

  const expires = new Date();
  expires.setUTCDate(expires.getUTCDate() + 3);

  await recordAdjustment(database, at("inventory.adjust"), {
    inventoryItemId: bacon.id,
    quantity: "10",
    unitOfMeasureId: bacon.baseUnitId,
    direction: "INCREASE",
    reasonCode: "FOUND_STOCK",
    expiresOn: expires.toISOString().slice(0, 10),
    notes: "Validation lot",
  });
  await database.insert(seedRuns).values({ seedKey: VALIDATION_LOTS_SEED_KEY });

  return { skipped: false, tracked: !bacon.lotTracked };
}
