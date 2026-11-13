import { and, eq, inArray, isNotNull, like } from "drizzle-orm";

import type { Database } from "../src/db";
import { employeeLocations, employees, inventoryItems, inventoryLots, inventoryTransfers, locations } from "../src/db/schema";
import { getUserAuthContext, requirePermission } from "../src/modules/auth/services/permission-service";
import type { Actor } from "../src/modules/auth/types";
import { assignLocation } from "../src/modules/employees/services/assignment-service";
import { enableLotTracking } from "../src/modules/inventory/services/lot-service";
import { recordAdjustment } from "../src/modules/inventory/services/stock-operations";
import { transferNow } from "../src/modules/inventory/services/transfer-service";
import { COPY_GROUPS, openLocation } from "../src/workflows/open-location/open-location";

// Phase 23 (D17): the opt-in demo gains a second location, UPTOWN, opened from MAIN with every
// setup group copied; two demo employees who also work there; Swiss and American cheese
// tracked in lots with dated lots at MAIN; and one received transfer of Swiss to UPTOWN. All
// through the services a manager would use. Each step skips what already exists.

const UPTOWN = "UPTOWN";
const LOT_ITEMS = ["SWISS_CHEESE", "AMERICAN_CHEESE"] as const;
const UPTOWN_STAFF = ["DEMO-001", "DEMO-002"] as const;

const isoDate = (days: number) => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);

  return date.toISOString().slice(0, 10);
};

async function actorAt(database: Database, owner: Actor, locationId: string, permission: Parameters<typeof requirePermission>[1]["permission"]) {
  const context = await getUserAuthContext(database, owner.userId);

  return requirePermission(context!, { permission, locationId });
}

export async function seedDemoLocationsAndLots(database: Database, owner: Actor) {
  const result = { locationOpened: false, staffAdded: 0, lotItems: 0, lots: 0, transfers: 0 };
  let [uptown] = await database
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.organizationId, owner.organizationId), eq(locations.locationCode, UPTOWN)));

  if (!uptown) {
    const opened = await openLocation(database, owner, {
      name: "Uptown",
      locationCode: UPTOWN,
      timezone: "America/Detroit",
      addressLine1: null,
      addressLine2: null,
      city: null,
      state: null,
      postalCode: null,
      country: "US",
      phone: null,
      email: null,
      copyFrom: { locationId: owner.locationId, groups: COPY_GROUPS },
    });

    uptown = { id: opened.locationId };
    result.locationOpened = true;
  }

  // Two demo employees also work at Uptown (work locations, not software access).
  const staff = await database
    .select({ id: employees.id, hireDate: employees.hireDate, version: employees.version })
    .from(employees)
    .where(inArray(employees.employeeNumber, [...UPTOWN_STAFF]));
  const already = new Set(
    (
      await database
        .select({ employeeId: employeeLocations.employeeId })
        .from(employeeLocations)
        .where(and(eq(employeeLocations.locationId, uptown.id), eq(employeeLocations.active, true)))
    ).map((row) => row.employeeId),
  );
  const atUptown = await actorAt(database, owner, uptown.id, "employees.locations.manage");
  const atMain = await actorAt(database, owner, owner.locationId, "employees.locations.manage");

  for (const employee of staff.filter((entry) => !already.has(entry.id))) {
    await assignLocation(database, atMain, atUptown, {
      employeeId: employee.id,
      effectiveFrom: employee.hireDate,
      expectedVersion: employee.version,
    });
    result.staffAdded += 1;
  }

  // Lot tracking for the cheeses, with a dated lot each at MAIN.
  const configure = await actorAt(database, owner, owner.locationId, "inventory.configure");
  const adjust = await actorAt(database, owner, owner.locationId, "inventory.adjust");
  const cheeses = await database
    .select({ id: inventoryItems.id, code: inventoryItems.code, baseUnitId: inventoryItems.baseUnitId, lotTracked: inventoryItems.lotTracked, version: inventoryItems.version })
    .from(inventoryItems)
    .where(and(eq(inventoryItems.organizationId, owner.organizationId), inArray(inventoryItems.code, [...LOT_ITEMS])));

  for (const [index, cheese] of cheeses.entries()) {
    if (!cheese.lotTracked) {
      await enableLotTracking(database, configure, cheese.id, cheese.version);
      result.lotItems += 1;
    }

    const [dated] = await database
      .select({ id: inventoryLots.id })
      .from(inventoryLots)
      .where(and(eq(inventoryLots.inventoryItemId, cheese.id), isNotNull(inventoryLots.expiresOn)))
      .limit(1);

    if (!dated) {
      await recordAdjustment(database, adjust, {
        inventoryItemId: cheese.id,
        quantity: "24",
        unitOfMeasureId: cheese.baseUnitId,
        direction: "INCREASE",
        reasonCode: "FOUND_STOCK",
        expiresOn: isoDate(index === 0 ? 2 : 10),
        notes: "Demo lot",
      });
      result.lots += 1;
    }
  }

  // One received transfer of Swiss from MAIN to Uptown.
  const swiss = cheeses.find((cheese) => cheese.code === "SWISS_CHEESE");
  const [sent] = await database
    .select({ id: inventoryTransfers.id })
    .from(inventoryTransfers)
    .where(
      and(
        eq(inventoryTransfers.fromLocationId, owner.locationId),
        eq(inventoryTransfers.toLocationId, uptown.id),
        like(inventoryTransfers.notes, "Demo transfer%"),
      ),
    )
    .limit(1);

  if (swiss && !sent) {
    await transferNow(database, await actorAt(database, owner, owner.locationId, "inventory.transfer"), {
      toLocationId: uptown.id,
      notes: "Demo transfer",
      lines: [{ inventoryItemId: swiss.id, quantity: "6", unitOfMeasureId: swiss.baseUnitId }],
    });
    result.transfers += 1;
  }

  return result;
}
