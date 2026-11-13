import { and, asc, eq, gt, isNotNull, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { inventoryBalances, inventoryItems, inventoryLots, locations, locationSettings, unitsOfMeasure } from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import { recordAudit } from "@/modules/auditing";
import type { Actor } from "@/modules/auth/types";
import { isPositiveDecimal } from "@/shared/decimal/decimal";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";
import { businessDateOf } from "@/shared/time/business-date-service";

import { expiryStatus, fefoOrder } from "../rules/lot-allocation";
import { assertPermission, canSeeCost } from "./access";
import { createLot } from "./lot-posting";
import { recordWaste } from "./stock-operations";

// Phase 23 (policies 20–22, D8, D13, D15): turning lot tracking on and off, correcting a lot's
// code or expiry, the lots list, and wasting a whole lot. Quantities change only through
// postings; the one exception is the opening lot, which holds the stock already on hand
// when tracking starts and so moves nothing.

/** Turns lot tracking on: an OPENING lot holds the stock on hand at every location. */
export async function enableLotTracking(
  database: Database,
  actor: Actor,
  inventoryItemId: string,
  expectedVersion: number,
  now = new Date(),
) {
  assertPermission(actor, "inventory.configure");

  return withTransaction(database, async (transaction) => {
    const [item] = await transaction
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, inventoryItemId), eq(inventoryItems.organizationId, actor.organizationId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("inventory item");
    }

    if (item.version !== expectedVersion) {
      throw new ConcurrencyError("inventory item", inventoryItemId);
    }

    if (item.lotTracked) {
      throw new BusinessRuleError("LOTS_ALREADY_TRACKED", "This item is already tracked in lots.");
    }

    // The balances, locked in a stable order, so no posting slips in while the lots open.
    const balances = await transaction
      .select()
      .from(inventoryBalances)
      .where(eq(inventoryBalances.inventoryItemId, inventoryItemId))
      .orderBy(asc(inventoryBalances.locationId))
      .for("update");
    let opened = 0;

    for (const balance of balances) {
      if (!isPositiveDecimal(balance.quantityOnHand)) {
        continue;
      }

      const [settings] = await transaction
        .select({ timeZone: locations.timezone, businessDayCutoff: locationSettings.businessDayCutoff })
        .from(locations)
        .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
        .where(eq(locations.id, balance.locationId));

      await createLot(transaction, {
        organizationId: actor.organizationId,
        locationId: balance.locationId,
        inventoryItemId,
        origin: "OPENING",
        quantity: balance.quantityOnHand,
        receivedOn: businessDateOf(now, settings!),
        expiresOn: null,
        supplierLotCode: null,
        unitCost: balance.weightedAverageCost,
      });
      opened += 1;
    }

    const [updated] = await transaction
      .update(inventoryItems)
      .set({ lotTracked: true, version: sql`${inventoryItems.version} + 1`, updatedAt: now })
      .where(eq(inventoryItems.id, inventoryItemId))
      .returning({ version: inventoryItems.version });

    await recordAudit(transaction, actor, {
      action: "inventory.lot-tracking-enabled",
      entityId: inventoryItemId,
      after: { itemCode: item.code, openingLots: opened },
    });

    return { version: updated!.version, openingLots: opened };
  });
}

/** Turns lot tracking off. Refused while any lot of the item still holds stock. */
export async function disableLotTracking(database: Database, actor: Actor, inventoryItemId: string, expectedVersion: number) {
  assertPermission(actor, "inventory.configure");

  return withTransaction(database, async (transaction) => {
    const [item] = await transaction
      .select()
      .from(inventoryItems)
      .where(and(eq(inventoryItems.id, inventoryItemId), eq(inventoryItems.organizationId, actor.organizationId)))
      .for("update");

    if (!item) {
      throw new NotFoundError("inventory item");
    }

    if (item.version !== expectedVersion) {
      throw new ConcurrencyError("inventory item", inventoryItemId);
    }

    const [stocked] = await transaction
      .select({ id: inventoryLots.id })
      .from(inventoryLots)
      .where(and(eq(inventoryLots.inventoryItemId, inventoryItemId), gt(inventoryLots.quantityRemaining, "0")))
      .limit(1);

    if (stocked) {
      throw new BusinessRuleError(
        "LOTS_HAVE_STOCK",
        "Lots of this item still hold stock. Use or waste them before turning lot tracking off.",
      );
    }

    const [updated] = await transaction
      .update(inventoryItems)
      .set({ lotTracked: false, version: sql`${inventoryItems.version} + 1`, updatedAt: new Date() })
      .where(eq(inventoryItems.id, inventoryItemId))
      .returning({ version: inventoryItems.version });

    await recordAudit(transaction, actor, {
      action: "inventory.lot-tracking-disabled",
      entityId: inventoryItemId,
      after: { itemCode: item.code },
    });

    return { version: updated!.version };
  });
}

