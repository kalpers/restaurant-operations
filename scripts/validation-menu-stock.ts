import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import type { Database } from "../src/db";
import { VALIDATION_MENU_STOCK_SEED_KEY } from "../src/db/demo/validation-fixture";
import {
  inventoryBalances,
  inventoryItemLocations,
  inventoryItems,
  inventoryStockAlerts,
  menuItemOutages,
  menuItems,
  seedRuns,
  supplierItems,
  suppliers,
} from "../src/db/schema";
import type { Actor } from "../src/modules/auth/types";
import { setItemLocation } from "../src/modules/inventory/services/item-service";
import { recordWaste } from "../src/modules/inventory/services/stock-operations";
import { createSuggestedOrders } from "../src/modules/inventory/services/suggested-order-service";
import { markItemOut } from "../src/modules/menu/services/outage-service";
import { addDecimals, compareDecimals, subtractDecimals } from "../src/shared/decimal/decimal";

export type ValidationMenuStockResult =
  | { skipped: true }
  | { skipped: false; outage: boolean; alert: boolean; drafts: number };

const WINGS = "BUFFALO_WINGS";
const PICKLES = "PICKLE_CHIPS";

/**
 * Phase 19 additions to the validation fixture, through the services as the MAIN Owner: Buffalo
 * Wings 86'd at MAIN, a low-stock alert on pickle chips (a reorder level just under what's on
 * hand, a preferred DEMO_FOODS supplier item, and one chip recorded as waste to cross it), and
 * the suggested draft order that follows. Needs the demo kitchen (`db:seed:demo`). Recorded as
 * VALIDATION_MENU_STOCK_SEED_KEY once done.
 */
export async function seedValidationMenuStock(database: Database, actor: Actor): Promise<ValidationMenuStockResult> {
  const [done] = await database.select({ id: seedRuns.id }).from(seedRuns).where(eq(seedRuns.seedKey, VALIDATION_MENU_STOCK_SEED_KEY));

  if (done) {
    return { skipped: true };
  }

  // ---- Buffalo Wings 86'd at MAIN, unless they already are.
  const [wings] = await database
    .select({ id: menuItems.id })
    .from(menuItems)
    .where(and(eq(menuItems.organizationId, actor.organizationId), eq(menuItems.code, WINGS)));

  if (!wings) {
    throw new Error("The demo kitchen isn't seeded. Run `npm run db:seed:demo` first.");
  }

  const [active] = await database
    .select({ id: menuItemOutages.id })
    .from(menuItemOutages)
    .where(
      and(
        eq(menuItemOutages.menuItemId, wings.id),
        eq(menuItemOutages.locationId, actor.locationId),
        eq(menuItemOutages.status, "ACTIVE"),
      ),
    );
  let outage = false;

  if (!active) {
    await markItemOut(database, actor, { menuItemId: wings.id, reason: "Validation fixture: wings delivery missed" });
    outage = true;
  }

  // ---- A low-stock alert on pickle chips, unless one is open.
  const [pickles] = await database
    .select({ id: inventoryItems.id, baseUnitId: inventoryItems.baseUnitId })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, actor.organizationId), eq(inventoryItems.code, PICKLES)));

  if (!pickles) {
    throw new Error("The demo kitchen isn't seeded. Run `npm run db:seed:demo` first.");
  }

  const [open] = await database
    .select({ id: inventoryStockAlerts.id })
    .from(inventoryStockAlerts)
    .where(
      and(
        eq(inventoryStockAlerts.inventoryItemId, pickles.id),
        eq(inventoryStockAlerts.locationId, actor.locationId),
        eq(inventoryStockAlerts.status, "OPEN"),
      ),
    );
  let alert = false;

  if (!open) {
    const [config] = await database
      .select({ config: inventoryItemLocations, onHand: inventoryBalances.quantityOnHand })
      .from(inventoryItemLocations)
      .leftJoin(
        inventoryBalances,
        and(
          eq(inventoryBalances.inventoryItemId, inventoryItemLocations.inventoryItemId),
          eq(inventoryBalances.locationId, inventoryItemLocations.locationId),
        ),
      )
      .where(and(eq(inventoryItemLocations.inventoryItemId, pickles.id), eq(inventoryItemLocations.locationId, actor.locationId)));
    const onHand = config?.onHand ?? "0";

    if (config && compareDecimals(onHand, "1") >= 0) {
      const [preferred] = await database
        .select({ id: supplierItems.id })
        .from(supplierItems)
        .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
        .where(and(eq(supplierItems.inventoryItemId, pickles.id), eq(suppliers.code, "DEMO_FOODS"), eq(supplierItems.active, true)));
      const level = subtractDecimals(onHand, "1");
      const target = addDecimals(onHand, "200");

      await setItemLocation(database, actor, pickles.id, {
        parLevel: target,
        reorderLevel: level,
        reorderTarget: target,
        storageNote: config.config.storageNote,
        active: true,
        preferredSupplierItemId: preferred?.id ?? null,
        expectedVersion: config.config.version,
      });
      await recordWaste(database, actor, {
        inventoryItemId: pickles.id,
        quantity: "1",
        unitOfMeasureId: pickles.baseUnitId,
        reasonCode: "OTHER",
        notes: "Phase 19 validation fixture: one chip, to cross the reorder level",
      });
      alert = true;
    }
  }

  // ---- The suggested draft order that follows.
  const created = await createSuggestedOrders(database, actor, { idempotencyKey: `validation-${randomUUID()}` });

  await database.insert(seedRuns).values({ seedKey: VALIDATION_MENU_STOCK_SEED_KEY }).onConflictDoNothing({ target: seedRuns.seedKey });

  return { skipped: false, outage, alert, drafts: created.purchaseOrders.length };
}
