import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  auditEvents,
  inventoryTransactions,
  purchaseOrderLines,
  purchaseOrders,
  purchasingForecastItems,
  purchasingForecastLines,
  purchasingForecasts,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getItemConfiguration, setItemLocation } from "@/modules/inventory/services/item-service";
import { previewSuggestedOrders } from "@/modules/inventory/services/suggested-order-service";
import { getItemSalesHistory } from "@/modules/orders/queries/item-sales-history";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { runReport } from "@/modules/reporting/services/report-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { buildItemForecast, getPrepList } from "@/workflows/forecast-items/forecast-items";
import {
  createForecastSuggestedOrders,
  previewForecastSuggestedOrders,
} from "@/workflows/forecast-items/forecast-suggested-orders";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith, clearEmployeeData } from "../../fixtures/employee-fixtures";
import { closedItemsCheckAt } from "../../fixtures/forecast-history";
import { stockedItem, supplierWith } from "../../fixtures/inventory-fixtures";
import { baconCheeseburger, clearOrderData, newKey, plainItem, type Burger } from "../../fixtures/order-fixtures";
import { at, startFakeClock, stopFakeClock } from "../../fixtures/restaurant-day";
import { createSettlementScenario, type SettlementScenario } from "../../fixtures/settlement-fixtures";

// Phase 25: item forecast, ingredient forecast, prep list and forecast-based suggested orders.
// Fridays in 2030: 02-15, 02-22 and 03-01 have history; the target is Friday 03-08. "Today" is
// Monday 03-04 at 10:00 in Detroit, so Monday to Thursday have no history of their own.

const database = () => getDatabase();
const TODAY = "2030-03-04";
const FRIDAY = "2030-03-08";

