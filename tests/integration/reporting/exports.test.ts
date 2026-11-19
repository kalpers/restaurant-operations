import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, orders } from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { getUserAuthContext } from "@/modules/auth/services/permission-service";
import type { Actor } from "@/modules/auth/types";
import { changeTaxRate, createTaxCategory } from "@/modules/menu/services/tax-service";
import {
  applyItemDiscount,
  applyOrderDiscount,
  createDiscountDefinition,
} from "@/modules/orders/services/discount-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { setTaxExemption } from "@/modules/orders/services/tax-exemption-service";
import { exportPayrollHours, exportSalesJournal } from "@/modules/reporting/services/export-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { closeDrawerSession, createDrawer, openDrawerSession } from "@/modules/settlements/services/drawer-service";
import { recordRefund } from "@/modules/settlements/services/refund-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { addDecimals, subtractDecimals } from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import { clearOrderData, itemRows, newKey, orderRow, plainItem } from "../../fixtures/order-fixtures";
import { createSchedulableEmployee } from "../../fixtures/scheduling-fixtures";
import {
  createSettlementScenario,
  MANAGER_SETTLEMENT_PERMISSIONS,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";
import { assignTaxCategory, setTax } from "../../fixtures/tax-fixtures";
import { insertClosedEntry, insertOpenEntry } from "../../fixtures/timeclock-fixtures";

const database = () => getDatabase();
const ZONE = "America/Detroit";

/** Parses the plain CSV the exports write (no quoted commas in these fixtures). */
function parse(csv: string): Record<string, string>[] {
  const [header, ...lines] = csv.trimEnd().split("\r\n");
  const keys = header!.split(",");

  return lines.map((line) => Object.fromEntries(line.split(",").map((value, index) => [keys[index]!, value])));
}

const sum = (values: string[]) => values.reduce((total, value) => addDecimals(total, value), "0.00");

describe("exports (Phase 28)", () => {
  let scenario: SettlementScenario;
  let manager: Actor;
  let today: string;
  const orderIds: string[] = [];

  const authOf = async (actor: Actor) => (await getUserAuthContext(database(), actor.userId))!;
  const exporter = (permissions: readonly PermissionCode[]) => actorWith(database(), scenario, permissions);

  async function sell(items: { price: string; categoryId: string }[]) {
    const order = await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT" });

    for (const entry of items) {
      const item = await plainItem(database(), scenario.owner, entry.price, uniqueCode("Item"));

      await assignTaxCategory(database(), item.id, entry.categoryId);
      await addDraftItem(database(), scenario.cashier, order.id, {
        expectedVersion: (await orderRow(database(), order.id)).version,
        menuItemId: item.id,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      });
    }

    await sendOrderItems(database(), scenario.cashier, order.id, {
      expectedVersion: (await orderRow(database(), order.id)).version,
      idempotencyKey: newKey(),
    });
    orderIds.push(order.id);

    return order.id;
  }

  async function settle(orderId: string, tenderInput: Parameters<typeof tender>[3]) {
    const { settlementId } = await openSettlement(database(), scenario.cashier, orderId);

    await tender(database(), scenario.cashier, settlementId, tenderInput);
    await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });
  }

  beforeAll(async () => {
    scenario = await createSettlementScenario(database());
    today = businessDateOf(new Date(), { timeZone: ZONE, businessDayCutoff: "04:00" });
    manager = await actorWith(database(), scenario, [
      ...MANAGER_SETTLEMENT_PERMISSIONS,
      "drawers.view",
      "drawers.operate",
      "drawers.manage",
      "settlements.refund",
      "tax.exempt",
    ]);
    await setTax(database(), scenario.owner, true);

    const food = await createTaxCategory(database(), scenario.owner, { code: uniqueCode("FOOD"), name: "Food", description: null });
    const liquor = await createTaxCategory(database(), scenario.owner, { code: uniqueCode("LIQ"), name: "Liquor", description: null });

    await changeTaxRate(database(), scenario.owner, { taxCategoryId: food.id, ratePercent: "8.00", effectiveFrom: null });
    await changeTaxRate(database(), scenario.owner, {
      taxCategoryId: liquor.id,
      ratePercent: "6.00",
      priceIncludesTax: true,
      effectiveFrom: null,
    });

    const tenOff = await createDiscountDefinition(database(), manager, {
      code: uniqueCode("TEN"),
      name: "Ten percent",
      scope: "ORDER",
      discountType: "PERCENTAGE",
      value: "10",
    });
    const comp = await createDiscountDefinition(database(), manager, {
      code: uniqueCode("COMP"),
      name: "Comp",
      scope: "ITEM",
      discountType: "PERCENTAGE",
      value: "100",
    });
    const drawer = await createDrawer(database(), manager, { code: uniqueCode("DRW"), name: "Front" });
    const session = await openDrawerSession(database(), manager, drawer.id, { openingFloat: "100.00", idempotencyKey: newKey() });

    // A: steak (food, tax added), wine (liquor, tax inside the price), a comped salad, 10% off.
    const a = await sell([
      { price: "25.00", categoryId: food.id },
      { price: "10.60", categoryId: liquor.id },
      { price: "5.00", categoryId: food.id },
    ]);
    const salad = (await itemRows(database(), a))[2]!;

    await applyItemDiscount(database(), manager, a, salad.id, {
      discountDefinitionId: comp.id,
      reason: "Late",
      expectedVersion: (await orderRow(database(), a)).version,
    });
    await applyOrderDiscount(database(), manager, a, {
      discountDefinitionId: tenOff.id,
      reason: "Regular",
      expectedVersion: (await orderRow(database(), a)).version,
    });

    const dueA = (await orderRow(database(), a)).totalDue;

    await settle(a, {
      tenderType: "CASH",
      amount: dueA,
      tipAmount: "3.00",
      receivedAmount: addDecimals(dueA, "3.00"),
      cashDrawerSessionId: session.id,
    });

    // B: a tax-exempt burger paid by card with a tip.
    const b = await sell([{ price: "12.00", categoryId: food.id }]);

    await setTaxExemption(database(), manager, b, { reason: "School", expectedVersion: (await orderRow(database(), b)).version });
    await settle(b, { tenderType: "EXTERNAL_CARD", amount: (await orderRow(database(), b)).totalDue, tipAmount: "2.00" });

    // A refund on A in cash, with a tip returned, and the drawer closed 0.20 short.
    await recordRefund(database(), manager, a, {
      idempotencyKey: newKey(),
      tenderType: "CASH",
      amount: "5.40",
      taxAmount: "0.40",
      tipAmount: "1.00",
      reason: "Overcooked",
      otherDescription: null,
      externalReference: null,
      cashDrawerSessionId: session.id,
    });

    // Expected cash: 100.00 float + A's due and 3.00 tip - the 5.40 refund - the 1.00 tip returned.
    const expected = subtractDecimals(addDecimals(addDecimals("100.00", dueA), "3.00"), "6.40");

    await closeDrawerSession(database(), manager, session.id, {
      countedAmount: subtractDecimals(expected, "0.20"),
      closeNote: null,
      expectedVersion: session.version,
      idempotencyKey: newKey(),
    });
  }, 240_000);

  afterAll(async () => {
    await clearEmployeeData(database());
    await clearOrderData(database());
    await closeDatabase();
  });

  describe("sales journal", () => {
    it("balances, and its lines equal the stored order totals, tenders, refunds and drawer", async () => {
      const actor = await exporter(["reports.view", "reports.export", "reports.sales", "reports.settlements"]);
      const { csv, fileName } = await exportSalesJournal(database(), await authOf(actor), {
        locationId: scenario.locationA,
        from: today,
        to: today,
      });
      const rows = parse(csv);
      const lines = (type: string, code?: string) =>
        rows.filter((row) => row.line_type === type && (code === undefined || row.code === code));
      const totals = await database().select().from(orders).where(eq(orders.locationId, scenario.locationA));
      const closed = totals.filter((order) => orderIds.includes(order.id));

      expect(fileName).toMatch(/^sales-journal_.+\.csv$/);
      expect(Object.keys(rows[0]!)).toEqual(["business_date", "line_type", "code", "debit", "credit"]);
      expect(sum(rows.map((row) => row.debit!))).toBe(sum(rows.map((row) => row.credit!)));

      // Sales credits are the item lines; tax credits the tax charged; included tax comes back out.
      expect(sum(lines("SALES").map((row) => row.credit!))).toBe(sum(closed.map((order) => order.itemSubtotal)));
      expect(lines("SALES", "TAX_INCLUDED")[0]!.debit).toBe(sum(closed.map((order) => order.includedTaxTotal)));
      expect(sum(lines("TAX").map((row) => row.credit!))).toBe(sum(closed.map((order) => order.taxTotal)));
      expect(addDecimals(lines("DISCOUNT")[0]!.debit!, lines("COMP")[0]!.debit!)).toBe(
        sum(closed.map((order) => order.discountTotal)),
      );
      expect(lines("COMP")[0]!.debit).toBe("5.00");

      // Tenders are total due plus tips, less what went back out.
      expect(sum(lines("TENDER").map((row) => row.debit!))).toBe(
        addDecimals(sum(closed.map((order) => order.totalDue)), "5.00"),
      );
      expect(lines("TIPS_PAYABLE", "TIPS")[0]!.credit).toBe("5.00");
      expect(lines("REFUND", "CASH")[0]!.debit).toBe("5.00");
      expect(lines("TAX", "REFUNDED")[0]!.debit).toBe("0.40");
      expect(lines("TIP_REFUND", "CASH")[0]!.debit).toBe("1.00");
      expect(lines("CASH_OVER_SHORT", "CASH")[0]!.debit).toBe("0.20");
      expect(lines("TENDER", "CASH")[0]!.credit).toBe("6.60");

      const [audit] = await database()
        .select()
        .from(auditEvents)
        .where(and(eq(auditEvents.action, "reports.exported"), eq(auditEvents.actorUserId, actor.userId)));

      expect(audit!.details).toMatchObject({ area: "exports:journal", from: today, to: today, rowCount: rows.length });
    });

    it("matches net sales in the Sales report", async () => {
      const actor = await exporter(["reports.view", "reports.export", "reports.sales", "reports.settlements"]);
      const rows = parse(
        (await exportSalesJournal(database(), await authOf(actor), { locationId: scenario.locationA, from: today, to: today })).csv,
      );
      const sales = await runReport(database(), actor, "sales", { locationId: scenario.locationA, from: today, to: today });
      const all = sales.sections.find((section) => section.key === "summary")!.rows.find((row) => row.orderType === "All")!;
      const credits = sum(rows.filter((row) => row.line_type === "SALES").map((row) => row.credit!));
      const contra = sum(
        rows.filter((row) => ["DISCOUNT", "COMP"].includes(row.line_type!) || row.code === "TAX_INCLUDED").map((row) => row.debit!),
      );

      expect(subtractDecimals(credits, contra)).toBe(all.netSales);
    });

    it("needs reports.export, reports.sales and reports.settlements", async () => {
      for (const missing of ["reports.export", "reports.sales", "reports.settlements"] as const) {
        const actor = await exporter(
          (["reports.view", "reports.export", "reports.sales", "reports.settlements"] as const).filter((code) => code !== missing),
        );

        await expect(
          exportSalesJournal(database(), await authOf(actor), { locationId: scenario.locationA, from: today, to: today }),
        ).rejects.toMatchObject({ name: "AuthorizationError" });
      }
    });
  });

  describe("payroll hours", () => {
    // 2025-03-03 is a Monday; Detroit is UTC-5. Weeks start on Monday by default (40 h at 1.5x).
    const local = (date: string, time: string) => new Date(`${date}T${time}:00-05:00`);
    let employee: string;

    beforeAll(async () => {
      employee = await createSchedulableEmployee(database(), scenario, { employeeNumber: "PX-1", firstName: "Pat" });

      // Monday to Friday, 9 hours a day: 45 hours, 5 of them overtime.
      for (const date of ["2025-03-03", "2025-03-04", "2025-03-05", "2025-03-06", "2025-03-07"]) {
        await insertClosedEntry(database(), scenario.owner, {
          employeeId: employee,
          positionId: scenario.server,
          businessDate: date,
          clockInAt: local(date, "10:00"),
          clockOutAt: local(date, "19:00"),
        });
      }
    });

    it("lists hours by employee, position and week, equal to the labor report, with no pay", async () => {
      const actor = await exporter(["reports.view", "reports.export", "reports.labor", "hr.compensation.view"]);
      const { csv } = await exportPayrollHours(database(), await authOf(actor), {
        locationId: scenario.locationA,
        from: "2025-03-03",
        to: "2025-03-09",
      });
      const rows = parse(csv);
      const labor = await runReport(database(), actor, "labor", { locationId: scenario.locationA, from: "2025-03-03", to: "2025-03-09" });
      const actual = labor.sections.find((section) => section.key === "actualEmployees")!.rows.find((row) => row.employeeNumber === "PX-1")!;

      expect(Object.keys(rows[0]!)).toEqual([
        "week_start",
        "employee_number",
        "employee_name",
        "position_code",
        "regular_hours",
        "overtime_hours",
        "total_hours",
      ]);
      expect(rows).toEqual([
        expect.objectContaining({ week_start: "2025-03-03", employee_number: "PX-1", regular_hours: "40.00", overtime_hours: "5.00", total_hours: "45.00" }),
      ]);
      expect(Number(actual.regularHours)).toBe(40);
      expect(Number(actual.overtimeHours)).toBe(5);
      // Even with hr.compensation.view, no rate, wage or pay appears.
      expect(csv).not.toMatch(/rate|wage|pay|cost/i);
    });

    it("adds tip columns only for people who can see tips", async () => {
      const actor = await exporter(["reports.view", "reports.export", "reports.labor", "reports.tips"]);
      const [row] = parse(
        (await exportPayrollHours(database(), await authOf(actor), { locationId: scenario.locationA, from: "2025-03-03", to: "2025-03-09" })).csv,
      );

      expect(row).toMatchObject({ tip_share: "0.00", declared_tips: "0.00", tips_finalized: "NO" });
    });

    it("refuses a range that isn't whole weeks", async () => {
      const actor = await exporter(["reports.view", "reports.export", "reports.labor"]);

      await expect(
        exportPayrollHours(database(), await authOf(actor), { locationId: scenario.locationA, from: "2025-03-04", to: "2025-03-10" }),
      ).rejects.toMatchObject({ code: "PAYROLL_RANGE_NOT_WHOLE_WEEKS" });
    });

    it("refuses while a time entry in the range is still open", async () => {
      const actor = await exporter(["reports.view", "reports.export", "reports.labor"]);

      await insertOpenEntry(database(), scenario.owner, {
        employeeId: employee,
        positionId: scenario.server,
        businessDate: "2025-03-15",
        clockInAt: local("2025-03-15", "10:00"),
      });

      await expect(
        exportPayrollHours(database(), await authOf(actor), { locationId: scenario.locationA, from: "2025-03-10", to: "2025-03-16" }),
      ).rejects.toMatchObject({ code: "TIME_ENTRIES_OPEN", message: expect.stringContaining("PX-1 on 2025-03-15") });
    });

    it("needs reports.export and reports.labor", async () => {
      const actor = await exporter(["reports.view", "reports.labor"]);

      await expect(
        exportPayrollHours(database(), await authOf(actor), { locationId: scenario.locationA, from: "2025-03-03", to: "2025-03-09" }),
      ).rejects.toMatchObject({ name: "AuthorizationError" });
    });
  });
});
