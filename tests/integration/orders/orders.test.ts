import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import {
  inventoryTransactions,
  locationSettings,
  orderItemModifiers,
  orderStatusHistory,
  tableSessions,
  tableSessionTables,
} from "@/db/schema";
import { setGroupModifier, updateModifier } from "@/modules/menu/services/modifier-service";
import { getOrderDetail, listOrders } from "@/modules/orders/queries/order-queries";
import { addDraftItem, removeDraftItem, updateDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { completeSession, moveSession } from "@/modules/restaurant/services/session-service";
import { businessDateOf } from "@/shared/time/business-date-service";
import { cancelTableSession, completeTableSession } from "@/workflows/end-table-session/end-table-session";
import { voidOrder } from "@/workflows/void-order-item/void-order-item";

import { tableFixture } from "../../fixtures/restaurant-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  orderRow,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";

const database = () => getDatabase();

describe("orders: creation, drafts and table sessions", () => {
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

  const sessionVersion = async (sessionId: string) =>
    (await database().select().from(tableSessions).where(eq(tableSessions.id, sessionId)))[0]!.version;

  describe("creation", () => {
    it("opens a DINE_IN order on an active dining session, with business date and history", async () => {
      const session = await seatedSession(database(), scenario);
      const before = new Date();
      const order = await createOrder(database(), scenario.serverActor, {
        orderType: "DINE_IN",
        tableSessionId: session.id,
      });
      const row = await orderRow(database(), order.id);

      expect(row).toMatchObject({
        orderType: "DINE_IN",
        status: "OPEN",
        tableSessionId: session.id,
        subtotal: "0.00",
        openedByUserId: scenario.serverActor.userId,
      });
      expect(row.businessDate).toBe(
        businessDateOf(before, { timeZone: "America/Detroit", businessDayCutoff: "04:00" }),
      );
      expect(
        await database().select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, order.id)),
      ).toEqual([expect.objectContaining({ status: "OPEN" })]);
    });

    it("numbers orders per location and business date without duplicates", async () => {
      const takeouts = await Promise.all(
        Array.from({ length: 5 }, () =>
          createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT", customerName: null }),
        ),
      );
      const numbers = takeouts.map((order) => order.orderNumber).sort((a, b) => a - b);

      expect(new Set(numbers).size).toBe(5);
      expect(numbers[4]! - numbers[0]!).toBe(4);
    });

    it("needs a BAR session for a BAR order and a DINING session for DINE_IN", async () => {
      const dining = await seatedSession(database(), scenario);
      const bar = await seatedSession(database(), scenario, { areaId: scenario.bar });

      await expect(
        createOrder(database(), scenario.serverActor, { orderType: "BAR", tableSessionId: dining.id }),
      ).rejects.toMatchObject({ code: "ORDER_TYPE_AREA_MISMATCH" });
      await expect(
        createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: bar.id }),
      ).rejects.toMatchObject({ code: "ORDER_TYPE_AREA_MISMATCH" });

      const barOrder = await createOrder(database(), scenario.serverActor, {
        orderType: "BAR",
        tableSessionId: bar.id,
      });

      expect((await orderRow(database(), barOrder.id)).orderType).toBe("BAR");
    });

    it("refuses another location's session and an ended session", async () => {
      const { createTable } = await import("@/modules/restaurant/services/table-service");
      const { id: atB } = await createTable(database(), scenario.ownerAtB, {
        restaurantAreaId: scenario.diningAtB,
        tableNumber: "B-T1",
        name: null,
        capacity: 4,
        minimumCapacity: null,
        sortOrder: null,
      });
      const { seatParty } = await import("@/workflows/seat-party/seat-party");
      const sessionAtB = await seatParty(database(), scenario.ownerAtB, {
        tableIds: [atB],
        partySize: 2,
        serverEmployeeId: null,
      });

      await expect(
        createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: sessionAtB.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const ended = await seatedSession(database(), scenario);

      await completeTableSession(database(), scenario.owner, ended.id, { expectedVersion: ended.version });
      await expect(
        createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: ended.id }),
      ).rejects.toMatchObject({ code: "SESSION_NOT_ACTIVE" });
    });

    it("opens a TAKEOUT order with no table and no session", async () => {
      const sessionsBefore = (await database().select().from(tableSessions)).length;
      const order = await createOrder(database(), scenario.serverActor, {
        orderType: "TAKEOUT",
        customerName: "  Pat  ",
      });
      const row = await orderRow(database(), order.id);

      expect(row).toMatchObject({ orderType: "TAKEOUT", tableSessionId: null, guestPartyId: null, customerName: "Pat" });
      expect((await database().select().from(tableSessions)).length).toBe(sessionsBefore);
    });

    it("refuses takeout where the location has it turned off", async () => {
      await database()
        .update(locationSettings)
        .set({ allowTakeout: false })
        .where(eq(locationSettings.locationId, scenario.locationA));

      await expect(
        createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT" }),
      ).rejects.toMatchObject({ code: "TAKEOUT_DISABLED" });
    });

    it("allows several orders on one session and keeps them through a move", async () => {
      const session = await seatedSession(database(), scenario);
      const first = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });
      const second = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });
      const newTable = await tableFixture(database(), scenario);

      await moveSession(database(), scenario.owner, session.id, {
        tableIds: [newTable],
        expectedVersion: await sessionVersion(session.id),
      });

      const listed = await listOrders(database(), scenario.serverActor, { tableSessionId: session.id });

      expect(listed.map((order) => order.id).sort()).toEqual([first.id, second.id].sort());
      expect(listed.every((order) => order.tableNumbers.length === 1)).toBe(true);
    });
  });

  describe("drafts", () => {
    async function openOrder() {
      return createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT" });
    }

    it("previews price and modifiers, edits and removes drafts, and moves no stock", async () => {
      const order = await openOrder();
      const added = await addDraftItem(database(), scenario.serverActor, order.id, {
        expectedVersion: order.version,
        menuItemId: burger.menuItem.id,
        quantity: 2,
        selections: burger.canonicalSelections,
        specialInstructions: "  Cut in half ",
      });
      const [draft] = await itemRows(database(), order.id);

      expect(draft).toMatchObject({
        status: "DRAFT",
        unitPriceSnapshot: "17.49",
        lineTotalSnapshot: "34.98",
        specialInstructions: "Cut in half",
        sendBatchId: null,
      });
      // Drafts are previews: the order subtotal counts only sent items.
      expect((await orderRow(database(), order.id)).subtotal).toBe("0.00");

      const edited = await updateDraftItem(database(), scenario.serverActor, order.id, draft!.id, {
        expectedVersion: added.orderVersion,
        quantity: 1,
        selections: burger.mediumOnly,
        specialInstructions: null,
      });
      const [after] = await itemRows(database(), order.id);

      expect(after).toMatchObject({ quantity: 1, unitPriceSnapshot: "15.99", lineTotalSnapshot: "15.99" });
      expect(
        await database().select().from(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, draft!.id)),
      ).toHaveLength(1);

      await removeDraftItem(database(), scenario.serverActor, order.id, draft!.id, { expectedVersion: edited.version });

      expect(await itemRows(database(), order.id)).toEqual([]);
      expect(
        await database()
          .select()
          .from(inventoryTransactions)
          .where(
            and(
              eq(inventoryTransactions.inventoryItemId, burger.stock.beef.id),
              eq(inventoryTransactions.transactionType, "CONSUME"),
            ),
          ),
      ).toEqual([]);
    });

    it("refuses invalid modifier selections with the shared validator", async () => {
      const order = await openOrder();
      const { temperature, toppings } = burger.groups;
      const { medium, wellDone, noOnion } = burger.modifiers;
      const attempt = (selections: { modifierGroupId: string; modifierId: string }[]) =>
        addDraftItem(database(), scenario.serverActor, order.id, {
          expectedVersion: order.version,
          menuItemId: burger.menuItem.id,
          quantity: 1,
          selections,
          specialInstructions: null,
        }).catch((error) => error.code);

      expect(await attempt([])).toBe("BELOW_MINIMUM");
      expect(
        await attempt([
          { modifierGroupId: temperature.id, modifierId: medium.id },
          { modifierGroupId: temperature.id, modifierId: wellDone.id },
        ]),
      ).toBe("ABOVE_MAXIMUM");
      expect(
        await attempt([
          { modifierGroupId: temperature.id, modifierId: medium.id },
          { modifierGroupId: toppings.id, modifierId: noOnion.id },
          { modifierGroupId: toppings.id, modifierId: noOnion.id },
        ]),
      ).toBe("DUPLICATE_SELECTION");
      expect(
        await attempt([
          { modifierGroupId: temperature.id, modifierId: medium.id },
          { modifierGroupId: temperature.id, modifierId: noOnion.id },
        ]),
      ).toBe("MODIFIER_NOT_IN_GROUP");

      const unrelated = await baconCheeseburger(database(), scenario);

      expect(
        await attempt([
          { modifierGroupId: temperature.id, modifierId: medium.id },
          { modifierGroupId: unrelated.groups.toppings.id, modifierId: unrelated.modifiers.noOnion.id },
        ]),
      ).toBe("GROUP_NOT_ATTACHED");

      await updateModifier(database(), scenario.owner, noOnion.id, {
        name: "No Onion",
        description: null,
        priceAdjustment: "0.00",
        preparationEffectType: "REMOVE_COMPONENT",
        preparationInstruction: "No onion",
        active: false,
        expectedVersion: noOnion.version,
      });
      expect(
        await attempt([
          { modifierGroupId: temperature.id, modifierId: medium.id },
          { modifierGroupId: toppings.id, modifierId: noOnion.id },
        ]),
      ).toBe("MODIFIER_INACTIVE");

      // A modifier removed from the group by the item's configuration is refused too.
      await setGroupModifier(database(), scenario.owner, toppings.id, {
        modifierId: burger.modifiers.extraPickles.id,
        displayOrder: 1,
        active: false,
      });
      expect(
        await attempt([
          { modifierGroupId: temperature.id, modifierId: medium.id },
          { modifierGroupId: toppings.id, modifierId: burger.modifiers.extraPickles.id },
        ]),
      ).toBe("MODIFIER_INACTIVE");
      expect(await itemRows(database(), order.id)).toEqual([]);
    });

    it("refuses a stale version and an unknown item", async () => {
      const order = await openOrder();

      await addDraftItem(database(), scenario.serverActor, order.id, {
        expectedVersion: order.version,
        menuItemId: burger.menuItem.id,
        quantity: 1,
        selections: burger.mediumOnly,
        specialInstructions: null,
      });
      await expect(
        addDraftItem(database(), scenario.serverActor, order.id, {
          expectedVersion: order.version,
          menuItemId: burger.menuItem.id,
          quantity: 1,
          selections: burger.mediumOnly,
          specialInstructions: null,
        }),
      ).rejects.toMatchObject({ code: "CONCURRENCY_CONFLICT" });
      await expect(
        addDraftItem(database(), scenario.serverActor, order.id, {
          expectedVersion: order.version + 1,
          menuItemId: scenario.organizationId,
          quantity: 1,
          selections: [],
          specialInstructions: null,
        }),
      ).rejects.toMatchObject({ code: "ITEM_NOT_SELLABLE" });
    });
  });

  describe("table session completion", () => {
    it("is blocked while any order on the session is OPEN, through every path", async () => {
      const session = await seatedSession(database(), scenario);
      const order = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });

      await expect(
        completeTableSession(database(), scenario.owner, session.id, { expectedVersion: session.version }),
      ).rejects.toMatchObject({ code: "ORDERS_OPEN" });
      await expect(
        cancelTableSession(database(), scenario.owner, session.id, { reason: "Mistake", expectedVersion: session.version }),
      ).rejects.toMatchObject({ code: "ORDERS_OPEN" });
      // The Restaurant service on its own can't bypass it: the database refuses.
      await expect(
        completeSession(database(), scenario.owner, session.id, { expectedVersion: session.version }),
      ).rejects.toBeTruthy();
      expect(
        (await database().select().from(tableSessions).where(eq(tableSessions.id, session.id)))[0]!.status,
      ).toBe("ACTIVE");
      expect(
        (await database().select().from(tableSessionTables).where(eq(tableSessionTables.tableSessionId, session.id)))[0]!.leftAt,
      ).toBeNull();

      // Phase 9 has no close; a voided order no longer blocks.
      const row = await orderRow(database(), order.id);

      await voidOrder(database(), scenario.manager, order.id, {
        reason: "Wrong table",
        expectedVersion: row.version,
        dispositions: {},
      });
      await completeTableSession(database(), scenario.owner, session.id, { expectedVersion: session.version });
    });

    it("shows the order detail with snapshots only", async () => {
      const session = await seatedSession(database(), scenario);
      const order = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });
      const detail = await getOrderDetail(database(), scenario.viewOnly, order.id);

      expect(detail).toMatchObject({ id: order.id, status: "OPEN", items: [], tableNumbers: [expect.any(String)] });
      expect(JSON.stringify(detail)).not.toMatch(/cost|recipe/i);
    });
  });
});
