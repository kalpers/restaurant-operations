import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, orderTaxLines } from "@/db/schema";
import { changeTaxRate, createTaxCategory } from "@/modules/menu/services/tax-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { clearTaxExemption, setTaxExemption } from "@/modules/orders/services/tax-exemption-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import { clearOrderData, itemRows, newKey, orderRow, plainItem, seatedSession } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";
import { assignTaxCategory, setTax } from "../../fixtures/tax-fixtures";

// Phase 20 policies 15 and 16 (D13-D15): tax included in prices, and tax-exempt checks.

const database = () => getDatabase();

describe("tax included in prices and tax-exempt checks (Phase 20)", () => {
  let scenario: SettlementScenario;

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    await setTax(database(), scenario.owner, true);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function categoryWithRate(ratePercent: string, priceIncludesTax: boolean) {
    const code = uniqueCode("TAX");
    const category = await createTaxCategory(database(), scenario.owner, { code, name: `Tax ${code}`, description: null });

    await changeTaxRate(database(), scenario.owner, {
      taxCategoryId: category.id,
      ratePercent,
      priceIncludesTax,
      effectiveFrom: null,
    });

    return category;
  }

  async function sentOrder(items: { price: string; categoryId: string }[]) {
    const session = await seatedSession(database(), scenario);
    const order = await createOrder(database(), scenario.cashier, { orderType: "DINE_IN", tableSessionId: session.id });

    for (const entry of items) {
      const item = await plainItem(database(), scenario.owner, entry.price, uniqueCode("Item"));

      await assignTaxCategory(database(), item.id, entry.categoryId);

      const { version } = await orderRow(database(), order.id);

      await addDraftItem(database(), scenario.cashier, order.id, {
        expectedVersion: version,
        menuItemId: item.id,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      });
    }

    const { version } = await orderRow(database(), order.id);

    await sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: version, idempotencyKey: newKey() });

    return orderRow(database(), order.id);
  }

  it("takes tax out of an inclusive price and keeps total due at the menu price", async () => {
    const drinks = await categoryWithRate("10", true);
    const food = await categoryWithRate("10", false);
    const order = await sentOrder([
      { price: "11.00", categoryId: drinks.id },
      { price: "10.00", categoryId: food.id },
    ]);

    // 11.00 includes 1.00; 10.00 gets 1.00 added. Pre-tax subtotal 20.00, tax 2.00, due 22.00.
    expect(order).toMatchObject({
      itemSubtotal: "21.00",
      includedTaxTotal: "1.00",
      subtotal: "20.00",
      taxTotal: "2.00",
      totalDue: "22.00",
    });

    const lines = await database().select().from(orderTaxLines).where(eq(orderTaxLines.orderId, order.id));

    expect(lines.map((line) => [line.taxIncluded, line.taxableAmount, line.taxAmount]).sort()).toEqual([
      [false, "10.00", "1.00"],
      [true, "10.00", "1.00"],
    ]);

    const items = await itemRows(database(), order.id);

    expect(items.map((item) => item.taxIncludedSnapshot).sort()).toEqual([false, true]);

    // The guest pays the total due, and the check closes.
    const opened = await openSettlement(database(), scenario.cashier, order.id);

    expect(await settlementRow(database(), opened.settlementId)).toMatchObject({ orderAmountSnapshot: "22.00" });
    await tender(database(), scenario.cashier, opened.settlementId, { amount: "22.00", receivedAmount: "22.00" });
    await completeSettlement(database(), scenario.cashier, opened.settlementId, {
      expectedVersion: (await settlementRow(database(), opened.settlementId)).version,
      idempotencyKey: newKey(),
    });
    expect((await orderRow(database(), order.id)).status).toBe("CLOSED");
  });

  it("keeps a sent item's snapshot when the rate later changes to inclusive", async () => {
    const food = await categoryWithRate("10", false);
    const order = await sentOrder([{ price: "10.00", categoryId: food.id }]);

    await changeTaxRate(database(), scenario.owner, {
      taxCategoryId: food.id,
      ratePercent: "10",
      priceIncludesTax: true,
      effectiveFrom: new Date(Date.now() + 60_000),
    });

    const [item] = await itemRows(database(), order.id);

    expect(item).toMatchObject({ taxIncludedSnapshot: false, taxRateSnapshot: "10.0000" });
    expect((await orderRow(database(), order.id)).totalDue).toBe("11.00");
  });

  it("makes a check tax exempt, removing added tax and the tax inside prices", async () => {
    const drinks = await categoryWithRate("10", true);
    const food = await categoryWithRate("10", false);
    const order = await sentOrder([
      { price: "11.00", categoryId: drinks.id },
      { price: "10.00", categoryId: food.id },
    ]);
    const exempted = await setTaxExemption(database(), scenario.owner, order.id, {
      reason: "Nonprofit event",
      reference: "EX-4471",
      expectedVersion: order.version,
    });

    expect(exempted).toMatchObject({ taxTotal: "0.00", totalDue: "20.00" });
    expect(await orderRow(database(), order.id)).toMatchObject({
      taxExempt: true,
      includedTaxTotal: "1.00",
      subtotal: "20.00",
      taxExemptReference: "EX-4471",
    });
    expect(await database().select().from(orderTaxLines).where(eq(orderTaxLines.orderId, order.id))).toEqual([]);

    const [audit] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "tax.exemption-set"), eq(auditEvents.entityId, order.id)));

    expect(audit!.details).toMatchObject({ reason: "Nonprofit event", hasReference: true });
    expect(JSON.stringify(audit)).not.toContain("EX-4471");

    const cleared = await clearTaxExemption(database(), scenario.owner, order.id, {
      expectedVersion: exempted.orderVersion,
    });

    expect(cleared).toMatchObject({ taxTotal: "2.00", totalDue: "22.00" });
  });

  it("refuses an exemption without the permission, with an open settlement, or with a card-like reference", async () => {
    const food = await categoryWithRate("10", false);
    const order = await sentOrder([{ price: "10.00", categoryId: food.id }]);

    await expect(
      setTaxExemption(database(), scenario.cashier, order.id, { reason: "Please", expectedVersion: order.version }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      setTaxExemption(database(), scenario.owner, order.id, {
        reason: "Exempt",
        reference: "4111111111111111",
        expectedVersion: order.version,
      }),
    ).rejects.toMatchObject({ code: "SENSITIVE_DATA_REFUSED" });

    await openSettlement(database(), scenario.cashier, order.id);

    await expect(
      setTaxExemption(database(), scenario.owner, order.id, {
        reason: "Exempt",
        expectedVersion: (await orderRow(database(), order.id)).version,
      }),
    ).rejects.toMatchObject({ code: "SETTLEMENT_IN_PROGRESS" });
  });

  it("is held by managers in the role catalog, not by servers", async () => {
    const manager = await actorWith(database(), scenario, ["tax.exempt"]);

    expect(manager.permissions.has("tax.exempt")).toBe(true);
    expect(scenario.cashier.permissions.has("tax.exempt")).toBe(false);

    const [row] = await database().execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
          JOIN permissions p ON p.id = rp.permission_id
          WHERE p.code = 'tax.exempt' AND r.code = 'SERVER'`,
    );

    expect(row?.count ?? 0).toBe(0);
  });
});
