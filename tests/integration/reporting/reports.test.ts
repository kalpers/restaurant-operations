import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryBalances, menuItemPrices, orders } from "@/db/schema";
import { withReadOnlySnapshot } from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import type { Actor } from "@/modules/auth/types";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { markItemOut, restoreItem } from "@/modules/menu/services/outage-service";
import {
  buildDashboard,
  exportReportCsv,
  runReport,
} from "@/modules/reporting/services/report-service";
import { REPORT_AREAS, type ReportArea, type ReportResult } from "@/modules/reporting/types";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { actorWith } from "../../fixtures/employee-fixtures";
import { supplierWith } from "../../fixtures/inventory-fixtures";
import {
  createKitchenScenario,
  sendOrder,
  ticketItemsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import { clearOrderData, itemRows, newKey } from "../../fixtures/order-fixtures";
import {
  SERVER_SETTLEMENT_PERMISSIONS,
  settlementRow,
  tender,
} from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

const ALL_REPORTS: readonly PermissionCode[] = [
  "reports.view",
  "reports.sales",
  "reports.orders",
  "reports.inventory",
  "reports.fulfillment",
  "reports.labor",
  "reports.settlements",
  "reports.seating",
  "reports.tips",
  "reports.export",
];

/** What the Manager role holds for reporting: no labor, no export (tips since Phase 18). */
const MANAGER_REPORTS: readonly PermissionCode[] = [
  "reports.view",
  "reports.sales",
  "reports.orders",
  "reports.inventory",
  "reports.fulfillment",
  "reports.settlements",
  "reports.seating",
  "reports.tips",
];

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code}`;
  }

  return undefined;
}

function section(report: ReportResult, key: string) {
  const found = report.sections.find((candidate) => candidate.key === key);

  expect(found, `section ${key}`).toBeDefined();

  return found!;
}

function row(report: ReportResult, sectionKey: string, column: string, value: unknown) {
  const found = section(report, sectionKey).rows.find((candidate) => candidate[column] === value);

  expect(found, `${sectionKey} row ${column}=${String(value)}`).toBeDefined();

  return found!;
}

async function settle(
  actor: Actor,
  orderId: string,
  tenderInput: Parameters<typeof tender>[3],
) {
  const { settlementId } = await openSettlement(database(), actor, orderId);

  await tender(database(), actor, settlementId, tenderInput);

  const { version } = await settlementRow(database(), settlementId);

  return completeSettlement(database(), actor, settlementId, { expectedVersion: version, idempotencyKey: newKey() });
}

async function advance(actor: Actor, ticketItemId: string, actions: readonly ("start" | "ready" | "complete")[]) {
  for (const action of actions) {
    const [current] = await database().execute<{ version: number }>(
      sql`SELECT version FROM kitchen_ticket_items WHERE id = ${ticketItemId}`,
    );

    await transitionTicketItem(database(), actor, ticketItemId, action, { expectedVersion: current!.version });
  }
}

/** A fingerprint of every table reporting reads, to prove reports write nothing. */
async function fingerprint(): Promise<Record<string, string>> {
  const tables = [
    "orders",
    "order_items",
    "order_item_modifiers",
    "order_status_history",
    "order_item_inventory_consumption",
    "order_settlements",
    "settlement_tenders",
    "inventory_transactions",
    "inventory_balances",
    "kitchen_tickets",
    "kitchen_ticket_items",
    "table_sessions",
    "reservations",
    "waitlist_entries",
    "shifts",
    "shift_assignments",
    "schedule_periods",
    "employee_position_compensation",
    "outbox_events",
    "idempotency_records",
  ];
  const result: Record<string, string> = {};

  for (const table of tables) {
    const [hash] = await database().execute<{ digest: string | null; rows: number }>(
      sql`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS digest, COUNT(*)::int AS rows
          FROM ${sql.identifier(table)} t`,
    );

    result[table] = `${hash!.rows}:${hash!.digest}`;
  }

  return result;
}

describe("reporting", () => {
  let scenario: KitchenScenario;
  let reporter: Actor;
  let today: string;

  const filters = () => ({ locationId: scenario.locationA, from: today, to: today });
  const report = (area: ReportArea, actor: Actor = reporter, extra: object = {}) =>
    runReport(database(), actor, area, { ...filters(), ...extra });

  beforeAll(async () => {
    scenario = await createKitchenScenario(database());
    reporter = await actorWith(database(), scenario, [...ALL_REPORTS, "inventory.cost.view", "hr.compensation.view"]);

    const cashier = await actorWith(database(), scenario, SERVER_SETTLEMENT_PERMISSIONS);
    const burger = scenario.burger;

    // A: dine-in canonical Bacon Cheeseburger (17.49) + fries (4.50), cash with a 3.00 tip.
    const a = await sendOrder(database(), scenario, [
      { menuItemId: burger.menuItem.id, selections: burger.canonicalSelections },
      { menuItemId: scenario.fries.id },
    ]);
    const aItems = await ticketItemsForOrder(database(), a.order.id);
    const burgerTicketItem = aItems.find((item) => item.menuItemNameSnapshot === "Bacon Cheeseburger")!;
    const friesTicketItem = aItems.find((item) => item.menuItemNameSnapshot === "Fries")!;

    await advance(scenario.cook, burgerTicketItem.id, ["start", "ready", "complete"]);
    await advance(scenario.cook, friesTicketItem.id, ["start", "ready"]);
    await settle(cashier, a.order.id, { tenderType: "CASH", amount: "21.99", receivedAmount: "25.00", tipAmount: "3.00" });

    // B: takeout margarita (11.00), external card with a 2.00 tip.
    const b = await sendOrder(database(), scenario, [{ menuItemId: scenario.cocktail.id }], { orderType: "TAKEOUT" });

    await settle(cashier, b.order.id, {
      tenderType: "EXTERNAL_CARD",
      amount: "11.00",
      tipAmount: "2.00",
      providerName: "Square",
      cardBrand: "Visa",
      cardLastFour: "4242",
    });

    // C: dine-in fries, left open.
    await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }]);

    // D: takeout fries + margarita; the margarita is voided before the bar starts it.
    const d = await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }, { menuItemId: scenario.cocktail.id }], {
      orderType: "TAKEOUT",
    });
    const margarita = (await itemRows(database(), d.order.id)).find((item) => item.menuItemNameSnapshot === "Margarita")!;
    const [dOrder] = await database().select().from(orders).where(eq(orders.id, d.order.id));

    await voidOrderItem(database(), scenario.voidManager, d.order.id, margarita.id, {
      reason: "Guest changed mind",
      disposition: "UNPREPARED",
      expectedVersion: dOrder!.version,
    });

    // A supplier cost recorded today, for the supplier cost section.
    await supplierWith(database(), scenario.owner, [
      { inventoryItemId: burger.stock.swiss.id, purchaseUnitId: scenario.units.each, lastUnitCost: "0.2500" },
    ]);

    const [aOrder] = await database().select().from(orders).where(eq(orders.id, a.order.id));

    today = aOrder!.businessDate;
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  it("reports sales from CLOSED orders, with open checks and voids apart", async () => {
    const sales = await report("sales");
    const all = row(sales, "summary", "orderType", "All");

    expect(all).toMatchObject({
      closedOrders: 2,
      covers: 2,
      grossSales: "32.99",
      discounts: "0.00",
      comps: "0.00",
      netSales: "32.99",
      averageCheck: "16.50",
      openChecks: 2,
      openAmount: "9.00",
      voidedOrders: 0,
      voidedItems: 1,
      voidedAmount: "11.00",
    });
    expect(row(sales, "summary", "orderType", "Takeout")).toMatchObject({ closedOrders: 1, netSales: "11.00", covers: 0 });
    expect(row(sales, "daily", "businessDate", today)).toMatchObject({ netSales: "32.99" });
  });

  it("reconciles net sales exactly to completed settlement tenders", async () => {
    const sales = await report("sales");
    const settlements = await report("settlements");
    const tenders = row(settlements, "tenders", "tenderType", "All");

    expect(tenders.amount).toBe(row(sales, "summary", "orderType", "All").netSales);
    expect(tenders).toMatchObject({ tenders: 2, amount: "32.99", tips: "5.00", received: "25.00", change: "0.01" });
    expect(row(settlements, "tenders", "tenderType", "Cash")).toMatchObject({ amount: "21.99", tips: "3.00" });
    expect(row(settlements, "tenders", "tenderType", "Card (external)")).toMatchObject({ amount: "11.00", tips: "2.00" });
    expect(row(settlements, "daily", "businessDate", today)).toMatchObject({ completed: 2, amount: "32.99", tips: "5.00" });
  });

  it("filters tenders by type", async () => {
    const cashOnly = await report("settlements", reporter, { tenderType: "CASH" });

    expect(row(cashOnly, "tenders", "tenderType", "All")).toMatchObject({ tenders: 1, amount: "21.99" });
  });

  it("never exposes card metadata", async () => {
    const settlements = await report("settlements");
    const text = JSON.stringify(settlements);

    expect(text).not.toContain("4242");
    expect(text).not.toContain("Square");
  });

  it("costs the canonical Bacon Cheeseburger from its SEND consumption snapshot", async () => {
    const menu = await report("menu");

    // Beef 8 oz 0.80 + bun 0.10 + Swiss 0.10 + pickles 5 × 0.10 + bacon 2 × 0.10; no American, no onion.
    expect(row(menu, "items", "name", "Bacon Cheeseburger")).toMatchObject({
      quantity: 1,
      grossSales: "17.49",
      itemDiscounts: "0.00",
      theoreticalCost: "1.7000",
      margin: "15.79",
      costPercent: "9.72",
    });
    expect(row(menu, "items", "name", "Fries")).toMatchObject({ quantity: 1, grossSales: "4.50", theoreticalCost: null });
    expect(row(menu, "modifiers", "modifier", "Extra Pickles")).toMatchObject({ quantity: 1, revenue: "0.50" });
    expect(row(menu, "modifiers", "modifier", "Swiss instead of American")).toMatchObject({ revenue: "1.00" });
  });

  it("reports inventory usage from the ledger, with the period-end quantity", async () => {
    const inventory = await report("inventory");
    const swiss = row(inventory, "usage", "name", "Swiss cheese");
    const beef = row(inventory, "usage", "name", "Ground beef");

    expect(swiss).toMatchObject({ theoretical: "1.0000", closing: "99.0000", theoreticalCost: "0.1000", waste: "0.0000" });
    expect(beef).toMatchObject({ unit: "OZ_WEIGHT", theoretical: "8.0000", closing: "92.0000", theoreticalCost: "0.8000" });
    // American cheese was received but none was consumed.
    expect(row(inventory, "usage", "name", "American cheese")).toMatchObject({ received: "100.0000", theoretical: "0.0000" });
  });

  it("lists supplier cost changes recorded in the range", async () => {
    const inventory = await report("inventory");

    expect(row(inventory, "supplier-costs", "itemName", "Swiss cheese")).toMatchObject({
      unitCost: "0.2500",
      previousCost: null,
      recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    });
  });

  it("reports order lifecycle, servers and voids", async () => {
    const report_ = await report("orders");

    expect(row(report_, "lifecycle", "orderType", "All")).toMatchObject({ total: 4, open: 2, closed: 2, voided: 0 });
    expect(row(report_, "voids", "reason", "Guest changed mind")).toMatchObject({
      disposition: "Unprepared (stock returned)",
      quantity: 1,
      amount: "11.00",
    });
    expect(row(report_, "servers", "server", "Unassigned")).toMatchObject({ closed: 2, netSales: "32.99" });
  });

  it("reports station performance from fulfillment history", async () => {
    const fulfillment = await report("fulfillment");
    const grill = row(fulfillment, "stations", "station", "Grill");
    const all = row(fulfillment, "stations", "station", "All stations");

    expect(grill).toMatchObject({ items: 1, completed: 1, cancelled: 0, late: 0 });
    expect(typeof grill.readyAverage).toBe("number");
    // A burger + A fries + B margarita + C fries + D fries; D's margarita was cancelled.
    expect(all).toMatchObject({ items: 5, completed: 1, cancelled: 1 });
  });

  it("reports seating from Table Session history", async () => {
    const seating = await report("seating");

    expect(row(seating, "sessions", "area", "All areas")).toMatchObject({ sessions: 2, covers: 4, tablesUsed: 2, turns: "1.00" });
  });

  it("does not recalculate history from current configuration", async () => {
    const before = await Promise.all((["sales", "menu", "inventory", "settlements"] as const).map((area) => report(area)));

    // Change the burger's price and every stocked item's average cost after the facts.
    await database().update(menuItemPrices).set({ price: "99.99" }).where(eq(menuItemPrices.menuItemId, scenario.burger.menuItem.id));
    await database()
      .update(inventoryBalances)
      .set({ weightedAverageCost: "9.9999" })
      .where(eq(inventoryBalances.locationId, scenario.locationA));

    const after = await Promise.all((["sales", "menu", "inventory", "settlements"] as const).map((area) => report(area)));

    expect(after).toEqual(before);
  });

  it("writes nothing: every report and export leaves every table unchanged", async () => {
    const before = await fingerprint();

    for (const area of REPORT_AREAS) {
      await report(area);
      await exportReportCsv(database(), reporter, area, filters());
    }

    await buildDashboard(database(), reporter, scenario.locationA, today);

    expect(await fingerprint()).toEqual(before);
  });

  it("runs reports in a transaction PostgreSQL keeps read-only", async () => {
    const attempt = withReadOnlySnapshot(database(), (tx) =>
      tx.execute(sql`UPDATE orders SET customer_name = customer_name WHERE id = ${scenario.locationA}`),
    );

    // 25006: read_only_sql_transaction
    expect(await codeOf(attempt)).toBe("DB:25006");
  });

  it("exports CSV with a header and the report's sections", async () => {
    const { fileName, csv } = await exportReportCsv(database(), reporter, "sales", filters(), "summary");

    expect(fileName).toMatch(new RegExp(`^sales_summary_.+_${today}_${today}\\.csv$`));
    expect(csv).toContain("Report,Sales\r\n");
    expect(csv).toContain(`Business dates,${today} to ${today}\r\n`);
    expect(csv).toContain("Order type,Closed orders,Covers,Gross sales");
    expect(csv).toMatch(/\r\nAll,2,2,32\.99,0\.00,0\.00,32\.99,0\.00,16\.50,2,9\.00,0,1,11\.00\r\n/);
    expect(await codeOf(exportReportCsv(database(), reporter, "sales", filters(), "nope"))).toBe("NOT_FOUND");
  });

  it("builds the dashboard for permitted areas only", async () => {
    const manager = await actorWith(database(), scenario, MANAGER_REPORTS);
    const dashboard = await buildDashboard(database(), manager, scenario.locationA, today);
    const areas = dashboard.groups.map((group) => group.area);

    expect(areas).not.toContain("labor");
    expect(areas).not.toContain("menu");
    expect(dashboard.groups.find((group) => group.area === "sales")!.tiles.find((tile) => tile.key === "netSales")!.value).toBe(
      "32.99",
    );
    // Inventory cost is withheld without inventory.cost.view.
    expect(dashboard.groups.find((group) => group.area === "inventory")!.tiles.map((tile) => tile.key)).not.toContain("wasteCost");
  });

  describe("Phase 19 sections", () => {
    const sum = (values: (string | number | null | undefined)[]) =>
      values.reduce<number>((total, value) => total + Math.round(Number(value ?? 0) * 100), 0) / 100;

    it("lays sales out by the hour opened, every hour shown, matching net sales", async () => {
      const sales = await report("sales");
      const hours = section(sales, "salesByHour");

      expect(hours.rows).toHaveLength(24);
      expect(hours.rows[0]!.hour).toBe("04:00–04:59");
      expect(sum(hours.rows.map((entry) => entry.closedOrders))).toBe(2);
      expect(sum(hours.rows.map((entry) => entry.netSales))).toBe(32.99);
    });

    it("reports item mix across the whole menu, and menu engineering only with cost", async () => {
      const menu = await report("menu");
      const mix = section(menu, "itemMix");

      expect(mix.rows.map((entry) => entry.quantityPercent)).toEqual(["33.33", "33.33", "33.33"]);
      expect(sum(mix.rows.map((entry) => entry.netSales))).toBe(32.99);
      expect(section(menu, "menuEngineering").rows.find((entry) => entry.name === "Bacon Cheeseburger")?.class).toMatch(
        /Star|Plowhorse|Puzzle|Dog/,
      );

      const noCost = await actorWith(database(), scenario, ["reports.view", "reports.sales"]);
      const plain = await report("menu", noCost);

      expect(plain.sections.map((entry) => entry.key)).not.toContain("menuEngineering");
    });

    it("adds server performance, with tips only for tip viewers", async () => {
      const orders = await report("orders");
      const servers = section(orders, "serverPerformance");

      expect(sum(servers.rows.map((entry) => entry.checks))).toBe(2);
      expect(servers.columns.map((column) => column.key)).toContain("tips");
      expect(sum(servers.rows.map((entry) => entry.tips))).toBe(5);

      const noTips = await actorWith(database(), scenario, ["reports.view", "reports.orders"]);
      const hidden = section(await report("orders", noTips), "serverPerformance");

      expect(hidden.columns.map((column) => column.key)).not.toContain("tips");
      expect(hidden.rows.every((entry) => !("tips" in entry))).toBe(true);
    });

    it("lists voids, comps and discounts by the person who did them", async () => {
      const adjustments = section(await report("orders"), "adjustmentsByEmployee");

      expect(sum(adjustments.rows.map((entry) => entry.voids))).toBe(1);
      expect(sum(adjustments.rows.map((entry) => entry.voidAmount))).toBe(11);
      expect(adjustments.rows.find((entry) => entry.voids === 1)?.reasons).toBe("Guest changed mind");
    });

    it("keeps the Phase 12 sections exactly as they were, ahead of the new ones", async () => {
      expect((await report("orders")).sections.map((entry) => entry.key).slice(-2)).toEqual([
        "serverPerformance",
        "adjustmentsByEmployee",
      ]);
      expect((await report("sales")).sections.at(-1)!.key).toBe("salesByHour");
    });

    it("shows 86 history in the inventory area", async () => {
      const cook = await actorWith(database(), scenario, ["menu.availability.manage"]);
      const outage = await markItemOut(database(), cook, { menuItemId: scenario.fries.id, reason: "Fryer down" });

      await restoreItem(database(), cook, { outageId: outage.id, expectedVersion: outage.version });

      const history = section(await report("inventory"), "eightySixHistory");
      const entry = history.rows.find((candidate) => candidate.reason === "Fryer down");

      expect(entry).toMatchObject({ kind: "86", name: "Fries" });
      expect(entry!.ended).not.toBe("Still 86'd");
    });
  });

  describe("authorization", () => {
    it("needs reports.view and the area permission", async () => {
      const noView = await actorWith(database(), scenario, ["reports.sales"]);
      const viewOnly = await actorWith(database(), scenario, ["reports.view"]);

      expect(await codeOf(report("sales", noView))).toBe("PERMISSION_DENIED");
      expect(await codeOf(report("sales", viewOnly))).toBe("PERMISSION_DENIED");
      expect(await codeOf(buildDashboard(database(), noView, scenario.locationA))).toBe("PERMISSION_DENIED");
    });

    it("checks each area against its own permission", async () => {
      for (const area of REPORT_AREAS) {
        const permission = area === "menu" ? "reports.sales" : (`reports.${area}` as PermissionCode);
        const holder = await actorWith(database(), scenario, ["reports.view", permission]);

        expect(await codeOf(report(area, holder))).toBeUndefined();

        for (const other of REPORT_AREAS.filter((candidate) => !(candidate === area || (area === "menu" ? candidate === "sales" : area === "sales" && candidate === "menu")))) {
          expect(await codeOf(report(other, holder)), `${permission} opening ${other}`).toBe("PERMISSION_DENIED");
        }
      }
    });

    it("refuses labor and export to the Manager grants", async () => {
      const manager = await actorWith(database(), scenario, MANAGER_REPORTS);

      expect(await codeOf(report("labor", manager))).toBe("PERMISSION_DENIED");
      expect(await codeOf(exportReportCsv(database(), manager, "sales", filters()))).toBe("PERMISSION_DENIED");
      expect(await codeOf(report("sales", manager))).toBeUndefined();
    });

    it("export needs the area permission too", async () => {
      const exporter = await actorWith(database(), scenario, ["reports.view", "reports.export", "reports.seating"]);

      expect(await codeOf(exportReportCsv(database(), exporter, "sales", filters()))).toBe("PERMISSION_DENIED");
      expect(await codeOf(exportReportCsv(database(), exporter, "seating", filters()))).toBeUndefined();
    });

    it("is location-scoped", async () => {
      expect(await codeOf(report("sales", reporter, { locationId: scenario.locationB }))).toBe("PERMISSION_DENIED");

      const atB = await actorWith(database(), scenario, ALL_REPORTS, scenario.locationB);
      const salesAtB = await runReport(database(), atB, "sales", { locationId: scenario.locationB, from: today, to: today });

      expect(row(salesAtB, "summary", "orderType", "All")).toMatchObject({ closedOrders: 0, netSales: "0.00" });
      expect(await codeOf(runReport(database(), atB, "sales", filters()))).toBe("PERMISSION_DENIED");
    });

    it("hides cost columns without inventory.cost.view", async () => {
      const salesOnly = await actorWith(database(), scenario, ["reports.view", "reports.sales", "reports.inventory"]);
      const menu = await report("menu", salesOnly);
      const inventory = await report("inventory", salesOnly);

      expect(section(menu, "items").columns.map((column) => column.key)).not.toContain("theoreticalCost");
      expect(row(menu, "items", "name", "Bacon Cheeseburger")).not.toHaveProperty("theoreticalCost");
      expect(JSON.stringify(inventory)).not.toMatch(/[Cc]ost"/);
      expect(inventory.sections.map((candidate) => candidate.key)).not.toContain("supplier-costs");
      expect(menu.notes.join(" ")).toMatch(/cost/i);
    });

    it("validates the date range", async () => {
      expect(await codeOf(report("sales", reporter, { from: "2030-01-02", to: "2030-01-01" }))).toBe("VALIDATION_FAILED");
      expect(await codeOf(report("sales", reporter, { from: "2030-01-01", to: "2030-06-01" }))).toBe("VALIDATION_FAILED");
    });
  });
});
