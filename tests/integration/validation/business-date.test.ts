import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryTransactions, orderItemInventoryConsumption, orderItems, settlements, settlementTenders } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { listAuditEvents } from "@/modules/auditing/queries/audit-queries";
import { recordWaste } from "@/modules/inventory/services/stock-operations";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { businessDateOf } from "@/shared/time/business-date-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { createKitchenScenario, type KitchenScenario } from "../../fixtures/kitchen-fixtures";
import { newKey, orderRow } from "../../fixtures/order-fixtures";
import { DAY_TIME_ZONE, localInstant, REPORTER_PERMISSIONS, startFakeClock, stopFakeClock } from "../../fixtures/restaurant-day";
import { SERVER_SETTLEMENT_PERMISSIONS, settlementRow, tender } from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();
const SETTINGS = { timeZone: DAY_TIME_ZONE, businessDayCutoff: "04:00" };

type Sale = { label: string; instant: Date; orderId: string; wasteTransactionId: string };

/**
 * One BusinessDateService decides every business date (README section 29). A sale run
 * entirely at one instant, from order to completed settlement, plus a waste posting, must
 * land on the same business date in every domain, and reports and the audit viewer must
 * place it there too. Instants: one second before the 4:00 AM cutoff, exactly at it, one
 * second after, and both 1:30 AMs of the 2030 fall-back night.
 */
