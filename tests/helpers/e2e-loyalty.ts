import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { getDatabase } from "../../src/db";
import { guestLoyaltyPrograms, orders, settlements, tableSessions } from "../../src/db/schema";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { updateLoyaltyProgram } from "../../src/modules/reservations/services/loyalty-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { completeTableSession } from "../../src/workflows/end-table-session/end-table-session";
import { seatWalkIn } from "../../src/workflows/seat-guest-party/seat-guest-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import { GUESTS_SCOPE, type GuestsSetup } from "./e2e-guests";

// Phase 30 E2E: the steps around the screens under test. A visit linked to a profile with one
// sent item, and settling and ending it, run through the same services the screens call.

async function ownerAt(setup: GuestsSetup): Promise<Actor> {
  const context = await getUserAuthContext(getDatabase(), setup.owner.id);

  return requirePermission(context!, { permission: "orders.view", locationId: setup.locationId });
}

/** A walk-in linked to the profile, seated at a new table, with one item sent on its check. */
export async function linkedVisit(setup: GuestsSetup, profileId: string, menuItemId: string) {
  const database = getDatabase();
  const actor = await ownerAt(setup);
  const { id: tableId } = await createTable(database, actor, {
    restaurantAreaId: setup.areaId,
    tableNumber: `${GUESTS_SCOPE.tablePrefix}${randomUUID().slice(0, 6)}`,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });
  const seated = await seatWalkIn(database, actor, {
    guestName: `Loyalty E2E ${setup.suffix}`,
    partySize: 2,
    tableIds: [tableId],
    guestProfileId: profileId,
  });
  const order = await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: seated.id });
  const added = await addDraftItem(database, actor, order.id, {
    expectedVersion: order.version,
    menuItemId,
    quantity: 1,
    selections: [],
    specialInstructions: null,
  });

  await sendOrderItems(database, actor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: randomUUID() });

  return { orderId: order.id, sessionId: seated.id };
}

/** Settles the check in cash (or with nothing, when fully comped) and closes it. */
export async function settleCheck(setup: GuestsSetup, orderId: string) {
  const database = getDatabase();
  const actor = await ownerAt(setup);
  const { settlementId, orderAmountSnapshot } = await openSettlement(database, actor, orderId);

  const versionOf = async () =>
    (await database.select({ version: settlements.version }).from(settlements).where(eq(settlements.id, settlementId)))[0]!
      .version;

  if (orderAmountSnapshot !== "0.00") {
    await recordTender(database, actor, settlementId, {
      expectedVersion: await versionOf(),
      idempotencyKey: randomUUID(),
      tenderType: "CASH",
      outcome: "RECORDED",
      amount: orderAmountSnapshot,
      tipAmount: null,
      receivedAmount: orderAmountSnapshot,
      externalReference: null,
      providerName: null,
      cardBrand: null,
      cardLastFour: null,
      authorizationReference: null,
      otherDescription: null,
      failureReason: null,
      cashDrawerSessionId: null,
    });
  }

  await completeSettlement(database, actor, settlementId, { expectedVersion: await versionOf(), idempotencyKey: randomUUID() });
}

/** The guests leave: the session ends, which posts the visit's points. */
export async function endVisit(setup: GuestsSetup, sessionId: string) {
  const database = getDatabase();
  const actor = await ownerAt(setup);
  const [session] = await database.select({ version: tableSessions.version }).from(tableSessions).where(eq(tableSessions.id, sessionId));

  await completeTableSession(database, actor, sessionId, { expectedVersion: session!.version });
}

export async function orderSubtotal(orderId: string): Promise<string> {
  const [row] = await getDatabase().select({ subtotal: orders.subtotal }).from(orders).where(eq(orders.id, orderId));

  return row!.subtotal;
}

/** Leaves the organization's program off again, so later specs see no loyalty panels. */
export async function turnLoyaltyOff(setup: GuestsSetup): Promise<void> {
  const database = getDatabase();
  const actor = await ownerAt(setup);
  const [program] = await database
    .select()
    .from(guestLoyaltyPrograms)
    .where(eq(guestLoyaltyPrograms.organizationId, actor.organizationId));

  if (program?.enabled) {
    await updateLoyaltyProgram(database, actor, {
      enabled: false,
      pointsPerDollar: program.pointsPerDollar,
      pointsPerVisit: program.pointsPerVisit,
      expectedVersion: program.version,
    });
  }
}
