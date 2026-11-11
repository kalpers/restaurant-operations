import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, orderItemDiscounts, orderItemTransfers } from "@/db/schema";
import { fulfillmentForOrder, getExpoView } from "@/modules/kitchen/queries/kitchen-queries";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { applyItemDiscount, applyOrderDiscount, createDiscountDefinition } from "@/modules/orders/services/discount-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { moveOrderItems } from "@/workflows/move-order-items/move-order-items";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { actorWith } from "../../fixtures/employee-fixtures";
import { COOK_PERMISSIONS, createKitchenScenario, type KitchenScenario } from "../../fixtures/kitchen-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import {
  clearOrderData,
  itemRows,
  MANAGER_ORDER_PERMISSIONS,
  newKey,
  onHand,
  orderRow,
  seatedSession,
  SERVER_ORDER_PERMISSIONS,
} from "../../fixtures/order-fixtures";
import { assignTaxCategory, setTax, taxCategoryWithRate } from "../../fixtures/tax-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

describe("moving items between checks (Phase 17 policy C)", () => {
  let scenario: KitchenScenario;
  let server: Awaited<ReturnType<typeof actorWith>>;
  let manager: Awaited<ReturnType<typeof actorWith>>;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
    server = await actorWith(database(), scenario.base, [
      ...SERVER_ORDER_PERMISSIONS,
      "orders.move-items",
      "settlements.view",
      "settlements.create",
    ]);
    manager = await actorWith(database(), scenario.base, [
      ...MANAGER_ORDER_PERMISSIONS,
      ...COOK_PERMISSIONS,
      "orders.move-items",
    ]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function checkAtTable(tableSessionId?: string) {
    const sessionId = tableSessionId ?? (await seatedSession(database(), scenario.base)).id;
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: sessionId });

    return { ...order, sessionId };
  }

  async function add(orderId: string, menuItemId: string) {
    return addDraftItem(database(), server, orderId, {
      expectedVersion: (await orderRow(database(), orderId)).version,
      menuItemId,
      quantity: 1,
      selections: [],
      specialInstructions: null,
    });
  }

  async function send(orderId: string) {
    return sendOrderItems(database(), server, orderId, {
      expectedVersion: (await orderRow(database(), orderId)).version,
      idempotencyKey: newKey(),
    });
  }

  async function move(sourceId: string, itemIds: string[], target: { orderId: string } | { newCheck: true }, key = newKey()) {
    return moveOrderItems(database(), server, sourceId, {
      itemIds,
      expectedVersion: (await orderRow(database(), sourceId)).version,
      idempotencyKey: key,
      target:
        "newCheck" in target
          ? target
          : { orderId: target.orderId, expectedVersion: (await orderRow(database(), target.orderId)).version },
    });
  }

  it("moves sent and draft items to a new check, recomputing both totals and tax", async () => {
    await setTax(database(), scenario.owner, true);

    const { category } = await taxCategoryWithRate(database(), scenario.owner, "10.00");

    await assignTaxCategory(database(), scenario.fries.id, category.id);
    await assignTaxCategory(database(), scenario.cocktail.id, category.id);

    const source = await checkAtTable();

    await add(source.id, scenario.fries.id);
    await add(source.id, scenario.cocktail.id);
    await send(source.id);

    const draft = await add(source.id, scenario.fries.id);
    const [fries, cocktail] = await itemRows(database(), source.id);

    expect(await orderRow(database(), source.id)).toMatchObject({ subtotal: "15.50", taxTotal: "1.55", totalDue: "17.05" });

    const moved = await move(source.id, [cocktail!.id, draft.itemId], { newCheck: true });
    const target = await orderRow(database(), moved.targetOrderId);

    expect(target).toMatchObject({ tableSessionId: source.sessionId, status: "OPEN", subtotal: "11.00", taxTotal: "1.10", totalDue: "12.10" });
    expect(target.orderNumber).not.toBe((await orderRow(database(), source.id)).orderNumber);
    expect(await orderRow(database(), source.id)).toMatchObject({ subtotal: "4.50", taxTotal: "0.45", totalDue: "4.95" });

    // Snapshots are unchanged; only the order changed.
    const [movedCocktail] = (await itemRows(database(), moved.targetOrderId)).filter((row) => row.id === cocktail!.id);

    expect(movedCocktail).toMatchObject({
      status: "SUBMITTED",
      lineTotalSnapshot: cocktail!.lineTotalSnapshot,
      sendBatchId: cocktail!.sendBatchId,
      taxRateSnapshot: "10.0000",
    });
    expect((await itemRows(database(), source.id)).map((row) => row.id)).toEqual([fries!.id]);

    const transfers = await database()
      .select()
      .from(orderItemTransfers)
      .where(eq(orderItemTransfers.transferGroupId, moved.transferGroupId));

    expect(transfers).toHaveLength(2);
    expect(transfers.every((row) => row.fromOrderId === source.id && row.toOrderId === moved.targetOrderId)).toBe(true);

    // Station work follows the item to its new check.
    expect((await fulfillmentForOrder(database(), moved.targetOrderId)).has(cocktail!.id)).toBe(true);
    expect((await fulfillmentForOrder(database(), source.id)).has(cocktail!.id)).toBe(false);

    const expo = await getExpoView(database(), scenario.cook);

    expect(expo.orders.find((order) => order.orderId === moved.targetOrderId)?.items.map((item) => item.orderItemId)).toBeUndefined();
    expect(
      (await getExpoView(database(), scenario.bartender)).orders
        .find((order) => order.orderId === moved.targetOrderId)!
        .items.map((item) => item.orderItemId),
    ).toEqual([cocktail!.id]);

    const audit = await database()
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, "orders.items-moved"));

    expect(audit.find((event) => event.entityId === source.id)?.after).toMatchObject({ itemCount: 2 });
  });

  it("moves an item's discounts with it and leaves order discounts behind", async () => {
    const source = await checkAtTable();
    const target = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: source.sessionId });

    await add(source.id, scenario.fries.id);
    await add(source.id, scenario.cocktail.id);
    await send(source.id);

    const [, cocktail] = await itemRows(database(), source.id);
    const itemOff = await createDiscountDefinition(database(), manager, {
      code: uniqueCode("ITM"),
      name: "Two off",
      scope: "ITEM",
      discountType: "FIXED_AMOUNT",
      value: "2.00",
    });
    const orderOff = await createDiscountDefinition(database(), manager, {
      code: uniqueCode("ORD"),
      name: "One off",
      scope: "ORDER",
      discountType: "FIXED_AMOUNT",
      value: "1.00",
    });

    await applyItemDiscount(database(), manager, source.id, cocktail!.id, {
      discountDefinitionId: itemOff.id,
      reason: "Weak pour",
      expectedVersion: (await orderRow(database(), source.id)).version,
    });
    await applyOrderDiscount(database(), manager, source.id, {
      discountDefinitionId: orderOff.id,
      reason: "Regular",
      expectedVersion: (await orderRow(database(), source.id)).version,
    });

    await move(source.id, [cocktail!.id], { orderId: target.id });

    expect(await orderRow(database(), target.id)).toMatchObject({ itemSubtotal: "11.00", discountTotal: "2.00", subtotal: "9.00" });
    expect(await orderRow(database(), source.id)).toMatchObject({ itemSubtotal: "4.50", discountTotal: "1.00", subtotal: "3.50" });

    const [discount] = await database()
      .select()
      .from(orderItemDiscounts)
      .where(eq(orderItemDiscounts.orderItemId, cocktail!.id));

    expect(discount).toMatchObject({ status: "APPLIED", appliedAmount: "2.00" });
  });

  it("refuses across sessions, for takeout, with a settlement open, for voided items and on a stale version", async () => {
    const source = await checkAtTable();
    const elsewhere = await checkAtTable();

    await add(source.id, scenario.fries.id);
    await add(source.id, scenario.cocktail.id);
    await send(source.id);

    const [fries, cocktail] = await itemRows(database(), source.id);

    expect(await codeOf(move(source.id, [fries!.id], { orderId: elsewhere.id }))).toBe("DIFFERENT_SESSION");

    const takeout = await createOrder(database(), server, { orderType: "TAKEOUT" });

    await add(takeout.id, scenario.fries.id);

    const [takeoutItem] = await itemRows(database(), takeout.id);

    expect(await codeOf(move(takeout.id, [takeoutItem!.id], { newCheck: true }))).toBe("TAKEOUT_CANNOT_SPLIT");

    await voidOrderItem(database(), manager, source.id, fries!.id, {
      reason: "Wrong item",
      disposition: "UNPREPARED",
      expectedVersion: (await orderRow(database(), source.id)).version,
    });

    expect(await codeOf(move(source.id, [fries!.id], { newCheck: true }))).toBe("ITEM_VOIDED");

    expect(
      await codeOf(
        moveOrderItems(database(), server, source.id, {
          itemIds: [cocktail!.id],
          expectedVersion: 1,
          idempotencyKey: newKey(),
          target: { newCheck: true },
        }),
      ),
    ).toBe("CONCURRENCY_CONFLICT");

    await openSettlement(database(), server, source.id);

    expect(await codeOf(move(source.id, [cocktail!.id], { newCheck: true }))).toBe("SETTLEMENT_IN_PROGRESS");
  });

  it("returns the first result for a retried key and moves nothing more", async () => {
    const source = await checkAtTable();

    await add(source.id, scenario.fries.id);
    await send(source.id);

    const [fries] = await itemRows(database(), source.id);
    const key = newKey();
    const { version } = await orderRow(database(), source.id);
    const request = { itemIds: [fries!.id], expectedVersion: version, idempotencyKey: key, target: { newCheck: true as const } };
    const first = await moveOrderItems(database(), server, source.id, request);
    const again = await moveOrderItems(database(), server, source.id, request);

    expect(again).toMatchObject({ replayed: true, targetOrderId: first.targetOrderId });
    expect(
      await database().select().from(orderItemTransfers).where(eq(orderItemTransfers.orderItemId, fries!.id)),
    ).toHaveLength(1);
  });

  it("refuses to move a sent item without a transfer row (database guard)", async () => {
    const source = await checkAtTable();
    const target = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: source.sessionId });

    await add(source.id, scenario.fries.id);
    await send(source.id);

    const [fries] = await itemRows(database(), source.id);

    expect(
      await codeOf(database().execute(sql`UPDATE order_items SET order_id = ${target.id} WHERE id = ${fries!.id}`)),
    ).toMatch(/^DB:/);
  });

  it("voids a moved item on its new check, reversing stock exactly once", async () => {
    const source = await checkAtTable();

    await addDraftItem(database(), server, source.id, {
      expectedVersion: (await orderRow(database(), source.id)).version,
      menuItemId: scenario.burger.menuItem.id,
      quantity: 1,
      selections: scenario.burger.canonicalSelections,
      specialInstructions: null,
    });
    await send(source.id);

    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("92.0000");

    const [burger] = await itemRows(database(), source.id);
    const moved = await move(source.id, [burger!.id], { newCheck: true });

    await voidOrderItem(database(), manager, moved.targetOrderId, burger!.id, {
      reason: "Guest changed mind",
      disposition: "UNPREPARED",
      expectedVersion: (await orderRow(database(), moved.targetOrderId)).version,
    });

    expect(await onHand(database(), scenario.burger.stock.beef.id)).toBe("100.0000");
    expect(await orderRow(database(), moved.targetOrderId)).toMatchObject({ subtotal: "0.00" });
  });

  it("requires orders.move-items", async () => {
    const source = await checkAtTable();

    await add(source.id, scenario.fries.id);

    const [fries] = await itemRows(database(), source.id);

    expect(
      await codeOf(
        moveOrderItems(database(), scenario.serverActor, source.id, {
          itemIds: [fries!.id],
          expectedVersion: (await orderRow(database(), source.id)).version,
          idempotencyKey: newKey(),
          target: { newCheck: true },
        }),
      ),
    ).toBe("PERMISSION_DENIED");
  });
});
