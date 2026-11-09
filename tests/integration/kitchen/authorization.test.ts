import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";
import { getExpoView, getStationQueue } from "@/modules/kitchen/queries/kitchen-queries";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { updateStation } from "@/modules/menu/services/prep-station-service";
import { remakeOrderItem } from "@/workflows/remake-order-item/remake-order-item";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  COOK_PERMISSIONS,
  createKitchenScenario,
  sendOrder,
  ticketItemsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import { clearOrderData, newKey } from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("kitchen and bar authorization", () => {
  let scenario: KitchenScenario;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function burgerAndCocktail() {
    const { order, sent } = await sendOrder(database(), scenario, [
      { menuItemId: scenario.burger.menuItem.id, selections: scenario.burger.mediumOnly },
      { menuItemId: scenario.cocktail.id },
    ]);
    const items = await ticketItemsForOrder(database(), order.id);

    return {
      order,
      sent,
      food: items.find((item) => item.menuItemNameSnapshot === "Bacon Cheeseburger")!,
      drink: items.find((item) => item.menuItemNameSnapshot === "Margarita")!,
    };
  }

  it("a view-only kitchen user sees queues but can't move anything", async () => {
    const { food } = await burgerAndCocktail();
    const queue = await getStationQueue(database(), scenario.kitchenViewer, { stationType: "KITCHEN" });
    const ticket = queue.active.find((entry) => entry.items.some((item) => item.id === food.id))!;

    expect(ticket.items[0]!.actions).toEqual({ start: false, ready: false, complete: false });

    for (const action of ["start", "ready", "complete"] as const) {
      await expect(
        transitionTicketItem(database(), scenario.kitchenViewer, food.id, action, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }
  });

  it("each action needs its own permission", async () => {
    const { food } = await burgerAndCocktail();
    const startOnly = await actorWith(database(), scenario, ["kitchen.view", "kitchen.manage", "fulfillment.start"]);
    const started = await transitionTicketItem(database(), startOnly, food.id, "start", { expectedVersion: 1 });

    await expect(
      transitionTicketItem(database(), startOnly, food.id, "ready", { expectedVersion: started.version }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("station-type scope: a bartender can't work or view the kitchen, a cook can't touch the bar", async () => {
    const { food, drink } = await burgerAndCocktail();

    await expect(
      transitionTicketItem(database(), scenario.bartender, food.id, "start", { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      getStationQueue(database(), scenario.bartender, { stationType: "KITCHEN" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      transitionTicketItem(database(), scenario.cook, drink.id, "start", { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(getStationQueue(database(), scenario.cook, { stationType: "BAR" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("a user with no kitchen or bar view gets no queue or Expo", async () => {
    await burgerAndCocktail();

    await expect(
      getStationQueue(database(), scenario.serverActor, { stationType: "KITCHEN" }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(getExpoView(database(), scenario.serverActor)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("another location's work looks absent", async () => {
    const { food } = await burgerAndCocktail();
    const cookAtB = await actorWith(database(), scenario, COOK_PERMISSIONS, scenario.locationB);

    await expect(
      transitionTicketItem(database(), cookAtB, food.id, "start", { expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const queue = await getStationQueue(database(), cookAtB, { stationType: "KITCHEN" });

    expect(queue.active.some((ticket) => ticket.items.some((item) => item.id === food.id))).toBe(false);
    await expect(
      remakeOrderItem(database(), cookAtB, food.orderId, food.orderItemId, {
        reason: "x",
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("Remake needs fulfillment.remake and the station's manage scope", async () => {
    const { food, drink } = await burgerAndCocktail();
    const noRemake = await actorWith(database(), scenario, ["kitchen.view", "kitchen.manage", "fulfillment.start"]);

    await expect(
      remakeOrderItem(database(), noRemake, food.orderId, food.orderItemId, {
        reason: "Burnt",
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      remakeOrderItem(database(), scenario.cook, drink.orderId, drink.orderItemId, {
        reason: "Spilled",
        idempotencyKey: newKey(),
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("kitchen and bar roles hold no inventory adjustment, receiving or count rights", () => {
    for (const code of ["COOK", "BARTENDER"]) {
      const role = ROLE_CATALOG.find((entry) => entry.code === code)!;

      expect(role.permissions).not.toContain("inventory.adjust");
      expect(role.permissions).not.toContain("inventory.receive");
      expect(role.permissions).not.toContain("inventory.count");
    }

    const bartender = ROLE_CATALOG.find((entry) => entry.code === "BARTENDER")!;

    expect(bartender.permissions).toContain("bar.manage");
    expect(bartender.permissions).not.toContain("kitchen.manage");
    expect(ROLE_CATALOG.find((entry) => entry.code === "COOK")!.permissions).not.toContain("bar.manage");
  });

  it("a station with active work can't be deactivated", async () => {
    await burgerAndCocktail();

    const grill = scenario.stations.grill;

    await expect(
      updateStation(database(), scenario.owner, grill.id, {
        name: grill.name,
        stationType: "KITCHEN",
        sortOrder: grill.sortOrder,
        active: false,
        expectedVersion: grill.version,
      }),
    ).rejects.toMatchObject({ code: "STATION_HAS_ACTIVE_WORK" });

    // Renaming is fine, and doesn't touch the ticket snapshot.
    await updateStation(database(), scenario.owner, grill.id, {
      name: "Char grill",
      stationType: "KITCHEN",
      sortOrder: grill.sortOrder,
      active: true,
      expectedVersion: grill.version,
    });
  });

  it("kitchen code writes no inventory table directly", () => {
    const roots = ["src/modules/kitchen", "src/workflows/remake-order-item"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);

        if (statSync(path).isDirectory()) {
          walk(path);
        } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
          files.push(path);
        }
      }
    };

    roots.forEach(walk);

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      expect(source, file).not.toMatch(/insert\(inventoryTransactions\)|update\(inventoryBalances\)|insert\(inventoryBalances\)/);
      expect(source, file).not.toMatch(/postInventoryTransaction/);
      expect(source, file).not.toMatch(/menuItemPrepRouting|recipeVersionIngredients/);
    }
  });
});