describe("prep and purchasing forecast (Phase 25)", () => {
  let scenario: SettlementScenario;
  let owner: Actor;
  let burger: Burger;
  let sodaId: string;

  beforeAll(async () => {
    startFakeClock();
    at("2030-02-01", "10:00");
    scenario = await createSettlementScenario(database());
    owner = scenario.owner;
    burger = await baconCheeseburger(database(), scenario);
    sodaId = (await plainItem(database(), owner, "3.00", "Soda")).id;

    const { temperature, toppings } = burger.groups;
    const { medium, extraPickles, noOnion, swissInstead } = burger.modifiers;
    const pick = (groupId: string, modifierId: string) => ({ modifierGroupId: groupId, modifierId });
    const burgerLine = (quantity: number, ...extras: string[]) => ({
      menuItemId: burger.menuItem.id,
      quantity,
      selections: [pick(temperature.id, medium.id), ...extras.map((id) => pick(toppings.id, id))],
    });

    // 03-01: 3 burgers (2 with Extra Pickles, 1 with No Onion).
    await closedItemsCheckAt(database(), scenario, {
      date: "2030-03-01",
      time: "19:00",
      lines: [burgerLine(2, extraPickles.id), burgerLine(1, noOnion.id)],
    });
    // 02-22: 2 burgers (1 with Extra Pickles) and 4 sodas.
    await closedItemsCheckAt(database(), scenario, {
      date: "2030-02-22",
      time: "19:00",
      lines: [burgerLine(1, extraPickles.id), burgerLine(1), { menuItemId: sodaId, quantity: 4 }],
    });
    // 02-15: 1 burger, Swiss instead of American.
    await closedItemsCheckAt(database(), scenario, {
      date: "2030-02-15",
      time: "19:00",
      lines: [burgerLine(1, swissInstead.id)],
    });

    at(TODAY, "10:00");
  }, 240_000);

  afterAll(async () => {
    stopFakeClock();
    await clearEmployeeData(database());
    await clearOrderData(database());
    await closeDatabase();
  });

  const forecastFor = async (date: string) =>
    (
      await buildItemForecast(database(), {
        organizationId: owner.organizationId,
        locationId: scenario.locationA,
        fromDate: date,
        toDate: date,
      })
    ).days[0]!;

  describe("item history", () => {
    it("equals the item-mix report's quantities for each date", async () => {
      const history = await getItemSalesHistory(database(), {
        locationId: scenario.locationA,
        fromDate: "2030-02-15",
        toDate: "2030-03-01",
      });

      for (const date of ["2030-02-15", "2030-02-22", "2030-03-01"]) {
        const menu = await runReport(database(), owner, "menu", { locationId: scenario.locationA, from: date, to: date });
        const mix = menu.sections.find((section) => section.key === "itemMix")!;
        const fromReport = Object.fromEntries(mix.rows.map((row) => [row.name, row.quantity]));
        const fromHistory = Object.fromEntries(
          history.items
            .filter((row) => row.businessDate === date)
            .map((row) => [row.menuItemId === burger.menuItem.id ? "Bacon Cheeseburger" : "Soda", row.portions]),
        );

        expect(fromHistory).toEqual(fromReport);
      }

      expect(history.openDates).toEqual(["2030-02-15", "2030-02-22", "2030-03-01"]);
      expect(history.firstSaleDates.get(burger.menuItem.id)).toBe("2030-02-15");
    });
  });

  describe("item and ingredient forecast", () => {
    it("works out portions, modifier shares and what a portion takes, by hand", async () => {
      const day = await forecastFor(FRIDAY);
      const item = day.items.find((entry) => entry.menuItemId === burger.menuItem.id)!;
      const soda = day.items.find((entry) => entry.menuItemId === sodaId)!;
      const { medium, extraPickles, noOnion, swissInstead } = burger.modifiers;
      const { beef, bun, american, swiss, onion, pickles, bacon } = burger.stock;

      expect(day.status).toBe("OK");
      expect(day.sampleDates).toEqual(["2030-03-01", "2030-02-22", "2030-02-15"]);
      // (3 × 3 + 2 × 2 + 1 × 1) / 6
      expect(item.portions).toBe("2.33");
      expect(item.recipeVersionId).toBe(burger.revision.id);
      expect(item.stationIds).toEqual([burger.grill.id]);
      expect(Object.fromEntries(item.modifierShares.map((share) => [share.modifierId, share.share]))).toEqual({
        [medium.id]: "1.0000",
        // (3 × 2/3 + 2 × 1/2 + 0) / 6
        [extraPickles.id]: "0.5000",
        // (3 × 1/3) / 6
        [noOnion.id]: "0.1667",
        [swissInstead.id]: "0.1667",
      });

      const perPortion = Object.fromEntries(item.perPortion.map((entry) => [entry.inventoryItemId, entry.baseQuantity]));

      expect(perPortion[beef.id]).toBe("8.0000");
      expect(perPortion[bun.id]).toBe("1.0000");
      expect(Number(perPortion[american.id])).toBe(0.8333);
      expect(Number(perPortion[swiss.id])).toBe(0.1667);
      expect(Number(perPortion[onion.id])).toBe(0.8333);
      expect(Number(perPortion[pickles.id])).toBe(4);
      expect(perPortion[bacon.id]).toBe("2.0000");

      const usage = Object.fromEntries(item.usage.map((entry) => [entry.inventoryItemId, entry.baseQuantity]));

      expect(usage[beef.id]).toBe("18.6400");
      expect(usage[american.id]).toBe("1.9416");
      expect(usage[pickles.id]).toBe("9.3200");

      // Soda: sold only on 02-22 (zero on the other usable dates), and it has no recipe.
      expect(soda.portions).toBe("1.33");
      expect(soda.recipeVersionId).toBeNull();
      expect(soda.usage).toEqual([]);
    });

    it("matches what SEND consumes for the canonical choice", async () => {
      // One portion with Medium, No Onion, Extra Pickles, Swiss instead of American, as SEND
      // records it (README section 31): the forecast rule must agree with full shares.
      const { beef, american, swiss, onion, pickles } = burger.stock;
      const consumed = await database().execute(sql`
        SELECT c.inventory_item_id, c.base_quantity::text AS quantity
        FROM order_item_inventory_consumption c
        JOIN order_items oi ON oi.id = c.order_item_id
        JOIN order_item_modifiers m ON m.order_item_id = oi.id AND m.modifier_id = ${burger.modifiers.swissInstead.id}
      `);
      const sent = Object.fromEntries(
        (consumed as unknown as { inventory_item_id: string; quantity: string }[]).map((row) => [row.inventory_item_id, row.quantity]),
      );

      expect(sent[american.id]).toBeUndefined();
      expect(sent[swiss.id]).toBe("1.0000");
      expect(sent[beef.id]).toBe("8.0000");
      expect(sent[onion.id]).toBe("1.0000");
      expect(sent[pickles.id]).toBe("3.0000");
    });

    it("has no forecast without enough history, and refuses dates out of range", async () => {
      const monday = await forecastFor(TODAY);

      expect(monday.status).toBe("NOT_ENOUGH_HISTORY");
      expect(monday.items.every((entry) => entry.portions === null && entry.usage.length === 0)).toBe(true);
      await expect(forecastFor("2030-03-03")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(forecastFor("2030-03-19")).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("writes nothing and moves no stock", async () => {
      const before = await database().select({ total: count() }).from(inventoryTransactions);

      await forecastFor(FRIDAY);
      await getPrepList(database(), owner, { businessDate: FRIDAY });

      expect(await database().select({ total: count() }).from(inventoryTransactions)).toEqual(before);
      expect(await database().select({ total: count() }).from(purchasingForecasts)).toEqual([{ total: 0 }]);
    });
  });

  describe("prep list", () => {
    it("lists each station's items in whole portions, with usual modifiers and ingredients", async () => {
      const list = await getPrepList(database(), owner, { businessDate: FRIDAY });
      const grill = list.stations.find((station) => station.id === burger.grill.id)!;
      const line = grill.items.find((item) => item.menuItemId === burger.menuItem.id)!;

      expect(list.status).toBe("OK");
      expect(grill.items.map((item) => item.name)).toEqual(["Bacon Cheeseburger"]);
      expect(line.portions).toBe(3);
      expect(line.forecastPortions).toBe("2.33");
      expect(Object.fromEntries(line.modifiers.map((modifier) => [modifier.name, modifier.count]))).toEqual({
        Medium: 3,
        "Extra Pickles": 2,
        "No Onion": 1,
        "Swiss instead of American": 1,
      });
      expect(line.ingredients.find((ingredient) => ingredient.inventoryItemId === burger.stock.beef.id)).toMatchObject({
        baseQuantity: "24.0000",
        name: "Ground beef",
      });
      // The soda isn't routed to a station, so it is on no list.
      expect(list.stations.flatMap((station) => station.items).some((item) => item.menuItemId === sodaId)).toBe(false);
    });

    it("needs the station type's view permission and covers only today to 6 days ahead", async () => {
      const cook = await actorWith(database(), scenario, ["kitchen.view"]);
      const barOnly = await actorWith(database(), scenario, ["bar.view"]);
      const nobody = await actorWith(database(), scenario, ["orders.view"]);

      expect((await getPrepList(database(), cook, { businessDate: FRIDAY })).stations.map((station) => station.id)).toContain(
        burger.grill.id,
      );
      expect((await getPrepList(database(), barOnly, { businessDate: FRIDAY })).stations.map((station) => station.id)).not.toContain(
        burger.grill.id,
      );
      await expect(getPrepList(database(), nobody, { businessDate: FRIDAY })).rejects.toBeInstanceOf(AuthorizationError);
      await expect(getPrepList(database(), cook, { businessDate: "2030-03-11" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });
  });

  describe("forecast-based suggested orders", () => {
    let napkinsId: string;

    beforeAll(async () => {
      // Beef: 52 oz on hand after history; reorder level 40 oz; bought by the pound (16 oz).
      // Not low by par (52 > 40), but Friday's forecast uses 18.64 oz.
      const config = await getItemConfiguration(database(), owner, burger.stock.beef.id);
      const here = config.locations.find((row) => row.locationId === scenario.locationA)!;
      const {
        supplierItems: [beefByPound],
      } = await supplierWith(database(), owner, [
        { inventoryItemId: burger.stock.beef.id, purchaseUnitId: scenario.units.lb, lastUnitCost: "5.0000" },
      ]);

      await setItemLocation(database(), owner, burger.stock.beef.id, {
        parLevel: "60",
        reorderLevel: "40",
        reorderTarget: "60",
        storageNote: null,
        active: true,
        preferredSupplierItemId: beefByPound!.id,
        expectedVersion: here.version,
      });

      // Napkins: no recipe uses them, so they stay on par: 0 on hand, reorder at 10, target 50.
      const napkins = await stockedItem(database(), owner, {
        baseUnitId: scenario.units.each,
        name: "Napkins",
        levels: { parLevel: "50", reorderLevel: "10", reorderTarget: "50" },
      });
      const {
        supplierItems: [napkinPack],
      } = await supplierWith(database(), owner, [{ inventoryItemId: napkins.id, purchaseUnitId: scenario.units.each, lastUnitCost: "0.0500" }]);
      const napkinConfig = await getItemConfiguration(database(), owner, napkins.id);
      const napkinHere = napkinConfig.locations.find((row) => row.locationId === scenario.locationA)!;

      await setItemLocation(database(), owner, napkins.id, {
        parLevel: "50",
        reorderLevel: "10",
        reorderTarget: "50",
        storageNote: null,
        active: true,
        preferredSupplierItemId: napkinPack!.id,
        expectedVersion: napkinHere.version,
      });
      napkinsId = napkins.id;
    });

    it("previews forecast lines and par fallbacks, and leaves the par basis unchanged", async () => {
      const preview = await previewForecastSuggestedOrders(database(), owner, { throughDate: "2030-03-09" });
      const lines = preview.suppliers.flatMap((group) => group.lines);
      const beefLine = lines.find((line) => line.inventoryItemId === burger.stock.beef.id)!;
      const napkinLine = lines.find((line) => line.inventoryItemId === napkinsId)!;

      // 18.64 + 40 − 52 − 0 = 6.64 oz → 1 lb.
      expect(beefLine).toMatchObject({
        basis: "FORECAST",
        forecastUsageBaseQuantity: "18.6400",
        reorderFloor: "40.0000",
        quantityOnHand: "52.0000",
        needBaseQuantity: "6.6400",
        orderedQuantity: "1",
      });
      expect(napkinLine).toMatchObject({ basis: "PAR", forecastUsageBaseQuantity: null, needBaseQuantity: "50.0000" });
      expect(preview.forecast?.dates.map((date) => [date.businessDate, date.status])).toEqual([
        ["2030-03-04", "NOT_ENOUGH_HISTORY"],
        ["2030-03-05", "NOT_ENOUGH_HISTORY"],
        ["2030-03-06", "NOT_ENOUGH_HISTORY"],
        ["2030-03-07", "NOT_ENOUGH_HISTORY"],
        ["2030-03-08", "OK"],
        ["2030-03-09", "NOT_ENOUGH_HISTORY"],
      ]);

      const par = await previewSuggestedOrders(database(), owner);

      expect(par.forecast).toBeUndefined();
      expect(par.suppliers.flatMap((group) => group.lines).map((line) => line.inventoryItemId)).toEqual([napkinsId]);
      expect(Object.keys(par.suppliers[0]!.lines[0]!)).not.toContain("basis");
      expect(await database().select({ total: count() }).from(purchasingForecasts)).toEqual([{ total: 0 }]);
    });

    it("creates drafts with an append-only snapshot in one transaction, once per key", async () => {
      const ledgerBefore = await database().select({ total: count() }).from(inventoryTransactions);
      const key = newKey();
      const created = await createForecastSuggestedOrders(database(), owner, { throughDate: "2030-03-09", idempotencyKey: key });

      expect(created.replayed).toBe(false);
      expect(created.purchaseOrders).toHaveLength(2);

      const [forecast] = await database().select().from(purchasingForecasts);

      expect(forecast).toMatchObject({ fromDate: TODAY, throughDate: "2030-03-09", locationId: scenario.locationA });

      const orders = await database().select().from(purchaseOrders).where(eq(purchaseOrders.purchasingForecastId, forecast!.id));

      expect(orders.map((order) => order.status)).toEqual(["DRAFT", "DRAFT"]);
      expect(orders.every((order) => order.notes === "Suggested from the forecast through 2030-03-09.")).toBe(true);
      expect(
        (await database().select().from(purchaseOrderLines)).filter((line) => orders.some((order) => order.id === line.purchaseOrderId)),
      ).toHaveLength(2);

      const items = await database().select().from(purchasingForecastItems).where(eq(purchasingForecastItems.purchasingForecastId, forecast!.id));

      expect(items.find((row) => row.businessDate === FRIDAY && row.menuItemId === burger.menuItem.id)).toMatchObject({
        status: "OK",
        portions: "2.33",
        recipeVersionId: burger.revision.id,
      });
      expect(items.filter((row) => row.businessDate === TODAY).every((row) => row.status === "NOT_ENOUGH_HISTORY" && row.portions === null)).toBe(true);

      const lines = await database().select().from(purchasingForecastLines).where(eq(purchasingForecastLines.purchasingForecastId, forecast!.id));

      expect(lines.map((line) => [line.basis, line.need]).sort()).toEqual([
        ["FORECAST", "6.6400"],
        ["PAR", "50.0000"],
      ]);

      const [audit] = await database()
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "purchasing.suggested-orders-created"));

      expect(audit!.details).toMatchObject({ basis: "FORECAST", throughDate: "2030-03-09", purchasingForecastId: forecast!.id });

      const again = await createForecastSuggestedOrders(database(), owner, { throughDate: "2030-03-09", idempotencyKey: key });

      expect(again.replayed).toBe(true);
      expect(again.purchaseOrders).toEqual(created.purchaseOrders);
      expect(await database().select({ total: count() }).from(purchasingForecasts)).toEqual([{ total: 1 }]);
      expect(await database().select({ total: count() }).from(inventoryTransactions)).toEqual(ledgerBefore);

      // Append-only.
      await expect(
        database().update(purchasingForecastItems).set({ portions: "9.00" }).where(eq(purchasingForecastItems.purchasingForecastId, forecast!.id)),
      ).rejects.toThrow();
      await expect(database().delete(purchasingForecastLines).where(eq(purchasingForecastLines.purchasingForecastId, forecast!.id))).rejects.toThrow();
    });

    it("needs purchasing.manage, and a through date from tomorrow to 14 days ahead", async () => {
      const viewer = await actorWith(database(), scenario, ["purchasing.view", "kitchen.view"]);

      await expect(previewForecastSuggestedOrders(database(), viewer, { throughDate: "2030-03-09" })).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      await expect(
        createForecastSuggestedOrders(database(), viewer, { throughDate: "2030-03-09", idempotencyKey: newKey() }),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(previewForecastSuggestedOrders(database(), owner, { throughDate: TODAY })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
      await expect(previewForecastSuggestedOrders(database(), owner, { throughDate: "2030-03-19" })).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
      });
    });
  });

  describe("today", () => {
    it("takes off what has already been sent today, on open checks too", async () => {
      at(FRIDAY, "12:00");

      const order = await createOrder(database(), scenario.cashier, { orderType: "TAKEOUT" });
      const added = await addDraftItem(database(), scenario.cashier, order.id, {
        expectedVersion: order.version,
        menuItemId: burger.menuItem.id,
        quantity: 1,
        selections: [...burger.mediumOnly],
        specialInstructions: null,
      });

      await sendOrderItems(database(), scenario.cashier, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });

      const day = await forecastFor(FRIDAY);
      const item = day.items.find((entry) => entry.menuItemId === burger.menuItem.id)!;

      expect(item).toMatchObject({ forecastPortions: "2.33", sentToday: 1, portions: "1.33" });
      expect((await getPrepList(database(), owner, {})).stations.find((station) => station.id === burger.grill.id)!.items[0]!.portions).toBe(2);
      at(TODAY, "10:00");
    });
  });
  describe("item forecast vs actual", () => {
    it("compares the stored forecast with closed checks once the date has passed", async () => {
      // Friday sells 3 burgers on a closed check (and none of the forecast sodas).
      await closedItemsCheckAt(database(), scenario, {
        date: FRIDAY,
        time: "20:00",
        lines: [{ menuItemId: burger.menuItem.id, quantity: 3, selections: [...burger.mediumOnly] }],
      });
      at("2030-03-11", "10:00");

      const inventory = await runReport(database(), owner, "inventory", {
        locationId: scenario.locationA,
        from: TODAY,
        to: "2030-03-10",
      });
      const section = inventory.sections.find((entry) => entry.key === "itemForecastAccuracy")!;

      // Only Friday had enough history, and only the forecast that drafts were made from counts.
      expect(section.rows).toEqual([
        { businessDate: FRIDAY, item: "Bacon Cheeseburger", forecast: "2.33", actual: "3.00", difference: "0.67", differencePercent: "28.8" },
        { businessDate: FRIDAY, item: "Soda", forecast: "1.33", actual: "0.00", difference: "-1.33", differencePercent: "-100.0" },
      ]);

      at(TODAY, "10:00");
    });
  });
});
