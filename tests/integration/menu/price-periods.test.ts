import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, orderItems, pricePeriods } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { resolveMenuItemPrice } from "@/modules/menu/services/pricing-service";
import {
  createPricePeriod,
  deactivatePricePeriod,
  listPricePeriods,
  updatePricePeriod,
  type PricePeriodInput,
} from "@/modules/menu/services/price-period-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { localMinutesOf } from "@/shared/time/zoned-time";
import { runReport } from "@/modules/reporting/services/report-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { businessDateOf } from "@/shared/time/business-date-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  clearOrderData,
  itemRows,
  newKey,
  orderRow,
  plainItem,
  SERVER_ORDER_PERMISSIONS,
} from "../../fixtures/order-fixtures";
import {
  createSettlementScenario,
  settlementRow,
  tender,
  type SettlementScenario,
} from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();
const ZONE = "America/Detroit";
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

/** "HH:MM" local, `offsetMinutes` from now, wrapping round midnight. */
function localClock(offsetMinutes: number): string {
  const minutes = (((localMinutesOf(new Date(), ZONE) + offsetMinutes) % 1440) + 1440) % 1440;

  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function periodInput(menuItemId: string, overrides: Partial<PricePeriodInput> = {}): PricePeriodInput {
  return {
    name: "Happy hour",
    daysOfWeek: ALL_DAYS,
    startTime: localClock(-60),
    endTime: localClock(60),
    orderTypes: null,
    firstDate: null,
    lastDate: null,
    items: [{ menuItemId, price: "4.00" }],
    ...overrides,
  };
}

describe("price periods (Phase 28)", () => {
  let scenario: SettlementScenario;
  let pricing: Actor;
  let server: Actor;
  let beer: { id: string };

  beforeEach(async () => {
    scenario = await createSettlementScenario(database());
    pricing = await actorWith(database(), scenario, ["menu.pricing.view", "menu.pricing.edit"]);
    server = await actorWith(database(), scenario, SERVER_ORDER_PERMISSIONS);
    beer = await plainItem(database(), scenario.owner, "6.00", "Draft beer");
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function sendOne(orderType: "TAKEOUT" | "BAR" = "TAKEOUT", actor = server) {
    const order = await createOrder(database(), actor, { orderType: "TAKEOUT" });
    const added = await addDraftItem(database(), actor, order.id, {
      menuItemId: beer.id,
      quantity: 2,
      selections: [],
      specialInstructions: null,
      expectedVersion: order.version,
    });
    const key = newKey();
    const sent = await sendOrderItems(database(), actor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: key,
    });

    return { order, key, sent, orderType, sentVersion: added.orderVersion };
  }

  it("sells at the period price at SEND and snapshots the period and the regular price", async () => {
    const period = await createPricePeriod(database(), pricing, periodInput(beer.id));
    const { order, key, sentVersion } = await sendOne();
    const [item] = await itemRows(database(), order.id);

    expect(item).toMatchObject({
      status: "SUBMITTED",
      basePriceSnapshot: "4.00",
      lineTotalSnapshot: "8.00",
      pricePeriodId: period.id,
      pricePeriodNameSnapshot: "Happy hour",
      regularPriceSnapshot: "6.00",
    });
    expect((await orderRow(database(), order.id)).subtotal).toBe("8.00");

    // The same idempotency key replays the first outcome and writes nothing new.
    const replay = await sendOrderItems(database(), server, order.id, {
      expectedVersion: sentVersion,
      idempotencyKey: key,
    });

    expect(replay.replayed).toBe(true);
    expect(await itemRows(database(), order.id)).toHaveLength(1);
  });

  it("shows the period on the draft, and re-prices at SEND when the period has ended", async () => {
    const period = await createPricePeriod(database(), pricing, periodInput(beer.id));
    const order = await createOrder(database(), server, { orderType: "TAKEOUT" });
    const added = await addDraftItem(database(), server, order.id, {
      menuItemId: beer.id,
      quantity: 1,
      selections: [],
      specialInstructions: null,
      expectedVersion: order.version,
    });

    expect((await itemRows(database(), order.id))[0]).toMatchObject({ basePriceSnapshot: "4.00", pricePeriodId: null });

    // The manager ends happy hour before the round is sent: SEND uses the price at SEND.
    const [current] = await database().select().from(pricePeriods).where(eq(pricePeriods.id, period.id));

    await updatePricePeriod(database(), pricing, period.id, {
      ...periodInput(beer.id, { startTime: localClock(-120), endTime: localClock(-60) }),
      expectedVersion: current!.version,
    });
    await sendOrderItems(database(), server, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });

    expect((await itemRows(database(), order.id))[0]).toMatchObject({
      basePriceSnapshot: "6.00",
      pricePeriodId: null,
      pricePeriodNameSnapshot: null,
      regularPriceSnapshot: null,
    });
  });

  it("applies only to the order types it names", async () => {
    await createPricePeriod(database(), pricing, periodInput(beer.id, { orderTypes: ["BAR"] }));
    const { order } = await sendOne("TAKEOUT");

    expect((await itemRows(database(), order.id))[0]).toMatchObject({ basePriceSnapshot: "6.00", pricePeriodId: null });

    const forBar = await getOperationalMenu(database(), server, new Date(), { orderType: "BAR" });
    const barItem = forBar.menus.flatMap((menu) => menu.categories.flatMap((category) => category.items)).find(
      (item) => item.menuItemId === beer.id,
    );

    expect(barItem).toMatchObject({ price: "4.00", regularPrice: "6.00", pricePeriod: { name: "Happy hour" } });

    const quote = await resolveMenuItemPrice(database(), scenario.organizationId, beer.id, scenario.locationA, new Date(), "BAR");

    expect(quote).toMatchObject({ price: "4.00", regularPrice: "6.00" });
    expect(await resolveMenuItemPrice(database(), scenario.organizationId, beer.id, scenario.locationA, new Date())).toMatchObject({
      price: "6.00",
      pricePeriod: null,
    });
  });

  it("refuses an overlapping period for the same item and order type, and allows a separate one", async () => {
    await createPricePeriod(database(), pricing, periodInput(beer.id, { orderTypes: ["BAR"] }));

    await expect(createPricePeriod(database(), pricing, periodInput(beer.id, { name: "Late" }))).rejects.toMatchObject({
      code: "PRICE_PERIOD_OVERLAP",
    });
    await expect(
      createPricePeriod(database(), pricing, periodInput(beer.id, { name: "Takeout deal", orderTypes: ["TAKEOUT"] })),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("checks the version, audits each change, and deactivates instead of deleting", async () => {
    const period = await createPricePeriod(database(), pricing, periodInput(beer.id));

    await expect(
      updatePricePeriod(database(), pricing, period.id, { ...periodInput(beer.id), expectedVersion: period.version + 5 }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });

    const deactivated = await deactivatePricePeriod(database(), pricing, period.id, { expectedVersion: period.version });
    const listed = await listPricePeriods(database(), pricing);

    expect(deactivated.version).toBe(period.version + 1);
    expect(listed.find((entry) => entry.id === period.id)).toMatchObject({ active: false });
    await expect(database().delete(pricePeriods).where(eq(pricePeriods.id, period.id))).rejects.toThrow();

    const audits = await database()
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(and(eq(auditEvents.entityId, period.id)));

    expect(audits.map((row) => row.action).sort()).toEqual([
      "menu.price-period-created",
      "menu.price-period-deactivated",
    ]);

    // A deactivated period never prices anything.
    const { order } = await sendOne();

    expect((await itemRows(database(), order.id))[0]).toMatchObject({ basePriceSnapshot: "6.00", pricePeriodId: null });
  });

  it("needs menu.pricing.edit to change periods and menu.pricing.view to list them", async () => {
    await expect(createPricePeriod(database(), server, periodInput(beer.id))).rejects.toMatchObject({
      name: "AuthorizationError",
    });
    await expect(listPricePeriods(database(), server)).rejects.toMatchObject({ name: "AuthorizationError" });
  });

  it("freezes the period snapshots on a sent item", async () => {
    await createPricePeriod(database(), pricing, periodInput(beer.id));
    const { order } = await sendOne();
    const [item] = await itemRows(database(), order.id);

    await expect(
      database().update(orderItems).set({ regularPriceSnapshot: "1.00" }).where(eq(orderItems.id, item!.id)),
    ).rejects.toThrow();
  });

  it("reports what each period sold and gave away, from the snapshots of closed checks", async () => {
    const period = await createPricePeriod(database(), pricing, periodInput(beer.id));
    const { order } = await sendOne("TAKEOUT", scenario.cashier);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: "8.00" });
    await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: (await settlementRow(database(), settlementId)).version,
      idempotencyKey: newKey(),
    });

    // Deactivating the period afterwards changes nothing already sold.
    await deactivatePricePeriod(database(), pricing, period.id, { expectedVersion: period.version });

    const reporter = await actorWith(database(), scenario, ["reports.view", "reports.sales"]);
    const today = businessDateOf(new Date(), { timeZone: ZONE, businessDayCutoff: "04:00" });
    const report = await runReport(database(), reporter, "sales", { locationId: scenario.locationA, from: today, to: today });
    const section = report.sections.find((entry) => entry.key === "pricePeriods");

    expect(section?.rows).toEqual([
      { businessDate: today, period: "Happy hour", items: 2, sales: "8.00", regular: "12.00", difference: "4.00" },
    ]);
  });
});
