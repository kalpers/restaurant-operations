import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryTransactions, kitchenTickets, orderItemShares } from "@/db/schema";
import { readOrderDetail } from "@/modules/orders/queries/order-queries";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { voidItemShare } from "@/modules/orders/services/share-service";
import { splitOrderItem } from "@/workflows/split-order-item/split-order-item";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  newKey,
  orderRow,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

// Phase 20 policy 17 (D16): one sent item shared between checks on one table session.

const database = () => getDatabase();

describe("shared items (Phase 20)", () => {
  let scenario: OrderScenario;
  let burger: Burger;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  /** Two checks on one session; the first has a sent canonical burger. */
  async function twoChecks() {
    const session = await seatedSession(database(), scenario, { partySize: 2 });
    const first = await createOrder(database(), scenario.owner, { orderType: "DINE_IN", tableSessionId: session.id });
    const second = await createOrder(database(), scenario.owner, { orderType: "DINE_IN", tableSessionId: session.id });
    const added = await addDraftItem(database(), scenario.owner, first.id, {
      expectedVersion: first.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.canonicalSelections,
      specialInstructions: null,
    });

    await sendOrderItems(database(), scenario.owner, first.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    });

    return { first: await orderRow(database(), first.id), second: await orderRow(database(), second.id), itemId: added.itemId };
  }

  const counts = async () => ({
    ledger: (await database().select({ id: inventoryTransactions.id }).from(inventoryTransactions)).length,
    tickets: (await database().select({ id: kitchenTickets.id }).from(kitchenTickets)).length,
  });

  it("splits a sent item into equal shares across checks, with no new ledger rows or tickets", async () => {
    const { first, second, itemId } = await twoChecks();
    const before = await counts();
    const key = newKey();
    const input = {
      shareCount: 2,
      targets: [
        { orderId: first.id, expectedVersion: first.version },
        { orderId: second.id, expectedVersion: second.version },
      ],
      expectedVersion: first.version,
      idempotencyKey: key,
    };
    const result = await splitOrderItem(database(), scenario.owner, first.id, itemId, input);

    // 15.99 + 0.50 + 1.00 = 17.49: shares 8.75 and 8.74.
    expect(result.shares.map((share) => share.amount)).toEqual(["8.75", "8.74"]);
    expect((await itemRows(database(), first.id))[0]!.status).toBe("SPLIT");
    expect(await orderRow(database(), first.id)).toMatchObject({ itemSubtotal: "8.75", subtotal: "8.75" });
    expect(await orderRow(database(), second.id)).toMatchObject({ itemSubtotal: "8.74", subtotal: "8.74" });
    expect(await counts()).toEqual(before);

    // A retry with the same key returns the first outcome and writes nothing.
    const again = await splitOrderItem(database(), scenario.owner, first.id, itemId, input);

    expect(again.replayed).toBe(true);
    expect(await database().select().from(orderItemShares).where(eq(orderItemShares.orderItemId, itemId))).toHaveLength(2);

    const detail = await readOrderDetail(database(), scenario.owner, second.id);

    expect(detail.shares).toMatchObject([{ itemName: "Bacon Cheeseburger", shareNumber: 2, elsewhereOrderNumber: null }]);
  });

  it("can't void or re-split a SPLIT item, and voids a share for money only", async () => {
    const { first, second, itemId } = await twoChecks();
    const result = await splitOrderItem(database(), scenario.owner, first.id, itemId, {
      shareCount: 2,
      targets: [{ orderId: first.id, expectedVersion: first.version }, { newCheck: true }],
      expectedVersion: first.version,
      idempotencyKey: newKey(),
    });
    const current = await orderRow(database(), first.id);

    await expect(
      voidOrderItem(database(), scenario.owner, first.id, itemId, {
        reason: "Wrong",
        disposition: "UNPREPARED",
        expectedVersion: current.version,
      }),
    ).rejects.toMatchObject({ code: "ITEM_SPLIT" });
    await expect(
      splitOrderItem(database(), scenario.owner, first.id, itemId, {
        shareCount: 2,
        targets: [
          { orderId: first.id, expectedVersion: current.version },
          { orderId: second.id, expectedVersion: second.version },
        ],
        expectedVersion: current.version,
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "ITEM_NOT_SPLITTABLE" });

    const ledger = (await counts()).ledger;
    const [share] = await database()
      .select()
      .from(orderItemShares)
      .where(eq(orderItemShares.id, result.shares[0]!.shareId));

    await voidItemShare(database(), scenario.owner, first.id, share!.id, {
      reason: "Guest left early",
      expectedVersion: current.version,
      shareVersion: share!.version,
    });

    expect(await orderRow(database(), first.id)).toMatchObject({ itemSubtotal: "0.00" });
    expect((await counts()).ledger).toBe(ledger);
    await expect(
      database().execute(sql`DELETE FROM order_item_shares WHERE id = ${share!.id}`),
    ).rejects.toThrow();
  });

  it("refuses a share count that doesn't match the targets, and checks on other tables", async () => {
    const { first, itemId } = await twoChecks();
    const other = await seatedSession(database(), scenario);
    const elsewhere = await createOrder(database(), scenario.owner, { orderType: "DINE_IN", tableSessionId: other.id });

    await expect(
      splitOrderItem(database(), scenario.owner, first.id, itemId, {
        shareCount: 3,
        targets: [{ orderId: first.id, expectedVersion: first.version }, { newCheck: true }],
        expectedVersion: first.version,
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_SHARE_COUNT" });
    await expect(
      splitOrderItem(database(), scenario.owner, first.id, itemId, {
        shareCount: 2,
        targets: [
          { orderId: first.id, expectedVersion: first.version },
          { orderId: elsewhere.id, expectedVersion: elsewhere.version },
        ],
        expectedVersion: first.version,
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "DIFFERENT_SESSION" });
  });

  it("only lets an item become SPLIT alongside its share rows", async () => {
    const { itemId } = await twoChecks();

    await expect(
      database().execute(sql`UPDATE order_items SET status = 'SPLIT' WHERE id = ${itemId}`),
    ).rejects.toThrow();
  });
});