/** Corrects a mistyped supplier code or expiry date, with a reason. Never a quantity. */
export async function correctLot(
  database: Database,
  actor: Actor,
  lotId: string,
  input: { supplierLotCode: string | null; expiresOn: string | null; reason: string; expectedVersion: number },
) {
  assertPermission(actor, "inventory.adjust");

  return withTransaction(database, async (transaction) => {
    const [lot] = await transaction
      .select()
      .from(inventoryLots)
      .where(and(eq(inventoryLots.id, lotId), eq(inventoryLots.locationId, actor.locationId)))
      .for("update");

    if (!lot) {
      throw new NotFoundError("lot");
    }

    if (lot.version !== input.expectedVersion) {
      throw new ConcurrencyError("lot", lotId);
    }

    const supplierLotCode = input.supplierLotCode?.trim() || null;
    const [updated] = await transaction
      .update(inventoryLots)
      .set({
        supplierLotCode,
        expiresOn: input.expiresOn,
        version: sql`${inventoryLots.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(inventoryLots.id, lotId))
      .returning({ version: inventoryLots.version });

    await recordAudit(transaction, actor, {
      action: "inventory.lot-corrected",
      entityId: lotId,
      before: { lotNumber: lot.lotNumber, supplierLotCode: lot.supplierLotCode, expiresOn: lot.expiresOn },
      after: { lotNumber: lot.lotNumber, supplierLotCode, expiresOn: input.expiresOn, reason: input.reason },
    });

    return { version: updated!.version };
  });
}

/** Lots with stock at the actor's location, first to expire first, with their status today. */
export async function listLots(database: Database, actor: Actor, options: { inventoryItemId?: string } = {}) {
  assertPermission(actor, "inventory.view");

  const [clock] = await database
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
      warningDays: locationSettings.lotExpiryWarningDays,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, actor.locationId));
  const today = businessDateOf(new Date(), { timeZone: clock!.timeZone, businessDayCutoff: clock!.businessDayCutoff });
  const rows = await database
    .select({
      id: inventoryLots.id,
      inventoryItemId: inventoryLots.inventoryItemId,
      itemName: inventoryItems.name,
      baseUnitId: inventoryItems.baseUnitId,
      baseUnitCode: unitsOfMeasure.code,
      lotNumber: inventoryLots.lotNumber,
      supplierLotCode: inventoryLots.supplierLotCode,
      expiresOn: inventoryLots.expiresOn,
      receivedOn: inventoryLots.receivedOn,
      origin: inventoryLots.origin,
      sequenceNumber: inventoryLots.sequenceNumber,
      quantityRemaining: inventoryLots.quantityRemaining,
      unitCost: inventoryLots.unitCost,
      version: inventoryLots.version,
    })
    .from(inventoryLots)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLots.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryItems.baseUnitId))
    .where(
      and(
        eq(inventoryLots.locationId, actor.locationId),
        gt(inventoryLots.quantityRemaining, "0"),
        options.inventoryItemId ? eq(inventoryLots.inventoryItemId, options.inventoryItemId) : undefined,
      ),
    );
  const showCost = canSeeCost(actor);

  return {
    businessDate: today,
    warningDays: clock!.warningDays,
    lots: fefoOrder(rows).map(({ unitCost, ...row }) => ({
      ...row,
      unitCost: showCost ? unitCost : null,
      status: expiryStatus(row.expiresOn, today, clock!.warningDays),
    })),
  };
}

/** Policy 22: throws out everything left in one lot, as waste with reason EXPIRED (or another). */
export async function wasteLot(
  database: Database,
  actor: Actor,
  lotId: string,
  input: { reasonCode?: "EXPIRED" | "SPOILAGE" | "OTHER"; notes: string | null },
) {
  assertPermission(actor, "inventory.waste");

  const [lot] = await database
    .select({
      id: inventoryLots.id,
      inventoryItemId: inventoryLots.inventoryItemId,
      quantityRemaining: inventoryLots.quantityRemaining,
      baseUnitId: inventoryItems.baseUnitId,
      lotNumber: inventoryLots.lotNumber,
    })
    .from(inventoryLots)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLots.inventoryItemId))
    .where(and(eq(inventoryLots.id, lotId), eq(inventoryLots.locationId, actor.locationId)));

  if (!lot) {
    throw new NotFoundError("lot");
  }

  if (!isPositiveDecimal(lot.quantityRemaining)) {
    throw new BusinessRuleError("LOT_EMPTY", "That lot is already empty.");
  }

  return recordWaste(database, actor, {
    inventoryItemId: lot.inventoryItemId,
    lotId: lot.id,
    quantity: lot.quantityRemaining,
    unitOfMeasureId: lot.baseUnitId,
    reasonCode: input.reasonCode ?? "EXPIRED",
    notes: input.notes ?? `Lot ${lot.lotNumber}`,
  });
}

/**
 * Phase 23 (policy 22): lots with stock left at a location that are expiring within the
 * location's warning window or have expired, on its current business date. Nothing when the
 * window is 0. For the hourly maintenance run, which writes LOT_EXPIRING notifications.
 */
export async function findLotsNeedingWarning(
  executor: DatabaseExecutor,
  input: { locationId: string; now: Date },
) {
  const [clock] = await executor
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
      warningDays: locationSettings.lotExpiryWarningDays,
      inventoryEnabled: locationSettings.inventoryEnabled,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, input.locationId));

  if (!clock || clock.warningDays === 0 || !clock.inventoryEnabled) {
    return [];
  }

  const today = businessDateOf(input.now, clock);
  const rows = await executor
    .select({
      id: inventoryLots.id,
      lotNumber: inventoryLots.lotNumber,
      expiresOn: inventoryLots.expiresOn,
      itemName: inventoryItems.name,
    })
    .from(inventoryLots)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLots.inventoryItemId))
    .where(
      and(
        eq(inventoryLots.locationId, input.locationId),
        gt(inventoryLots.quantityRemaining, "0"),
        isNotNull(inventoryLots.expiresOn),
      ),
    );

  return rows
    .map((row) => ({ ...row, expiresOn: row.expiresOn!, status: expiryStatus(row.expiresOn, today, clock.warningDays) }))
    .filter((row): row is typeof row & { status: "EXPIRING" | "EXPIRED" } => row.status !== "OK");
}