describe("Phase 13: business date across domains", () => {
  let scenario: KitchenScenario;
  let cashier: Actor;
  let reporter: Actor;
  let auditor: Actor;
  const sales: Sale[] = [];

  const cutoff = localInstant("2030-10-13", "04:00");
  // 2030-11-03 01:30 happens twice in Detroit: 05:30Z (EDT) and 06:30Z (EST).
  const instants: [string, Date, string][] = [
    ["one second before the cutoff", new Date(cutoff.getTime() - 1000), "2030-10-12"],
    ["exactly at the cutoff", cutoff, "2030-10-13"],
    ["one second after the cutoff", new Date(cutoff.getTime() + 1000), "2030-10-13"],
    ["the first 1:30 AM on the fall-back night", new Date("2030-11-03T05:30:00Z"), "2030-11-02"],
    ["the second 1:30 AM on the fall-back night", new Date("2030-11-03T06:30:00Z"), "2030-11-02"],
  ];

  async function sellAt(label: string, instant: Date): Promise<Sale> {
    vi.setSystemTime(instant);

    const order = await createOrder(database(), cashier, { orderType: "TAKEOUT", customerName: label });
    const drafted = await addDraftItem(database(), cashier, order.id, {
      expectedVersion: order.version,
      menuItemId: scenario.burger.menuItem.id,
      quantity: 1,
      selections: scenario.burger.mediumOnly,
      specialInstructions: null,
    });

    await sendOrderItems(database(), cashier, order.id, { expectedVersion: drafted.orderVersion, idempotencyKey: newKey() });

    const opened = await openSettlement(database(), cashier, order.id);

    await tender(database(), cashier, opened.settlementId, { tenderType: "CASH", amount: "15.99", receivedAmount: "15.99" });
    await completeSettlement(database(), cashier, opened.settlementId, {
      expectedVersion: (await settlementRow(database(), opened.settlementId)).version,
      idempotencyKey: newKey(),
    });

    const waste = await recordWaste(database(), scenario.owner, {
      inventoryItemId: scenario.burger.stock.bun.id,
      quantity: "1",
      unitOfMeasureId: scenario.units.each,
      reasonCode: "SPOILAGE",
      notes: null,
    });

    return { label, instant, orderId: order.id, wasteTransactionId: waste.transactionId };
  }

  beforeAll(async () => {
    scenario = await createKitchenScenario(database());
    cashier = await actorWith(database(), scenario, SERVER_SETTLEMENT_PERMISSIONS);
    reporter = await actorWith(database(), scenario, REPORTER_PERMISSIONS);
    auditor = await actorWith(database(), scenario, ["audit.view"]);

    startFakeClock();

    try {
      for (const [label, instant] of instants) {
        sales.push(await sellAt(label, instant));
      }
    } finally {
      stopFakeClock();
    }
  }, 120_000);

  afterAll(async () => {
    stopFakeClock();
    await clearEmployeeData(database());
    await closeDatabase();
  });

  it.each(instants)("stamps one business date everywhere for %s", async (label, instant, expected) => {
    const sale = sales.find((entry) => entry.label === label)!;
    const order = await orderRow(database(), sale.orderId);
    const [item] = await database().select().from(orderItems).where(eq(orderItems.orderId, sale.orderId));
    const consumption = await database()
      .select({ businessDate: inventoryTransactions.businessDate })
      .from(orderItemInventoryConsumption)
      .innerJoin(inventoryTransactions, eq(inventoryTransactions.id, orderItemInventoryConsumption.inventoryTransactionId))
      .where(eq(orderItemInventoryConsumption.orderItemId, item!.id));
    const [settlement] = await database().select().from(settlements).where(eq(settlements.orderId, sale.orderId));
    const [tenderRow] = await database()
      .select()
      .from(settlementTenders)
      .where(eq(settlementTenders.settlementId, settlement!.id));
    const [waste] = await database()
      .select({ businessDate: inventoryTransactions.businessDate })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.id, sale.wasteTransactionId));

    expect(businessDateOf(instant, SETTINGS)).toBe(expected);
    expect({
      order: order.businessDate,
      consumption: [...new Set(consumption.map((entry) => entry.businessDate))],
      settlementOpened: settlement!.openedBusinessDate,
      settlementCompleted: settlement!.completedBusinessDate,
      tender: tenderRow!.businessDate,
      waste: waste!.businessDate,
    }).toEqual({
      order: expected,
      consumption: [expected],
      settlementOpened: expected,
      settlementCompleted: expected,
      tender: expected,
      waste: expected,
    });
  });

  it("reports place each sale on its business date, splitting exactly at the cutoff", async () => {
    const closedOn = async (date: string) => {
      const sales_ = await runReport(database(), reporter, "sales", { locationId: scenario.locationA, from: date, to: date });
      const settled = await runReport(database(), reporter, "settlements", { locationId: scenario.locationA, from: date, to: date });
      const summary = sales_.sections.find((section) => section.key === "summary")!.rows.find((row) => row.orderType === "All")!;
      const tenders = settled.sections.find((section) => section.key === "tenders")!.rows.find((row) => row.tenderType === "All")!;

      return { closedOrders: summary.closedOrders, netSales: summary.netSales, tenders: tenders.amount };
    };

    expect(await closedOn("2030-10-12")).toEqual({ closedOrders: 1, netSales: "15.99", tenders: "15.99" });
    expect(await closedOn("2030-10-13")).toEqual({ closedOrders: 2, netSales: "31.98", tenders: "31.98" });
    // The 25-hour fall-back business date holds both 1:30 AM sales.
    expect(await closedOn("2030-11-02")).toEqual({ closedOrders: 2, netSales: "31.98", tenders: "31.98" });
    expect(await closedOn("2030-11-03")).toEqual({ closedOrders: 0, netSales: "0.00", tenders: "0.00" });

    const inventory = await runReport(database(), reporter, "inventory", {
      locationId: scenario.locationA,
      from: "2030-10-12",
      to: "2030-10-12",
    });
    const bun = inventory.sections.find((section) => section.key === "usage")!.rows.find((row) => row.name === "Brioche bun")!;

    expect(bun).toMatchObject({ theoretical: "1.0000", waste: "1.0000" });
  });

  it("the audit viewer's business-date filter agrees with the records", async () => {
    const completedOn = async (date: string) =>
      (
        await listAuditEvents(database(), auditor, {
          locationId: scenario.locationA,
          from: date,
          to: date,
          action: "settlements.completed",
        })
      ).events.length;
    const wasteOn = async (date: string) =>
      (
        await listAuditEvents(database(), auditor, {
          locationId: scenario.locationA,
          from: date,
          to: date,
          action: "inventory.waste-recorded",
        })
      ).events.length;

    expect([await completedOn("2030-10-12"), await completedOn("2030-10-13")]).toEqual([1, 2]);
    expect([await wasteOn("2030-11-02"), await wasteOn("2030-11-03")]).toEqual([2, 0]);
  });

  it("orders and audit agree on which instants a business date covers", async () => {
    const all = await database()
      .select({ orderId: settlements.orderId, completedAt: settlements.completedAt, date: settlements.completedBusinessDate })
      .from(settlements)
      .where(and(eq(settlements.locationId, scenario.locationA), eq(settlements.status, "COMPLETED")));

    for (const settlement of all) {
      expect(settlement.date).toBe(businessDateOf(settlement.completedAt!, SETTINGS));
    }

    expect(all).toHaveLength(instants.length);
  });
});
