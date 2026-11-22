import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { positions, locations } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { createGuestProfile } from "../../src/modules/reservations/services/guest-profile-service";
import { createPeriod, createShift } from "../../src/modules/scheduling/services/schedule-service";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import type { GuestsSetup } from "./e2e-guests";

// Phase 34 E2E (policies 11–14): a guest named in a takeout check, its item's instruction and
// a shift note, made through the same services the screens call, for an erase to find.

async function ownerAt(setup: GuestsSetup, permission: Parameters<typeof requirePermission>[1]["permission"]): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), setup.owner.id);

  return requirePermission(context!, { permission, locationId: setup.locationId });
}

export async function eraseGuestProfile(setup: GuestsSetup, displayName: string): Promise<string> {
  const profile = await createGuestProfile(getDatabase(), await ownerAt(setup, "guests.manage"), {
    displayName,
    phone: "(555) 246-8100",
    email: null,
    vip: false,
    vipReason: null,
    preferences: null,
    notes: null,
    otherDietaryNeeds: null,
  });

  return profile.id;
}

/** A sent takeout check named after the guest, its item's instruction naming them too. */
export async function takeoutNaming(setup: GuestsSetup, surname: string): Promise<string> {
  const database = getDatabase();
  const actor = await ownerAt(setup, "orders.view");
  const order = await createOrder(database, actor, { orderType: "TAKEOUT", customerName: `J. ${surname}` });
  const added = await addDraftItem(database, actor, order.id, {
    expectedVersion: order.version,
    menuItemId: setup.bread.id,
    quantity: 1,
    selections: [],
    specialInstructions: `${surname} is allergic to sesame`,
  });

  await sendOrderItems(database, actor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: randomUUID() });

  return order.id;
}

/** A draft week at the setup's (new) location with one shift whose note names the guest. */
export async function shiftNoteNaming(setup: GuestsSetup, surname: string): Promise<string> {
  const database = getDatabase();
  const actor = await ownerAt(setup, "schedule.edit");
  const [location] = await database.select({ organizationId: locations.organizationId }).from(locations).where(eq(locations.id, setup.locationId));
  const [position] = await database.select({ id: positions.id }).from(positions).where(eq(positions.organizationId, location!.organizationId)).limit(1);
  const period = await createPeriod(database, actor, { name: `Erase E2E ${setup.suffix}`, startDate: "2031-03-03", endDate: "2031-03-09" });
  const shift = await createShift(database, actor, period.id, {
    positionId: position!.id,
    restaurantAreaId: null,
    shiftDate: "2031-03-04",
    startTime: "17:00",
    endTime: "22:00",
    requiredEmployeeCount: 1,
    courseOrStationNote: null,
    notes: `${surname} anniversary, cake at 8`,
    priority: 0,
    expectedPeriodVersion: period.version,
  });

  return shift.id;
}
