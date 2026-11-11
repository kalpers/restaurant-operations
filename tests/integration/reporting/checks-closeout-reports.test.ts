import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { runReport } from "@/modules/reporting/services/report-service";
import type { ReportArea, ReportResult } from "@/modules/reporting/types";
import {
  closeDrawerSession,
  createDrawer,
  getDrawerSetting,
  openDrawerSession,
  recordDrawerMovement,
  setCashDrawerRequired,
} from "@/modules/settlements/services/drawer-service";
import { recordRefund } from "@/modules/settlements/services/refund-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import { clearOrderData, newKey, orderRow, plainItem } from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";
import { assignTaxCategory, setTax, taxCategoryWithRate } from "../../fixtures/tax-fixtures";

const database = () => getDatabase();

const REPORTS: readonly PermissionCode[] = ["reports.view", "reports.sales", "reports.settlements"];

function row(report: ReportResult, sectionKey: string, column: string, value: unknown) {
  const found = report.sections.find((section) => section.key === sectionKey)?.rows.find((entry) => entry[column] === value);

  expect(found, `${sectionKey} row ${column}=${String(value)}`).toBeDefined();

  return found!;
}

/**
 * Phase 17 report additions (policy F36): tax from snapshots, refunds by the day they were
 * given, and drawer sessions. One closed taxed check paid in cash into a drawer, one partial
 * refund, one paid-out, and a closed drawer.
 */
describe("checks and close-out reports", () => {
  let scenario: SettlementScenario;
  let reporter: Actor;
  let today: string;

  const report = (area: ReportArea, extra: object = {}) =>
    runReport(database(), reporter, area, { locationId: scenario.locationA, from: today, to: today, ...extra });

  beforeAll(async () => {
    scenario = await createSettlementScenario(database());
    reporter = await actorWith(database(), scenario, REPORTS);

    const manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "drawers.view",
      "drawers.operate",
      "drawers.manage",
      "settlements.refund",
    ]);

    await setTax(database(), scenario.owner, true);

    const { version } = await getDrawerSetting(database(), manager);

    await setCashDrawerRequired(database(), manager, { required: true, expectedVersion: version });

    const food = await taxCategoryWithRate(database(), scenario.owner, "8.00", uniqueCode("FOOD"));
    const steak = await plainItem(database(), scenario.owner, "25.00", "Steak");
    const salad = await plainItem(database(), scenario.owner, "10.00", "Salad");

    await assignTaxCategory(database(), steak.id, food.category.id);
    await assignTaxCategory(database(), salad.id, food.category.id);

    const drawer = await createDrawer(database(), manager, { code: uniqueCode("DRW"), name: "Bar register" });
    const session = await openDrawerSession(database(), manager, drawer.id, { openingFloat: "100.00", idempotencyKey: newKey() });
    const order = await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT" });
    let orderVersion = order.version;

    for (const item of [steak, salad]) {
      orderVersion = (
        await addDraftItem(database(), scenario.cashier, order.id, {
          expectedVersion: orderVersion,
          menuItemId: item.id,
          quantity: 1,
          selections: [],
          specialInstructions: null,
        })
      ).orderVersion;
    }

    await sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: orderVersion, idempotencyKey: newKey() });

    // 35.00 + 8% = 2.80 tax; total due 37.80, paid in cash with a 2.20 tip.
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, {
      amount: "37.80",
      tipAmount: "2.20",
      receivedAmount: "40.00",
      cashDrawerSessionId: session.id,
    });
    await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });

    // Refund the salad: 10.80 including 0.80 tax, in cash from the drawer.
    await recordRefund(database(), manager, order.id, {
      idempotencyKey: newKey(),
      tenderType: "CASH",
      amount: "10.80",
      taxAmount: "0.80",
      reason: "Wilted salad",
      otherDescription: null,
      externalReference: null,
      cashDrawerSessionId: session.id,
    });
    await recordDrawerMovement(database(), manager, session.id, {
      movementType: "PAID_OUT",
      amount: "5.00",
      reason: "Lemons",
      idempotencyKey: newKey(),
    });

    // Expected: 100 + 37.80 + 2.20 - 5.00 - 10.80 = 124.20; counted 124.00.
    await closeDrawerSession(database(), manager, session.id, {
      countedAmount: "124.00",
      closeNote: null,
      expectedVersion: session.version,
      idempotencyKey: newKey(),
    });

    today = (await orderRow(database(), order.id)).businessDate;
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  it("shows tax beside net sales, and tax by category from the snapshots", async () => {
    const sales = await report("sales");

    expect(row(sales, "summary", "orderType", "All")).toMatchObject({ netSales: "35.00", tax: "2.80" });
    expect(row(sales, "tax", "rate", "8.0000")).toMatchObject({ orders: 1, taxable: "35.00", tax: "2.80" });
  });

  it("counts refunds on the day they were given and takes off their pre-tax part", async () => {
    const sales = await report("sales");

    expect(row(sales, "refunds", "businessDate", today)).toMatchObject({
      refunds: 1,
      amount: "10.80",
      tax: "0.80",
      netSales: "35.00",
      netAfterRefunds: "25.00",
    });

    // Tenders still reconcile to the closed sales: net sales plus tax.
    const settlements = await report("settlements");

    expect(row(settlements, "tenders", "tenderType", "All")).toMatchObject({ amount: "37.80", tips: "2.20" });
    expect(row(settlements, "refunds", "tenderType", "Cash")).toMatchObject({ refunds: 1, amount: "10.80", tax: "0.80" });
  });

  it("lists the drawer session with its expected cash, count and variance", async () => {
    const settlements = await report("settlements");

    expect(row(settlements, "drawers", "status", "CLOSED")).toMatchObject({
      openingFloat: "100.00",
      cashIn: "40.00",
      paidIn: "0.00",
      paidOut: "5.00",
      cashRefunds: "10.80",
      expected: "124.20",
      counted: "124.00",
      variance: "-0.20",
    });
  });
});
