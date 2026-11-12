import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  idempotencyRecords,
  inventoryTransactions,
  kitchenTicketItems,
  orderItemAllergens,
  orderItems,
  orderSendBatches,
  waitlistEntries,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { loadOrderAllergenView } from "@/modules/orders/queries/order-allergens";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { recordOrderAllergy } from "@/modules/orders/services/order-allergy-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { setIngredientAllergens } from "@/modules/recipes/services/allergen-service";
import { createGuestProfile } from "@/modules/reservations/services/guest-profile-service";
import { addToWaitlist } from "@/modules/reservations/services/waitlist-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { seatParty } from "@/workflows/seat-party/seat-party";

import { allergenList, tagBurger, type AllergenList } from "../../fixtures/allergen-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  newKey,
  orderRow,
  plainItem,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";
import { tableFixture } from "../../fixtures/restaurant-fixtures";

// Phase 21 policies 12-14: the allergy warning at SEND, the acknowledgment, and the frozen
// allergen snapshot and ticket alert.

const database = () => getDatabase();

describe("allergy warning at SEND (Phase 21)", () => {
  let scenario: OrderScenario;
  let burger: Burger;
  let list: AllergenList;
  let server: Actor;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    list = await allergenList(database(), scenario.owner);
    await tagBurger(database(), scenario.owner, burger, list);
    server = scenario.serverActor;
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  /** A walk-in party linked to a profile with a milk allergy, seated, with an open check. */
  async function milkAllergicTable() {
    const profile = await createGuestProfile(database(), scenario.owner, {
      displayName: "Ana Guest",
      phone: null,
      email: null,
      vip: false,
      vipReason: null,
      preferences: null,
      notes: null,
      otherDietaryNeeds: null,
      allergies: [{ allergenId: list.MILK.id, severity: "SEVERE", note: null }],
    });
    const entry = await addToWaitlist(database(), scenario.owner, {
      guestName: "Ana Guest",
      partySize: 2,
      guestProfileId: profile.id,
    });
    const [row] = await database().select().from(waitlistEntries).where(eq(waitlistEntries.id, entry.id));
    const tableId = await tableFixture(database(), scenario, { areaId: scenario.dining });
    const session = await seatParty(database(), scenario.owner, {
      tableIds: [tableId],
      partySize: 2,
      serverEmployeeId: null,
      guestPartyId: row!.guestPartyId,
    });
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: session.id });

    return { profile, order, guestPartyId: row!.guestPartyId };
  }

  async function addBurger(order: { id: string; version: number }) {
    return addDraftItem(database(), server, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.canonicalSelections,
      specialInstructions: null,
    });
  }

  const count = async (table: typeof orderSendBatches | typeof idempotencyRecords | typeof inventoryTransactions) =>
    Number((await database().select({ n: sql<number>`count(*)` }).from(table))[0]!.n);

  it("sends with no allergies recorded and snapshots the label", async () => {
    const session = await seatedSession(database(), scenario);
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: session.id });
    const added = await addBurger(order);

    await sendOrderItems(database(), server, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });

    const [item] = await database().select().from(orderItems).where(eq(orderItems.id, added.itemId));
    const snapshot = await database().select().from(orderItemAllergens).where(eq(orderItemAllergens.orderItemId, added.itemId));

    // Canonical burger: Swiss instead of American still has milk; the bun has wheat and sesame.
    expect(snapshot.map((row) => `${row.allergenCodeSnapshot}:${row.kind}:${row.source}`).sort()).toEqual([
      "MILK:CONTAINS:DERIVED",
      "SESAME:CONTAINS:DERIVED",
      "WHEAT:CONTAINS:DERIVED",
    ]);
    expect(item).toMatchObject({
      allergenLabelIncompleteSnapshot: false,
      allergyAcknowledgedAt: null,
      allergyConflictSnapshot: null,
    });
  });

  it("refuses an unacknowledged conflict with nothing written, then sends once when acknowledged", async () => {
    const { order } = await milkAllergicTable();
    const added = await addBurger(order);
    const key = newKey();
    const before = {
      batches: await count(orderSendBatches),
      keys: await count(idempotencyRecords),
      ledger: await count(inventoryTransactions),
    };

    await expect(
      sendOrderItems(database(), server, order.id, { expectedVersion: added.orderVersion, idempotencyKey: key }),
    ).rejects.toMatchObject({
      code: "ALLERGEN_ACKNOWLEDGMENT_REQUIRED",
      details: { items: [expect.objectContaining({ orderItemId: added.itemId, allergens: ["MILK"], severity: "SEVERE" })] },
    });
    expect({
      batches: await count(orderSendBatches),
      keys: await count(idempotencyRecords),
      ledger: await count(inventoryTransactions),
    }).toEqual(before);

    const view = await loadOrderAllergenView(database(), scenario.organizationId, await orderRow(database(), order.id), [
      { id: added.itemId, status: "DRAFT", menuItemId: burger.menuItem.id, allergenLabelIncompleteSnapshot: null, allergyAcknowledgedAt: null, allergyConflictSnapshot: null },
    ]);

    expect(view.allergies).toMatchObject({ source: "PARTY", allergies: [expect.objectContaining({ code: "MILK" })] });
    expect(view.items.get(added.itemId)!.conflict).toMatchObject({ description: "ALLERGY: Milk (severe)" });

    const send = () =>
      sendOrderItems(database(), server, order.id, {
        expectedVersion: added.orderVersion,
        idempotencyKey: key,
        acknowledgedAllergenItemIds: [added.itemId],
      });
    const first = await send();
    const again = await send();

    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({ replayed: true, batchId: first.batchId });

    const [item] = await database().select().from(orderItems).where(eq(orderItems.id, added.itemId));

    expect(item).toMatchObject({
      allergyAcknowledgedByUserId: server.userId,
      allergyConflictSnapshot: "ALLERGY: Milk (severe)",
    });

    const tickets = await database().select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderItemId, added.itemId));

    expect(tickets.map((ticket) => ticket.allergyAlertSnapshot)).toEqual(["ALLERGY: Milk (severe)"]);
    expect(
      await database().select().from(orderItemAllergens).where(eq(orderItemAllergens.orderItemId, added.itemId)),
    ).toHaveLength(3);

    const audit = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "orders.allergen-acknowledged"), eq(auditEvents.entityId, order.id)));

    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ allergenCodes: ["MILK"], severity: "SEVERE", incompleteLabel: false });
  });

  it("keeps the sent snapshot when the ingredient tags change later, and refuses edits to it", async () => {
    const session = await seatedSession(database(), scenario);
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: session.id });
    const added = await addBurger(order);

    await sendOrderItems(database(), server, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });
    await setIngredientAllergens(database(), scenario.owner, {
      inventoryItemId: burger.stock.swiss.id,
      allergenIds: [],
      expectedReviewVersion: 1,
    });

    const codes = async () =>
      (await database().select().from(orderItemAllergens).where(eq(orderItemAllergens.orderItemId, added.itemId)))
        .map((row) => row.allergenCodeSnapshot)
        .sort();

    expect(await codes()).toEqual(["MILK", "SESAME", "WHEAT"]);
    await expect(
      database().execute(sql`UPDATE order_item_allergens SET allergen_name_snapshot = 'x' WHERE order_item_id = ${added.itemId}`),
    ).rejects.toThrow();
    await expect(
      database().execute(sql`UPDATE order_items SET allergy_conflict_snapshot = 'x' WHERE id = ${added.itemId}`),
    ).rejects.toThrow();
  });

  it("checks a takeout check's own allergies, and treats an unreviewed item as a possible conflict", async () => {
    const soup = await plainItem(database(), scenario.owner, "6.00", "Soup of the day");
    const order = await createOrder(database(), server, { orderType: "TAKEOUT", customerName: "Pickup" });
    const allergy = await recordOrderAllergy(database(), server, {
      orderId: order.id,
      expectedVersion: order.version,
      allergenId: list.PEANUTS.id,
      severity: "ALLERGY",
      note: null,
    });
    const added = await addDraftItem(database(), server, order.id, {
      expectedVersion: allergy.orderVersion,
      menuItemId: soup.id,
      quantity: 1,
      selections: [],
      specialInstructions: null,
    });

    await expect(
      sendOrderItems(database(), server, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() }),
    ).rejects.toMatchObject({
      code: "ALLERGEN_ACKNOWLEDGMENT_REQUIRED",
      details: { items: [expect.objectContaining({ incompleteLabel: true, allergens: [] })] },
    });

    await sendOrderItems(database(), server, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
      acknowledgedAllergenItemIds: [added.itemId],
    });

    const [item] = await database().select().from(orderItems).where(eq(orderItems.id, added.itemId));

    expect(item).toMatchObject({
      allergenLabelIncompleteSnapshot: true,
      allergyConflictSnapshot: "ALLERGY: check for Peanuts; allergens not fully reviewed",
    });
  });

  it("refuses check allergies on a check that belongs to a party", async () => {
    const { order } = await milkAllergicTable();

    await expect(
      recordOrderAllergy(database(), server, {
        orderId: order.id,
        expectedVersion: order.version,
        allergenId: list.PEANUTS.id,
        severity: "ALLERGY",
        note: null,
      }),
    ).rejects.toMatchObject({ code: "ORDER_HAS_PARTY" });
  });
});
