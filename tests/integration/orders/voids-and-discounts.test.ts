import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  inventoryItemLocations,
  inventoryTransactions,
  orderDiscounts,
  orderItemDiscounts,
  orderItemInventoryConsumption,
  orderItemStatusHistory,
  orderItemVoids,
  orderStatusHistory,
} from "@/db/schema";
import { reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import {
  applyItemDiscount,
  applyOrderDiscount,
  createDiscountDefinition,
  removeDiscount,
  updateDiscountDefinition,
} from "@/modules/orders/services/discount-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrder, voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  ledgerFor,
  newKey,
  onHand,
  orderRow,
  plainItem,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";

const database = () => getDatabase();

describe("order voids and discounts", () => {
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

  /** A takeout order with the given items sent in one batch. */
  async function sentOrder(lines: { menuItemId: string; quantity?: number; selections?: { modifierGroupId: string; modifierId: string }[] }[]) {
    const order = await createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT" });
    let version = order.version;

    for (const line of lines) {
      version = (
        await addDraftItem(database(), scenario.serverActor, order.id, {
          expectedVersion: version,
          menuItemId: line.menuItemId,
          quantity: line.quantity ?? 1,
          selections: line.selections ?? [],
          specialInstructions: null,
        })
      ).orderVersion;
    }

    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: version,
      idempotencyKey: newKey(),
    });

    return { orderId: order.id, version: sent.orderVersion, items: await itemRows(database(), order.id) };
  }

  const burgerLine = () => ({ menuItemId: burger.menuItem.id, selections: burger.canonicalSelections });

  describe("submitted item void", () => {
    it("UNPREPARED restores stock with linked SALE_REVERSAL rows and keeps the CONSUME", async () => {
      const soda = await plainItem(database(), scenario.owner);
      const { orderId, version, items } = await sentOrder([burgerLine(), { menuItemId: soda.id }]);
      const burgerItem = items.find((item) => item.menuItemId === burger.menuItem.id)!;

      expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
      expect((await orderRow(database(), orderId)).subtotal).toBe("20.49");

      await voidOrderItem(database(), scenario.manager, orderId, burgerItem.id, {
        reason: "Guest changed mind",
        disposition: "UNPREPARED",
        expectedVersion: version,
      });

      expect(await onHand(database(), burger.stock.beef.id)).toBe("100.0000");
      expect(await onHand(database(), burger.stock.pickles.id)).toBe("100.0000");

      const beefLedger = await ledgerFor(database(), burger.stock.beef.id);
      const consume = beefLedger.find((row) => row.transactionType === "CONSUME")!;
      const reversal = beefLedger.find((row) => row.transactionType === "SALE_REVERSAL")!;
      const [voidRow] = await database().select().from(orderItemVoids).where(eq(orderItemVoids.orderItemId, burgerItem.id));

      expect(consume.baseQuantityDelta).toBe("-8.0000");
      expect(reversal).toMatchObject({
        baseQuantityDelta: "8.0000",
        reversesTransactionId: consume.id,
        referenceType: "ORDER_ITEM_VOID",
        referenceId: voidRow!.id,
        unitCost: "0.1000",
        createdByUserId: scenario.manager.userId,
      });
      expect(reversal.averageCostAfter).toBe("0.1000");
      expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);

      const [after] = (await itemRows(database(), orderId)).filter((item) => item.id === burgerItem.id);

      expect(after).toMatchObject({ status: "VOIDED", voidReason: "Guest changed mind", lineTotalSnapshot: "17.49" });
      expect((await orderRow(database(), orderId)).subtotal).toBe("3.00");
      expect(
        (await database().select().from(orderItemStatusHistory).where(eq(orderItemStatusHistory.orderItemId, burgerItem.id))).map((row) => row.status),
      ).toEqual(["SUBMITTED", "VOIDED"]);
    });

    it("PREPARED_OR_DISCARDED keeps the consumption and posts no WASTE", async () => {
      const { orderId, version, items } = await sentOrder([burgerLine()]);

      await voidOrderItem(database(), scenario.manager, orderId, items[0]!.id, {
        reason: "Dropped on the floor",
        disposition: "PREPARED_OR_DISCARDED",
        expectedVersion: version,
      });

      expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
      expect(
        (await ledgerFor(database(), burger.stock.beef.id)).map((row) => row.transactionType),
      ).toEqual(["RECEIVE", "CONSUME"]);
      expect(
        await database()
          .select()
          .from(inventoryTransactions)
          .where(and(eq(inventoryTransactions.organizationId, scenario.organizationId), eq(inventoryTransactions.transactionType, "WASTE"))),
      ).toEqual([]);
      expect((await orderRow(database(), orderId)).subtotal).toBe("0.00");
    });

    it("refuses a second void, a draft void, a missing reason and a stale version", async () => {
      const { orderId, version, items } = await sentOrder([burgerLine()]);
      const voided = await voidOrderItem(database(), scenario.manager, orderId, items[0]!.id, {
        reason: "Wrong item",
        disposition: "UNPREPARED",
        expectedVersion: version,
      });

      await expect(
        voidOrderItem(database(), scenario.manager, orderId, items[0]!.id, {
          reason: "Again",
          disposition: "UNPREPARED",
          expectedVersion: voided.version,
        }),
      ).rejects.toMatchObject({ code: "ITEM_ALREADY_VOIDED" });
      expect((await ledgerFor(database(), burger.stock.beef.id)).filter((row) => row.transactionType === "SALE_REVERSAL")).toHaveLength(1);

      const draft = await addDraftItem(database(), scenario.serverActor, orderId, {
        expectedVersion: voided.version,
        menuItemId: burger.menuItem.id,
        quantity: 1,
        selections: burger.mediumOnly,
        specialInstructions: null,
      });

      await expect(
        voidOrderItem(database(), scenario.manager, orderId, draft.itemId, {
          reason: "x",
          disposition: "UNPREPARED",
          expectedVersion: draft.orderVersion,
        }),
      ).rejects.toMatchObject({ code: "ITEM_NOT_SENT" });
      await expect(
        voidOrderItem(database(), scenario.manager, orderId, draft.itemId, {
          reason: "  ",
          disposition: "UNPREPARED",
          expectedVersion: draft.orderVersion,
        }),
      ).rejects.toMatchObject({ code: "REASON_REQUIRED" });
      await expect(
        voidOrderItem(database(), scenario.manager, orderId, items[0]!.id, {
          reason: "Stale",
          disposition: "UNPREPARED",
          expectedVersion: version,
        }),
      ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
    });

    it("rolls the whole void back when a reversal can't be posted", async () => {
      const { orderId, version, items } = await sentOrder([burgerLine()]);

      // Stop stocking bacon here: its reversal is refused, so nothing may change.
      await database()
        .update(inventoryItemLocations)
        .set({ active: false })
        .where(eq(inventoryItemLocations.inventoryItemId, burger.stock.bacon.id));

      await expect(
        voidOrderItem(database(), scenario.manager, orderId, items[0]!.id, {
          reason: "Cancelled",
          disposition: "UNPREPARED",
          expectedVersion: version,
        }),
      ).rejects.toMatchObject({ code: "ITEM_NOT_STOCKED_HERE" });

      expect((await itemRows(database(), orderId))[0]!.status).toBe("SUBMITTED");
      expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
      expect(await database().select().from(orderItemVoids).where(eq(orderItemVoids.orderItemId, items[0]!.id))).toEqual([]);
    });
  });

  describe("full order void", () => {
    it("voids sent items by disposition and drafts with no movement, in one transaction", async () => {
      const soda = await plainItem(database(), scenario.owner);
      const { orderId, version, items } = await sentOrder([burgerLine(), { menuItemId: soda.id }]);
      const draft = await addDraftItem(database(), scenario.serverActor, orderId, {
        expectedVersion: version,
        menuItemId: burger.menuItem.id,
        quantity: 1,
        selections: burger.mediumOnly,
        specialInstructions: null,
      });
      const burgerItem = items.find((item) => item.menuItemId === burger.menuItem.id)!;
      const sodaItem = items.find((item) => item.menuItemId === soda.id)!;

      await expect(
        voidOrder(database(), scenario.manager, orderId, {
          reason: "Walked out",
          expectedVersion: draft.orderVersion,
          dispositions: { [burgerItem.id]: "UNPREPARED" },
        }),
      ).rejects.toMatchObject({ code: "DISPOSITION_REQUIRED" });

      await voidOrder(database(), scenario.manager, orderId, {
        reason: "Walked out",
        expectedVersion: draft.orderVersion,
        dispositions: { [burgerItem.id]: "UNPREPARED", [sodaItem.id]: "PREPARED_OR_DISCARDED" },
      });

      const order = await orderRow(database(), orderId);

      expect(order).toMatchObject({ status: "VOIDED", voidReason: "Walked out", subtotal: "0.00", voidedByUserId: scenario.manager.userId });
      expect((await itemRows(database(), orderId)).map((item) => item.status)).toEqual(["VOIDED", "VOIDED", "VOIDED"]);
      expect(await onHand(database(), burger.stock.beef.id)).toBe("100.0000");
      expect(
        (await database().select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, orderId))).map((row) => row.status),
      ).toEqual(["OPEN", "VOIDED"]);
      expect(await database().select().from(orderItemVoids).where(eq(orderItemVoids.orderItemId, draft.itemId))).toEqual([]);

      await expect(
        addDraftItem(database(), scenario.serverActor, orderId, {
          expectedVersion: order.version,
          menuItemId: soda.id,
          quantity: 1,
          selections: [],
          specialInstructions: null,
        }),
      ).rejects.toMatchObject({ code: "ORDER_NOT_OPEN" });
      await expect(
        voidOrder(database(), scenario.manager, orderId, { reason: "Again", expectedVersion: order.version, dispositions: {} }),
      ).rejects.toMatchObject({ code: "ORDER_NOT_OPEN" });
    });
  });

  describe("discounts", () => {
    const definition = (scope: "ITEM" | "ORDER", discountType: "FIXED_AMOUNT" | "PERCENTAGE", value: string) =>
      createDiscountDefinition(database(), scenario.manager, {
        code: uniqueCode("DSC"),
        name: `${scope} ${discountType} ${value}`,
        scope,
        discountType,
        value,
      });

    it("applies item discounts first, then order discounts, exactly and capped", async () => {
      const soda = await plainItem(database(), scenario.owner, "3.33", "Soda");
      const { orderId, version, items } = await sentOrder([burgerLine(), { menuItemId: soda.id, quantity: 3 }]);
      // burger 17.49, soda 9.99: item subtotal 27.48
      const burgerItem = items.find((item) => item.menuItemId === burger.menuItem.id)!;
      const fiveOff = await definition("ITEM", "FIXED_AMOUNT", "5.00");
      const tenPercent = await definition("ORDER", "PERCENTAGE", "10");
      const first = await applyItemDiscount(database(), scenario.manager, orderId, burgerItem.id, {
        discountDefinitionId: fiveOff.id,
        reason: "Long wait",
        expectedVersion: version,
      });
      const second = await applyOrderDiscount(database(), scenario.manager, orderId, {
        discountDefinitionId: tenPercent.id,
        reason: "Regular",
        expectedVersion: first.orderVersion,
      });

      // 27.48 - 5.00 = 22.48; 10% = 2.248 -> 2.25 (half up); 22.48 - 2.25 = 20.23
      expect(await orderRow(database(), orderId)).toMatchObject({
        itemSubtotal: "27.48",
        discountTotal: "7.25",
        subtotal: "20.23",
      });

      // Later definition edits don't touch what was applied.
      await updateDiscountDefinition(database(), scenario.manager, tenPercent.id, {
        name: "Changed",
        value: "50",
        active: true,
        expectedVersion: tenPercent.version,
      });

      const [orderDiscount] = await database().select().from(orderDiscounts).where(eq(orderDiscounts.id, second.discountId));

      expect(orderDiscount).toMatchObject({ nameSnapshot: "ORDER PERCENTAGE 10", valueSnapshot: "10.00", appliedAmount: "2.25", isComp: false, appliedByUserId: scenario.manager.userId });

      // Voiding the burger voids its item discount and recomputes the order discount.
      await voidOrderItem(database(), scenario.manager, orderId, burgerItem.id, {
        reason: "Wrong",
        disposition: "PREPARED_OR_DISCARDED",
        expectedVersion: second.orderVersion,
      });

      const [itemDiscount] = await database().select().from(orderItemDiscounts).where(eq(orderItemDiscounts.id, first.discountId));

      expect(itemDiscount!.status).toBe("VOIDED");
      // 9.99, 10% = 0.999 -> 1.00
      expect(await orderRow(database(), orderId)).toMatchObject({ itemSubtotal: "9.99", discountTotal: "1.00", subtotal: "8.99" });
      // Discounts never restore inventory.
      expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
    });

    it("caps a fixed discount, marks a 100% comp, and records removal", async () => {
      const { orderId, version, items } = await sentOrder([burgerLine()]);
      const big = await definition("ITEM", "FIXED_AMOUNT", "50.00");
      const comp = await definition("ORDER", "PERCENTAGE", "100");
      const capped = await applyItemDiscount(database(), scenario.manager, orderId, items[0]!.id, {
        discountDefinitionId: big.id,
        reason: "Make it right",
        expectedVersion: version,
      });

      expect(await orderRow(database(), orderId)).toMatchObject({ discountTotal: "17.49", subtotal: "0.00" });

      const removed = await removeDiscount(database(), scenario.manager, orderId, capped.discountId, {
        reason: "Applied by mistake",
        expectedVersion: capped.orderVersion,
      });
      const comped = await applyOrderDiscount(database(), scenario.manager, orderId, {
        discountDefinitionId: comp.id,
        reason: "Birthday",
        expectedVersion: removed.version,
      });
      const [compRow] = await database().select().from(orderDiscounts).where(eq(orderDiscounts.id, comped.discountId));
      const [removedRow] = await database().select().from(orderItemDiscounts).where(eq(orderItemDiscounts.id, capped.discountId));

      expect(compRow).toMatchObject({ isComp: true, appliedAmount: "17.49" });
      expect(removedRow).toMatchObject({ status: "REMOVED", removeReason: "Applied by mistake", removedByUserId: scenario.manager.userId });
      expect(await orderRow(database(), orderId)).toMatchObject({ itemSubtotal: "17.49", discountTotal: "17.49", subtotal: "0.00" });
    });

    it("refuses discounts on drafts, the wrong scope, inactive definitions and without a reason", async () => {
      const order = await createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT" });
      const draft = await addDraftItem(database(), scenario.serverActor, order.id, {
        expectedVersion: order.version,
        menuItemId: burger.menuItem.id,
        quantity: 1,
        selections: burger.mediumOnly,
        specialInstructions: null,
      });
      const itemOff = await definition("ITEM", "FIXED_AMOUNT", "1.00");
      const orderOff = await definition("ORDER", "FIXED_AMOUNT", "1.00");

      await expect(
        applyItemDiscount(database(), scenario.manager, order.id, draft.itemId, { discountDefinitionId: itemOff.id, reason: "x", expectedVersion: draft.orderVersion }),
      ).rejects.toMatchObject({ code: "ITEM_NOT_DISCOUNTABLE" });
      await expect(
        applyOrderDiscount(database(), scenario.manager, order.id, { discountDefinitionId: orderOff.id, reason: "x", expectedVersion: draft.orderVersion }),
      ).rejects.toMatchObject({ code: "NOTHING_TO_DISCOUNT" });

      const { orderId, version, items } = await sentOrder([burgerLine()]);

      await expect(
        applyItemDiscount(database(), scenario.manager, orderId, items[0]!.id, { discountDefinitionId: orderOff.id, reason: "x", expectedVersion: version }),
      ).rejects.toMatchObject({ code: "DISCOUNT_SCOPE_MISMATCH" });
      await expect(
        applyItemDiscount(database(), scenario.manager, orderId, items[0]!.id, { discountDefinitionId: itemOff.id, reason: " ", expectedVersion: version }),
      ).rejects.toMatchObject({ code: "REASON_REQUIRED" });

      await updateDiscountDefinition(database(), scenario.manager, itemOff.id, { name: "Off", value: "1.00", active: false, expectedVersion: itemOff.version });
      await expect(
        applyItemDiscount(database(), scenario.manager, orderId, items[0]!.id, { discountDefinitionId: itemOff.id, reason: "x", expectedVersion: version }),
      ).rejects.toMatchObject({ code: "DISCOUNT_INACTIVE" });
      await expect(definition("ORDER", "PERCENTAGE", "100.01")).rejects.toMatchObject({ code: "INVALID_DISCOUNT_VALUE" });
      await expect(definition("ORDER", "FIXED_AMOUNT", "1.005")).rejects.toMatchObject({ code: "INVALID_DISCOUNT_VALUE" });
    });
  });

  it("keeps consumption snapshots and ledger history append-only", async () => {
    const { items } = await sentOrder([burgerLine()]);
    const [consumption] = await database()
      .select()
      .from(orderItemInventoryConsumption)
      .where(eq(orderItemInventoryConsumption.orderItemId, items[0]!.id));

    await expect(
      database().update(orderItemInventoryConsumption).set({ baseQuantity: "1" }).where(eq(orderItemInventoryConsumption.id, consumption!.id)),
    ).rejects.toBeTruthy();
    await expect(
      database().delete(orderItemStatusHistory).where(eq(orderItemStatusHistory.orderItemId, items[0]!.id)),
    ).rejects.toBeTruthy();
  });
});
