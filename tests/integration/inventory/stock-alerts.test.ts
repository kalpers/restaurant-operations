import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryItemLocations, inventoryStockAlerts, notifications, outboxEvents } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { postInventoryTransaction } from "@/modules/inventory/services/posting-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import { post } from "../../fixtures/inventory-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  newKey,
  receive,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

// Phase 19 policies 11-13: one alert per crossing of the reorder level, opened and resolved
// by the posting itself, with in-app notifications to purchasing managers at the location.

const database = () => getDatabase();

describe("low-stock alerts (Phase 19)", () => {
  let scenario: OrderScenario;
  let burger: Burger;
  let buyer: Actor;
  let buyerAtB: Actor;
  let bystander: Actor;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    buyer = await actorWith(database(), scenario, ["purchasing.manage"]);
    buyerAtB = await actorWith(database(), scenario, ["purchasing.manage"], scenario.locationB);
    bystander = await actorWith(database(), scenario, ["inventory.view"]);
    // Beef: 100 oz on hand; reorder at 50 oz.
    await database()
      .update(inventoryItemLocations)
      .set({ reorderLevel: "50", reorderTarget: "100", parLevel: "100" })
      .where(
        and(
          eq(inventoryItemLocations.inventoryItemId, burger.stock.beef.id),
          eq(inventoryItemLocations.locationId, scenario.locationA),
        ),
      );
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  const waste = (quantity: string) =>
    post(database(), scenario.owner, {
      inventoryItemId: burger.stock.beef.id,
      type: "WASTE",
      quantity,
      unitOfMeasureId: scenario.units.ozWeight,
      reasonCode: "SPOILAGE",
    });

  const alerts = () =>
    database().select().from(inventoryStockAlerts).where(eq(inventoryStockAlerts.inventoryItemId, burger.stock.beef.id));

  const alertNotifications = async () => {
    const ids = (await alerts()).map((row) => row.id);

    return ids.length === 0
      ? []
      : (await database().select().from(notifications).where(eq(notifications.notificationType, "INVENTORY_LOW"))).filter(
          (row) => ids.includes(row.inventoryStockAlertId!),
        );
  };

  it("opens one alert when a SEND crosses the reorder level, and notifies purchasing managers here", async () => {
    await waste("44"); // 56 oz left: above 50.

    expect(await alerts()).toHaveLength(0);

    const session = await seatedSession(database(), scenario);
    const order = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.mediumOnly,
      specialInstructions: null,
    });

    await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    });

    const [alert] = await alerts();

    expect(alert).toMatchObject({ status: "OPEN", quantityWhenOpened: "48.0000", reorderLevelWhenOpened: "50.0000" });

    const recipients = (await alertNotifications()).map((row) => row.recipientUserId);

    expect(recipients).toContain(buyer.userId);
    expect(recipients).not.toContain(buyerAtB.userId);
    expect(recipients).not.toContain(bystander.userId);
    expect((await alertNotifications())[0]!.body).not.toMatch(/\$|cost/i);

    const events = await database()
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.eventType, "notification.created"), eq(outboxEvents.recipientUserId, buyer.userId)));

    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it("adds nothing for further postings while low, and resolves when stock rises above", async () => {
    await waste("50"); // 50 oz: at the level, so low.
    await waste("10");

    expect(await alerts()).toHaveLength(1);

    const before = (await alertNotifications()).length;

    await receive(database(), scenario.owner, burger.stock.beef.id, "5", scenario.units.ozWeight, "0.50"); // 45: still low

    expect((await alerts())[0]!.status).toBe("OPEN");

    const raised = await receive(database(), scenario.owner, burger.stock.beef.id, "10", scenario.units.ozWeight, "1.00"); // 55

    const [resolved] = await alerts();

    expect(resolved).toMatchObject({
      status: "RESOLVED",
      quantityWhenResolved: "55.0000",
      resolvedByTransactionId: raised.transactionId,
    });
    expect((await alertNotifications()).length).toBe(before);

    await waste("10"); // 45 again: a new crossing, a new alert.

    expect((await alerts()).map((row) => row.status).sort()).toEqual(["OPEN", "RESOLVED"]);
  });

  it("leaves no alert or notification when the posting rolls back", async () => {
    await expect(
      withTransaction(database(), async (transaction) => {
        await postInventoryTransaction(transaction, {
          organizationId: scenario.organizationId,
          locationId: scenario.locationA,
          inventoryItemId: burger.stock.beef.id,
          type: "WASTE",
          quantity: "60",
          unitOfMeasureId: scenario.units.ozWeight,
          reasonCode: "SPOILAGE",
          createdByUserId: scenario.owner.userId,
        });

        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");

    expect(await alerts()).toHaveLength(0);
  });

  it("never alerts an item with no reorder level", async () => {
    await post(database(), scenario.owner, {
      inventoryItemId: burger.stock.bun.id,
      type: "WASTE",
      quantity: "99",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "SPOILAGE",
    });

    expect(
      await database().select().from(inventoryStockAlerts).where(eq(inventoryStockAlerts.inventoryItemId, burger.stock.bun.id)),
    ).toHaveLength(0);
  });

  it("freezes an alert's facts and refuses deletes", async () => {
    await waste("60");

    const [alert] = await alerts();

    await expect(
      database().update(inventoryStockAlerts).set({ quantityWhenOpened: "1" }).where(eq(inventoryStockAlerts.id, alert!.id)),
    ).rejects.toThrow();
    await expect(database().delete(inventoryStockAlerts).where(eq(inventoryStockAlerts.id, alert!.id))).rejects.toThrow();
  });
});
