import { and, desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, inventoryItemLocations, locationSettings, menuItemOutages, orderItems } from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { setItemLocation } from "@/modules/inventory/services/item-service";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { loadModifierOutagesInEffect, loadStockSignals } from "@/modules/menu/queries/stock-signals";
import {
  getStockBoard,
  markItemOut,
  markModifierOut,
  restoreItem,
  restoreModifier,
  setAuto86FromStock,
} from "@/modules/menu/services/outage-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { AuthorizationError } from "@/shared/errors/app-error";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  newKey,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

// Phase 20 policies 1-6: the category snapshot, modifier 86, scheduled 86, the running-low
// setting and the stock and settings audits.

const database = () => getDatabase();
const minutesFromNow = (minutes: number) => new Date(Date.now() + minutes * 60_000);

describe("menu and stock polish (Phase 20)", () => {
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

  const offered = async (actor: Actor = scenario.serverActor) =>
    (await getOperationalMenu(database(), actor)).menus.flatMap((menu) =>
      menu.categories.flatMap((category) => category.items),
    );

  async function draftBurger(selections = burger.canonicalSelections) {
    const session = await seatedSession(database(), scenario);
    const order = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });
    const added = await addDraftItem(database(), scenario.serverActor, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections,
      specialInstructions: null,
    });

    return { order, added };
  }

  const send = (orderId: string, expectedVersion: number) =>
    sendOrderItems(database(), scenario.serverActor, orderId, { expectedVersion, idempotencyKey: newKey() });

  it("snapshots the category at SEND and freezes it", async () => {
    const { order, added } = await draftBurger();
    const [draft] = await database().select().from(orderItems).where(eq(orderItems.id, added.itemId));

    expect(draft).toMatchObject({ menuCategoryId: null, menuCategoryNameSnapshot: null });

    await send(order.id, added.orderVersion);

    const [sent] = await database().select().from(orderItems).where(eq(orderItems.id, added.itemId));

    expect(sent).toMatchObject({ menuCategoryId: burger.category.id, menuCategoryNameSnapshot: burger.category.name });
    await expect(
      database().execute(sql`UPDATE order_items SET menu_category_name_snapshot = 'Renamed' WHERE id = ${added.itemId}`),
    ).rejects.toThrow();
  });

  it("86es a modifier at one location: refused at SEND, left off the menu, fine elsewhere", async () => {
    const { order, added } = await draftBurger();
    const outage = await markModifierOut(database(), cook, {
      modifierId: burger.modifiers.swissInstead.id,
      reason: "Out of Swiss",
    });
    const item = (await offered()).find((entry) => entry.menuItemId === burger.menuItem.id)!;
    const toppings = item.modifierGroups.find((group) => group.id === burger.groups.toppings.id)!;

    expect(toppings.modifiers.map((modifier) => modifier.id)).not.toContain(burger.modifiers.swissInstead.id);
    await expect(send(order.id, added.orderVersion)).rejects.toMatchObject({ code: "MODIFIER_UNAVAILABLE" });
    expect(
      await loadModifierOutagesInEffect(database(), {
        organizationId: scenario.organizationId,
        locationId: scenario.locationB,
        at: new Date(),
      }),
    ).toEqual([]);

    const [audit] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "menu.modifier-marked-out"), eq(auditEvents.entityId, burger.modifiers.swissInstead.id)));

    expect(audit!.details).toEqual({
      modifierCode: burger.modifiers.swissInstead.code,
      outageId: outage.id,
      reason: "Out of Swiss",
    });

    await restoreModifier(database(), cook, { outageId: outage.id, expectedVersion: outage.version });
    await expect(send(order.id, added.orderVersion)).resolves.toBeDefined();
  });

  it("takes an item off sale when a required group has no choice left", async () => {
    for (const modifier of [burger.modifiers.medium, burger.modifiers.wellDone]) {
      await markModifierOut(database(), cook, { modifierId: modifier.id, reason: "Grill down" });
    }

    expect((await offered()).map((entry) => entry.menuItemId)).not.toContain(burger.menuItem.id);
  });

  it("refuses a Server who tries to 86 a modifier", async () => {
    await expect(
      markModifierOut(database(), scenario.serverActor, { modifierId: burger.modifiers.medium.id, reason: "No" }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("puts a scheduled 86 in effect only inside its window", async () => {
    const startsAt = minutesFromNow(60);
    const endsAt = minutesFromNow(120);
    const outage = await markItemOut(database(), cook, {
      menuItemId: burger.menuItem.id,
      reason: "Off after 9",
      startsAt,
      endsAt,
    });
    const stateAt = async (at: Date) =>
      (
        await loadStockSignals(database(), {
          organizationId: scenario.organizationId,
          locationId: scenario.locationA,
          menuItemIds: [burger.menuItem.id],
          at,
          withPortions: false,
        })
      ).items.get(burger.menuItem.id)!.state;

    expect(await stateAt(new Date())).toBe("SELLABLE");
    expect(await stateAt(minutesFromNow(90))).toBe("MANUAL_86");
    expect(await stateAt(minutesFromNow(121))).toBe("SELLABLE");
    expect((await offered()).map((entry) => entry.menuItemId)).toContain(burger.menuItem.id);

    const board = await getStockBoard(database(), cook);

    expect(board.scheduled.map((entry) => entry.outageId)).toEqual([outage.id]);

    // Overlapping windows are refused; one that starts when this one ends is fine.
    await expect(
      markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Again", startsAt: minutesFromNow(100) }),
    ).rejects.toMatchObject({ code: "ITEM_ALREADY_86ED" });
    await expect(
      markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Later", startsAt: endsAt }),
    ).resolves.toBeDefined();

    // Cancelling the scheduled one before it starts is a restore.
    await restoreItem(database(), cook, { outageId: outage.id, expectedVersion: outage.version });

    const [row] = await database().select().from(menuItemOutages).where(eq(menuItemOutages.id, outage.id));

    expect(row!.status).toBe("RESTORED");
  });

  it("ends an \"until close\" 86 at the next business-day cutoff", async () => {
    const outage = await markItemOut(database(), cook, { menuItemId: burger.menuItem.id, reason: "Tonight", untilClose: true });

    expect(outage.endsAt).not.toBeNull();
    expect(outage.endsAt!.getTime()).toBeGreaterThan(Date.now());
    expect(outage.endsAt!.getTime() - Date.now()).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
    expect((await offered()).map((entry) => entry.menuItemId)).not.toContain(burger.menuItem.id);
  });

  it("uses the location's running-low threshold", async () => {
    const [settings] = await database()
      .select({ version: locationSettings.version })
      .from(locationSettings)
      .where(eq(locationSettings.locationId, scenario.locationA));

    // 12 burgers' worth of beef: not low at 5, low at 12.
    expect((await getStockBoard(database(), cook)).items.find((item) => item.menuItemId === burger.menuItem.id)?.runningLow).toBe(false);

    const updated = await setAuto86FromStock(database(), scenario.owner, {
      enabled: false,
      runningLowPortions: 12,
      expectedVersion: settings!.version,
    });

    expect(updated.runningLowPortions).toBe(12);
    expect((await getStockBoard(database(), cook)).items.find((item) => item.menuItemId === burger.menuItem.id)?.runningLow).toBe(true);

    const [audit] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "menu.stock-availability-setting-changed"), eq(auditEvents.entityId, scenario.locationA)));

    expect(audit!.after).toEqual({ enabled: false, runningLowPortions: 12 });
  });

  it("audits stocked-item level changes with before and after values", async () => {
    const [current] = await database()
      .select()
      .from(inventoryItemLocations)
      .where(
        and(
          eq(inventoryItemLocations.inventoryItemId, burger.stock.bun.id),
          eq(inventoryItemLocations.locationId, scenario.locationA),
        ),
      );

    await setItemLocation(database(), scenario.owner, burger.stock.bun.id, {
      parLevel: "40",
      reorderLevel: "20",
      reorderTarget: "40",
      storageNote: current!.storageNote,
      active: true,
      expectedVersion: current!.version,
    });

    const [audit] = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "inventory.item-location-changed"), eq(auditEvents.entityId, burger.stock.bun.id)))
      .orderBy(desc(auditEvents.sequence));

    expect(audit).toMatchObject({ category: "INVENTORY", locationId: scenario.locationA });
    expect(audit!.after).toMatchObject({ parLevel: "40.0000", reorderLevel: "20.0000", active: true });
    expect(audit!.before).toMatchObject({ active: true });
  });
});
