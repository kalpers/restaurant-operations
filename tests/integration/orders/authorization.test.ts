import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { orderItemModifiers, orderItems } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { ROLE_CATALOG } from "@/modules/auth/role-catalog";
import type { Actor } from "@/modules/auth/types";
import { postSaleReversal } from "@/modules/inventory/services/order-consumption";
import { recordAdjustment, recordWaste } from "@/modules/inventory/services/stock-operations";
import { getOrderDetail, listOrders } from "@/modules/orders/queries/order-queries";
import {
  applyOrderDiscount,
  createDiscountDefinition,
  listDiscountDefinitions,
} from "@/modules/orders/services/discount-service";
import { addDraftItem, removeDraftItem, updateDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrder, voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { ABSENT_ID, actorWith } from "../../fixtures/employee-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  ledgerFor,
  newKey,
  onHand,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

const ORDER_CODES: readonly PermissionCode[] = [
  "orders.view",
  "orders.create",
  "orders.edit",
  "orders.submit",
  "orders.void",
  "orders.close",
  "orders.discount.apply",
  "orders.discount.manage",
];

const grantsOf = (code: string) => ROLE_CATALOG.find((role) => role.code === code)?.permissions ?? [];

describe("order role matrix", () => {
  it("gives Owner, General Manager and Manager every order code", () => {
    for (const role of ["OWNER", "GENERAL_MANAGER", "MANAGER"]) {
      expect(grantsOf(role)).toEqual(expect.arrayContaining([...ORDER_CODES]));
    }
  });

  it("gives Server and Bartender order entry only, with no inventory permission", () => {
    for (const role of ["SERVER", "BARTENDER"]) {
      expect(grantsOf(role).filter((code) => code.startsWith("orders.")).sort()).toEqual([
        "orders.create",
        "orders.edit",
        "orders.fire",
        "orders.move-items",
        "orders.submit",
        "orders.view",
      ]);
      expect(grantsOf(role).filter((code) => code.startsWith("inventory."))).toEqual([]);
    }
  });

  it("gives Host, Cook, Wait Staff and Inventory Manager no order permission", () => {
    for (const role of ["HOST", "COOK", "WAIT_STAFF", "INVENTORY_MANAGER"]) {
      expect(grantsOf(role).filter((code) => code.startsWith("orders."))).toEqual([]);
    }
  });
});

describe("order authorization", () => {
  let scenario: OrderScenario;
  let burger: Burger;

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function sentBurger(actor: Actor = scenario.serverActor) {
    const order = await createOrder(database(), actor, { orderType: "TAKEOUT" });
    const added = await addDraftItem(database(), actor, order.id, {
      expectedVersion: order.version,
      menuItemId: burger.menuItem.id,
      quantity: 1,
      selections: burger.canonicalSelections,
      specialInstructions: null,
    });
    const sent = await sendOrderItems(database(), actor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
    });

    return { orderId: order.id, version: sent.orderVersion, itemId: added.itemId };
  }

  it("refuses each operation without its own permission", async () => {
    const without = async (missing: PermissionCode) =>
      actorWith(
        database(),
        scenario,
        [
          "orders.view",
          "orders.create",
          "orders.edit",
          "orders.submit",
          "orders.void",
          "orders.discount.apply",
          "orders.discount.manage",
        ].filter((code) => code !== missing) as PermissionCode[],
      );
    const cases: [PermissionCode, (actor: Actor) => Promise<unknown>][] = [
      ["orders.view", (actor) => listOrders(database(), actor)],
      ["orders.view", (actor) => getOrderDetail(database(), actor, ABSENT_ID)],
      ["orders.create", (actor) => createOrder(database(), actor, { orderType: "TAKEOUT" })],
      [
        "orders.edit",
        (actor) =>
          addDraftItem(database(), actor, ABSENT_ID, {
            expectedVersion: 1,
            menuItemId: ABSENT_ID,
            quantity: 1,
            selections: [],
            specialInstructions: null,
          }),
      ],
      [
        "orders.edit",
        (actor) =>
          updateDraftItem(database(), actor, ABSENT_ID, ABSENT_ID, {
            expectedVersion: 1,
            quantity: 1,
            selections: [],
            specialInstructions: null,
          }),
      ],
      ["orders.edit", (actor) => removeDraftItem(database(), actor, ABSENT_ID, ABSENT_ID, { expectedVersion: 1 })],
      ["orders.submit", (actor) => sendOrderItems(database(), actor, ABSENT_ID, { expectedVersion: 1, idempotencyKey: newKey() })],
      [
        "orders.void",
        (actor) =>
          voidOrderItem(database(), actor, ABSENT_ID, ABSENT_ID, { reason: "x", disposition: "UNPREPARED", expectedVersion: 1 }),
      ],
      ["orders.void", (actor) => voidOrder(database(), actor, ABSENT_ID, { reason: "x", expectedVersion: 1, dispositions: {} })],
      [
        "orders.discount.apply",
        (actor) => applyOrderDiscount(database(), actor, ABSENT_ID, { discountDefinitionId: ABSENT_ID, reason: "x", expectedVersion: 1 }),
      ],
      [
        "orders.discount.manage",
        (actor) =>
          createDiscountDefinition(database(), actor, { code: "X", name: "X", scope: "ORDER", discountType: "FIXED_AMOUNT", value: "1" }),
      ],
    ];

    for (const [permission, call] of cases) {
      const actor = await without(permission);

      await expect(call(actor), permission).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    }

    // Listing definitions needs apply or manage.
    await expect(listDiscountDefinitions(database(), scenario.viewOnly)).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("lets a server send and consume stock with no inventory permission, which they still lack", async () => {
    await sentBurger(scenario.serverActor);

    expect(await onHand(database(), burger.stock.beef.id)).toBe("92.0000");
    expect(scenario.serverActor.permissions.has("inventory.adjust")).toBe(false);
    await expect(
      recordAdjustment(database(), scenario.serverActor, {
        inventoryItemId: burger.stock.beef.id,
        quantity: "1",
        unitOfMeasureId: scenario.units.ozWeight,
        notes: null,
        direction: "INCREASE",
        reasonCode: "OTHER",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      recordWaste(database(), scenario.serverActor, {
        inventoryItemId: burger.stock.beef.id,
        quantity: "1",
        unitOfMeasureId: scenario.units.ozWeight,
        notes: null,
        reasonCode: "OTHER",
      }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("lets a view-only user read but not send or void", async () => {
    const { orderId, version, itemId } = await sentBurger();

    expect((await getOrderDetail(database(), scenario.viewOnly, orderId)).items).toHaveLength(1);
    await expect(
      sendOrderItems(database(), scenario.viewOnly, orderId, { expectedVersion: version, idempotencyKey: newKey() }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
    await expect(
      voidOrderItem(database(), scenario.serverActor, orderId, itemId, { reason: "x", disposition: "UNPREPARED", expectedVersion: version }),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  });

  it("keeps orders within their location and organization", async () => {
    const { orderId, version } = await sentBurger();
    const atB = await actorWith(database(), scenario, ["orders.view", "orders.edit", "orders.void"], scenario.locationB);

    await expect(getOrderDetail(database(), atB, orderId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      voidOrder(database(), atB, orderId, { reason: "x", expectedVersion: version, dispositions: {} }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await listOrders(database(), atB)).map((order) => order.id)).not.toContain(orderId);
  });

  it("restricts the trusted reversal to an order item's own consumption", async () => {
    const receive = (await ledgerFor(database(), burger.stock.beef.id)).find((row) => row.transactionType === "RECEIVE")!;

    await expect(
      withTransaction(database(), (transaction) =>
        postSaleReversal(transaction, {
          organizationId: scenario.organizationId,
          locationId: scenario.locationA,
          originalTransactionIds: [receive.id],
          voidId: ABSENT_ID,
          occurredAt: new Date(),
          createdByUserId: scenario.manager.userId,
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_ORDER_CONSUMPTION" });
  });

  it("freezes a sent item's snapshot and modifiers in the database", async () => {
    const { orderId } = await sentBurger();
    const [item] = await itemRows(database(), orderId);

    await expect(
      database().update(orderItems).set({ unitPriceSnapshot: "1.00", lineTotalSnapshot: "1.00", basePriceSnapshot: "1.00", modifierTotalSnapshot: "0.00" }).where(eq(orderItems.id, item!.id)),
    ).rejects.toBeTruthy();
    await expect(database().delete(orderItems).where(eq(orderItems.id, item!.id))).rejects.toBeTruthy();
    await expect(
      database().delete(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, item!.id)),
    ).rejects.toBeTruthy();
  });
});

describe("order module boundaries", () => {
  function sourceFiles(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const full = path.join(directory, entry);

      return statSync(full).isDirectory()
        ? sourceFiles(full)
        : full.endsWith(".ts") && !full.endsWith(".test.ts")
          ? [full]
          : [];
    });
  }

  const files = [...sourceFiles("src/modules/orders"), ...sourceFiles("src/workflows/submit-order"), ...sourceFiles("src/workflows/void-order-item")];

  it("never writes inventory, menu price or recipe tables directly", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");

      for (const forbidden of [
        "insert(inventoryTransactions",
        "update(inventoryBalances",
        "insert(inventoryBalances",
        "menuItemPrices",
        "recipeVersionIngredients",
        "restaurantTables",
        "postInventoryTransaction",
      ]) {
        expect(`${file}: ${text.includes(forbidden)}`).toBe(`${file}: false`);
      }
    }
  });

  // Since Phase 11 the Orders domain owns OPEN -> CLOSED for a completed Settlement, so it
  // may name settlement; it still never reads settlement or tender data, tickets or tax.
  // Phase 17 (approved policy A5) moved tax into the Orders totals, so tax words are no
  // longer forbidden here; settlement, tender and ticket data still are.
  it("does not reach into settlement, tender or ticket data", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8").toLowerCase();

      for (const forbidden of [
        "tender",
        "@/modules/settlements",
        "order_settlements",
        "kitchen_ticket",
        "kitchentickets",
      ]) {
        // The SEND and void workflows orchestrate across domains and may ask Settlements
        // whether the amount is locked; the Orders module itself may not.
        if (forbidden === "@/modules/settlements" && !file.includes(path.join("src", "modules", "orders"))) {
          continue;
        }

        expect(`${file}: ${text.includes(forbidden)}`).toBe(`${file}: false`);
      }
    }
  });
});
