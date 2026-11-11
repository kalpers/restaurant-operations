import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, locationSettings, menuItemOutages, outboxEvents } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { loadStockSignals } from "@/modules/menu/queries/stock-signals";
import {
  clearSellAnyway,
  getStockBoard,
  markItemOut,
  restoreItem,
  setAuto86FromStock,
  setSellAnyway,
} from "@/modules/menu/services/outage-service";
import { resolveCurrentRequirementsForMenuItems } from "@/modules/recipes/queries/menu-item-requirements";
import { resolveRevisionRequirements } from "@/modules/recipes/services/ingredient-service";
import { resolveEffectiveRevisionForMenuItem } from "@/modules/recipes/services/recipe-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import { post } from "../../fixtures/inventory-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  newKey,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

// Phase 19 policies A2-A9: the per-location 86 list, portions remaining, auto-86 and
// sell anyway, all decided by one check that draft add and SEND share.

const database = () => getDatabase();

describe("menu stock signals (Phase 19)", () => {
  let scenario: OrderScenario;
  let burger: Burger;
  let cook: Actor;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    cook = await actorWith(database(), scenario, ["menu.availability.manage"]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  const offeredIds = async (actor: Actor) =>
    (await getOperationalMenu(database(), actor)).menus.flatMap((menu) =>
      menu.categories.flatMap((category) => category.items.map((item) => item.menuItemId)),
    );

  async function draftBurger() {
    const session = await seatedSession(database(), scenario);
    const order = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.mediumOnly,
      specialInstructions: null,
    });

    return { order, added };
  }

  async function enableAuto86() {
    const [settings] = await database()
      .select({ version: locationSettings.version })
      .from(locationSettings)
      .where(eq(locationSettings.locationId, scenario.locationA));

    return setAuto86FromStock(database(), scenario.owner, { enabled: true, expectedVersion: settings!.version });
  }

  /** Leaves 7 oz of beef: less than the 8 oz one burger needs. */
  const wasteBeefToSeven = () =>
    post(database(), scenario.owner, {
      inventoryItemId: burger.stock.beef.id,
      type: "WASTE",
      quantity: "93",
      unitOfMeasureId: scenario.units.ozWeight,
      reasonCode: "SPOILAGE",
    });

  it("bulk requirements equal what SEND resolves item by item", async () => {
    const now = new Date();
    const bulk = await resolveCurrentRequirementsForMenuItems(database(), scenario.organizationId, [burger.menuItem.id], now);
    const revision = await resolveEffectiveRevisionForMenuItem(database(), scenario.organizationId, burger.menuItem.id, now);
    const single = await resolveRevisionRequirements(database(), scenario.organizationId, revision!.id);
    const sort = (rows: { inventoryItemId: string; baseQuantity: string }[]) =>
      [...rows].sort((a, b) => a.inventoryItemId.localeCompare(b.inventoryItemId));

    expect(sort(bulk.get(burger.menuItem.id)!)).toEqual(sort(single));
  });

  it("counts portions remaining from the scarcest ingredient", async () => {
    const board = await getStockBoard(database(), scenario.serverActor);
    const row = board.items.find((item) => item.menuItemId === burger.menuItem.id)!;

    // 100 oz beef / 8 oz = 12; every other ingredient allows more.
    expect(row).toMatchObject({ portions: 12, state: "SELLABLE", runningLow: false });
    expect(row.limitingIngredient?.id).toBe(burger.stock.beef.id);
    expect(board.canManage).toBe(false);
  });

  it("86es an item at one location only and refuses it at SEND", async () => {
    const { order, added } = await draftBurger();
    const outage = await markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Out of brioche" });

    expect(await offeredIds(scenario.serverActor)).not.toContain(burger.menuItem.id);

    const atB = await loadStockSignals(database(), {
      organizationId: scenario.organizationId,
      locationId: scenario.locationB,
      menuItemIds: [burger.menuItem.id],
      at: new Date(),
      withPortions: false,
    });

    expect(atB.items.get(burger.menuItem.id)?.state).toBe("SELLABLE");
    await expect(
      sendOrderItems(database(), scenario.serverActor, order.id, {
        expectedVersion: added.orderVersion,
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "ITEM_NOT_SELLABLE" });

    const audit = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "menu.item-marked-out"), eq(auditEvents.entityId, burger.menuItem.id)));

    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toEqual({ itemCode: burger.menuItem.code, outageId: outage.id, reason: "Out of brioche" });
    expect(
      await database()
        .select()
        .from(outboxEvents)
        .where(and(eq(outboxEvents.eventType, "menu.availability-changed"), eq(outboxEvents.aggregateId, burger.menuItem.id))),
    ).toHaveLength(1);
  });

  it("refuses a second 86, checks the version on restore, and sells again after", async () => {
    const outage = await markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Out" });

    await expect(markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Again" })).rejects.toMatchObject({
      code: "ITEM_ALREADY_86ED",
    });
    await expect(
      restoreItem(database(), cook, { outageId: outage.id, expectedVersion: outage.version + 1 }),
    ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });

    await restoreItem(database(), cook, { outageId: outage.id, expectedVersion: outage.version });

    expect(await offeredIds(scenario.serverActor)).toContain(burger.menuItem.id);

    const board = await getStockBoard(database(), cook);

    expect(board.restoredToday.map((row) => row.outageId)).toContain(outage.id);
    await expect(
      database().delete(menuItemOutages).where(eq(menuItemOutages.id, outage.id)),
    ).rejects.toThrow();
  });

  it("refuses a Server who tries to 86 an item", async () => {
    await expect(
      markItemOut(database(), scenario.serverActor, { menuItemId: burger.menuItem.id, reason: "Out" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("auto-86es at zero portions only when the location turns it on", async () => {
    await wasteBeefToSeven();

    expect(await offeredIds(scenario.serverActor)).toContain(burger.menuItem.id);
    await expect(
      setSellAnyway(database(), cook, { menuItemId: burger.menuItem.id, reason: "Count is wrong" }),
    ).rejects.toMatchObject({ code: "AUTO_86_DISABLED" });

    await enableAuto86();

    expect(await offeredIds(scenario.serverActor)).not.toContain(burger.menuItem.id);

    const board = await getStockBoard(database(), cook);

    expect(board.items.find((item) => item.menuItemId === burger.menuItem.id)).toMatchObject({
      state: "AUTO_86",
      portions: 0,
    });
  });

  it("lets sell anyway lift auto-86 for the business date, but never a manual 86", async () => {
    await wasteBeefToSeven();
    await enableAuto86();

    const override = await setSellAnyway(database(), cook, { menuItemId: burger.menuItem.id, reason: "Count is wrong" });

    expect(await offeredIds(scenario.serverActor)).toContain(burger.menuItem.id);

    const tomorrow = new Date(Date.now() + 26 * 60 * 60 * 1000);
    const later = await loadStockSignals(database(), {
      organizationId: scenario.organizationId,
      locationId: scenario.locationA,
      menuItemIds: [burger.menuItem.id],
      at: tomorrow,
      withPortions: false,
    });

    expect(later.items.get(burger.menuItem.id)?.state).toBe("AUTO_86");

    const outage = await markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Grill down" });

    expect(await offeredIds(scenario.serverActor)).not.toContain(burger.menuItem.id);
    await restoreItem(database(), cook, { outageId: outage.id, expectedVersion: outage.version });
    await clearSellAnyway(database(), cook, { overrideId: override.id, expectedVersion: override.version });

    expect(await offeredIds(scenario.serverActor)).not.toContain(burger.menuItem.id);
  });
});
