import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryItems, inventoryLotMovements, inventoryLots, inventoryTransactions, orderItemInventoryConsumption } from "@/db/schema";
import { reconcileBalances, reconcileLots } from "@/modules/inventory/queries/stock-queries";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import { enableLotTracking } from "@/modules/inventory/services/lot-service";
import { traceLot } from "@/modules/reporting/services/lot-trace-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { post } from "../../fixtures/inventory-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  newKey,
  onHand,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

// Phase 23 (policy 17): the canonical Bacon Cheeseburger with Swiss cheese tracked in lots.
// SEND takes the first lot to expire; the snapshot and the ledger movement are what they
// were without lots; a retry moves no lot; a void as never prepared returns the same lot.
describe("lots at SEND (Phase 23)", () => {
  let scenario: OrderScenario;
  let burger: Burger;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    const [swiss] = await database()
      .select({ version: inventoryItems.version })
      .from(inventoryItems)
      .where(eq(inventoryItems.id, burger.stock.swiss.id));

    // 100 on hand become the opening lot; 3 more arrive expiring sooner.
    await enableLotTracking(database(), scenario.owner, burger.stock.swiss.id, swiss!.version);
    await post(database(), scenario.owner, {
      inventoryItemId: burger.stock.swiss.id,
      type: "RECEIVE",
      quantity: "3",
      unitOfMeasureId: scenario.units.each,
      incomingTotalCost: "0.30",
      lot: { expiresOn: "2026-12-01", supplierLotCode: "SWISS-7" },
    });
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  const swissLots = () =>
    database()
      .select()
      .from(inventoryLots)
      .where(eq(inventoryLots.inventoryItemId, burger.stock.swiss.id))
      .orderBy(asc(inventoryLots.sequenceNumber));

  it("takes the first lot to expire, once, and returns it on a void", async () => {
    const order = await createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT" });
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.canonicalSelections,
      specialInstructions: null,
    });
    const input = { expectedVersion: added.orderVersion, idempotencyKey: newKey() };
    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, input);
    const [item] = await itemRows(database(), order.id);

    // Unchanged by lots: one Swiss consumed, from the dated lot.
    const consumption = await database()
      .select()
      .from(orderItemInventoryConsumption)
      .where(and(eq(orderItemInventoryConsumption.orderItemId, item!.id), eq(orderItemInventoryConsumption.inventoryItemId, burger.stock.swiss.id)));
    expect(consumption.map((row) => row.baseQuantity)).toEqual(["1.0000"]);
    expect(await onHand(database(), burger.stock.swiss.id)).toBe("102.0000");

    const [opening, dated] = await swissLots();
    expect([opening!.quantityRemaining, dated!.quantityRemaining]).toEqual(["100.0000", "2.0000"]);

    const consumeRows = await database()
      .select({ id: inventoryTransactions.id })
      .from(inventoryTransactions)
      .where(and(eq(inventoryTransactions.inventoryItemId, burger.stock.swiss.id), eq(inventoryTransactions.transactionType, "CONSUME")));
    const movementCount = async () =>
      (
        await database()
          .select({ id: inventoryLotMovements.id })
          .from(inventoryLotMovements)
          .where(inArray(inventoryLotMovements.inventoryTransactionId, consumeRows.map((row) => row.id)))
      ).length;
    expect(await movementCount()).toBe(1);

    // A retry with the same key moves no lot.
    expect(await sendOrderItems(database(), scenario.serverActor, order.id, input)).toEqual({ ...sent, replayed: true });
    expect(await movementCount()).toBe(1);

    // Policy 23: the trace leads from the lot to the order that used it, with no guest data.
    const trace = await traceLot(database(), (await getUserAuthContext(database(), scenario.ownerUser.id))!, dated!.id);
    const used = trace.sections.find((section) => section.key === "orders")!.rows;
    expect(used).toEqual([expect.objectContaining({ item: "Bacon Cheeseburger", quantity: "1.0000" })]);
    expect(trace.sections.find((section) => section.key === "lots")!.rows[0]).toMatchObject({ supplierLotCode: "SWISS-7", expiresOn: "2026-12-01" });
    expect(JSON.stringify(trace)).not.toMatch(/guest|phone|email/i);

    await voidOrderItem(database(), scenario.manager, order.id, item!.id, {
      reason: "Guest changed mind",
      disposition: "UNPREPARED",
      expectedVersion: sent.orderVersion,
    });
    expect((await swissLots()).map((lot) => lot.quantityRemaining)).toEqual(["100.0000", "3.0000"]);

    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);
    expect(await reconcileLots(database(), scenario.organizationId)).toEqual([]);
  });
});
