import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, orderSendBatches, orderTaxLines } from "@/db/schema";
import { changeTaxRate, createTaxCategory } from "@/modules/menu/services/tax-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { applyOrderDiscount, createDiscountDefinition } from "@/modules/orders/services/discount-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { uniqueCode } from "../../fixtures/menu-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  itemRows,
  newKey,
  orderRow,
  plainItem,
  seatedSession,
  type Burger,
} from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";
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

function taxLines(orderId: string) {
  return database().select().from(orderTaxLines).where(eq(orderTaxLines.orderId, orderId));
}

describe("tax (Phase 17 policy A)", () => {
  let scenario: SettlementScenario;
  let burger: Burger;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    burger = await baconCheeseburger(database(), scenario);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function dineInOrder() {
    const session = await seatedSession(database(), scenario);

    return createOrder(database(), scenario.cashier, { orderType: "DINE_IN", tableSessionId: session.id });
  }

  async function add(orderId: string, menuItemId: string, selections: { modifierGroupId: string; modifierId: string }[] = []) {
    const { version } = await orderRow(database(), orderId);

    return addDraftItem(database(), scenario.cashier, orderId, {
      expectedVersion: version,
      menuItemId,
      quantity: 1,
      selections,
      specialInstructions: null,
    });
  }

  async function send(orderId: string, key = newKey()) {
    const { version } = await orderRow(database(), orderId);

    return sendOrderItems(database(), scenario.cashier, orderId, { expectedVersion: version, idempotencyKey: key });
  }

  it("snapshots the canonical Bacon Cheeseburger's tax at SEND, once, even when the SEND is retried", async () => {
    await setTax(database(), scenario.owner, true);

    const { category } = await taxCategoryWithRate(database(), scenario.owner, "8.25", uniqueCode("FOOD"));

    await assignTaxCategory(database(), burger.menuItem.id, category.id);

    const order = await dineInOrder();

    await add(order.id, burger.menuItem.id, burger.canonicalSelections);

    const key = newKey();
    const { version: beforeSend } = await orderRow(database(), order.id);
    const first = await send(order.id, key);
    const [item] = await itemRows(database(), order.id);

    expect(item).toMatchObject({
      status: "SUBMITTED",
      lineTotalSnapshot: "17.49",
      taxCategoryId: category.id,
      taxCategoryCodeSnapshot: category.code,
      taxRateSnapshot: "8.2500",
    });

    // 17.49 x 8.25% = 1.442925 -> 1.44.
    expect(await orderRow(database(), order.id)).toMatchObject({
      subtotal: "17.49",
      taxTotal: "1.44",
      totalDue: "18.93",
    });
    expect(await taxLines(order.id)).toMatchObject([
      { taxCategoryId: category.id, taxRateSnapshot: "8.2500", taxableAmount: "17.49", taxAmount: "1.44" },
    ]);

    // The same key again: the first outcome, and nothing new.
    const again = await sendOrderItems(database(), scenario.cashier, order.id, {
      expectedVersion: beforeSend,
      idempotencyKey: key,
    });

    expect(again).toMatchObject({ replayed: true, batchId: first.batchId });
    expect(await database().select().from(orderSendBatches).where(eq(orderSendBatches.orderId, order.id))).toHaveLength(1);
    expect(await taxLines(order.id)).toHaveLength(1);
    expect((await orderRow(database(), order.id)).totalDue).toBe("18.93");
  });

  it("refuses the whole round when an item has no tax category or no rate, writing nothing", async () => {
    await setTax(database(), scenario.owner, true);

    const taxed = await plainItem(database(), scenario.owner, "4.00", "Taxed soda");
    const untaxed = await plainItem(database(), scenario.owner, "5.00", "Untaxed fries");
    const { category } = await taxCategoryWithRate(database(), scenario.owner, "6.00");

    await assignTaxCategory(database(), taxed.id, category.id);

    const order = await dineInOrder();

    await add(order.id, taxed.id);
    await add(order.id, untaxed.id);

    let error: unknown;

    try {
      await send(order.id);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("TAX_NOT_CONFIGURED");
    expect((error as AppError).details).toEqual({ items: ["Untaxed fries"] });
    expect((await itemRows(database(), order.id)).map((row) => row.status)).toEqual(["DRAFT", "DRAFT"]);

    // A category with no rate in force at this location is refused the same way.
    const noRate = await createTaxCategory(database(), scenario.owner, {
      code: uniqueCode("NORATE"),
      name: "No rate here",
      description: null,
    });

    await assignTaxCategory(database(), untaxed.id, noRate.id);

    expect(await codeOf(send(order.id))).toBe("TAX_NOT_CONFIGURED");
  });

  it("keeps a sent item's rate when the rate changes later; new items take the new rate", async () => {
    await setTax(database(), scenario.owner, true);

    const item = await plainItem(database(), scenario.owner, "10.00", "Wings");
    const { category, rate } = await taxCategoryWithRate(database(), scenario.owner, "8.00");

    await assignTaxCategory(database(), item.id, category.id);

    const order = await dineInOrder();

    await add(order.id, item.id);
    await send(order.id);

    await changeTaxRate(database(), scenario.owner, {
      taxCategoryId: category.id,
      ratePercent: "10",
      effectiveFrom: null,
      expectedCurrentRateId: rate.id,
    });

    await add(order.id, item.id);
    await send(order.id);

    expect((await itemRows(database(), order.id)).map((row) => row.taxRateSnapshot)).toEqual(["8.0000", "10.0000"]);
    expect(await orderRow(database(), order.id)).toMatchObject({ subtotal: "20.00", taxTotal: "1.80", totalDue: "21.80" });
    expect((await taxLines(order.id)).map((line) => [line.taxRateSnapshot, line.taxAmount]).sort()).toEqual([
      ["10.0000", "1.00"],
      ["8.0000", "0.80"],
    ]);
  });

  it("taxes the post-discount amount, and a comp leaves no tax", async () => {
    await setTax(database(), scenario.owner, true);

    const item = await plainItem(database(), scenario.owner, "20.00", "Steak");
    const { category } = await taxCategoryWithRate(database(), scenario.owner, "10.00");

    await assignTaxCategory(database(), item.id, category.id);

    const order = await dineInOrder();

    await add(order.id, item.id);
    await send(order.id);

    const discount = await createDiscountDefinition(database(), scenario.manager, {
      code: uniqueCode("OFF"),
      name: "Five off",
      scope: "ORDER",
      discountType: "FIXED_AMOUNT",
      value: "5.00",
    });
    const comp = await createDiscountDefinition(database(), scenario.manager, {
      code: uniqueCode("COMP"),
      name: "Comp",
      scope: "ORDER",
      discountType: "PERCENTAGE",
      value: "100",
    });

    await applyOrderDiscount(database(), scenario.manager, order.id, {
      discountDefinitionId: discount.id,
      reason: "Late food",
      expectedVersion: (await orderRow(database(), order.id)).version,
    });

    expect(await orderRow(database(), order.id)).toMatchObject({ subtotal: "15.00", taxTotal: "1.50", totalDue: "16.50" });

    await applyOrderDiscount(database(), scenario.manager, order.id, {
      discountDefinitionId: comp.id,
      reason: "Manager comp",
      expectedVersion: (await orderRow(database(), order.id)).version,
    });

    expect(await orderRow(database(), order.id)).toMatchObject({ subtotal: "0.00", taxTotal: "0.00", totalDue: "0.00" });
  });

  it("settles the total including tax, and refuses to complete for the pre-tax amount", async () => {
    await setTax(database(), scenario.owner, true);

    const item = await plainItem(database(), scenario.owner, "10.00", "Pasta");
    const { category } = await taxCategoryWithRate(database(), scenario.owner, "7.00");

    await assignTaxCategory(database(), item.id, category.id);

    const order = await dineInOrder();

    await add(order.id, item.id);
    await send(order.id);

    const opened = await openSettlement(database(), scenario.cashier, order.id);
    const row = await settlementRow(database(), opened.settlementId);

    expect(row).toMatchObject({ orderAmountSnapshot: "10.70", taxTotalSnapshot: "0.70", subtotalSnapshot: "10.00" });

    await tender(database(), scenario.cashier, opened.settlementId, { amount: "10.00", receivedAmount: "10.00" });

    const complete = async () =>
      completeSettlement(database(), scenario.cashier, opened.settlementId, {
        expectedVersion: (await settlementRow(database(), opened.settlementId)).version,
        idempotencyKey: newKey(),
      });

    expect(await codeOf(complete())).toBe("SETTLEMENT_NOT_BALANCED");

    // While the settlement is OPEN, the tax can't change underneath it.
    expect(await codeOf(database().execute(sql`UPDATE orders SET tax_total = 0 WHERE id = ${order.id}`))).toMatch(
      /^DB:/,
    );

    await tender(database(), scenario.cashier, opened.settlementId, { amount: "0.70", receivedAmount: "1.00" });

    const done = await complete();

    expect(done.replayed).toBe(false);
    expect(await orderRow(database(), order.id)).toMatchObject({ status: "CLOSED", totalDue: "10.70" });
  });

  it("taxes nothing while the location's tax switch is off", async () => {
    const item = await plainItem(database(), scenario.owner, "9.00", "Salad");
    const { category } = await taxCategoryWithRate(database(), scenario.owner, "8.00");

    await assignTaxCategory(database(), item.id, category.id);

    const order = await dineInOrder();

    await add(order.id, item.id);
    await send(order.id);

    expect((await itemRows(database(), order.id))[0]).toMatchObject({ taxCategoryId: null, taxRateSnapshot: null });
    expect(await orderRow(database(), order.id)).toMatchObject({ subtotal: "9.00", taxTotal: "0.00", totalDue: "9.00" });
    expect(await taxLines(order.id)).toEqual([]);
  });

  it("requires tax.manage, and audits configuration changes", async () => {
    expect(await codeOf(setTax(database(), scenario.cashier, true))).toBe("PERMISSION_DENIED");
    expect(
      await codeOf(taxCategoryWithRate(database(), scenario.settleManager, "5.00")),
    ).toBe("PERMISSION_DENIED");

    const { category } = await taxCategoryWithRate(database(), scenario.owner, "5.5");

    await setTax(database(), scenario.owner, true);

    const events = await database()
      .select({ action: auditEvents.action, after: auditEvents.after })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, scenario.owner.organizationId));
    const actions = events.map((event) => event.action);

    expect(actions).toEqual(
      expect.arrayContaining(["tax.category-created", "tax.rate-changed", "tax.location-setting-changed"]),
    );
    expect(events.find((event) => event.action === "tax.rate-changed")!.after).toMatchObject({
      categoryCode: category.code,
      percent: "5.5000",
    });
  });
});
