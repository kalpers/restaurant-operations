import { eq, inArray, sql as sqlText } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { readConstraintName } from "@/db/helpers/database-errors";
import {
  inventoryTransactions,
  kitchenTicketItems,
  kitchenTickets,
  menuItems,
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderItems,
  orderSendBatches,
} from "@/db/schema";
import type { Actor } from "@/modules/auth/types";
import { reconcileBalances } from "@/modules/inventory/queries/stock-queries";
import { fireCourse, heldCoursesForOrder } from "@/modules/kitchen/services/course-fire-service";
import { getOperationalMenu } from "@/modules/menu/queries/operational-menu";
import { saveBundleConfiguration } from "@/modules/menu/services/bundle-service";
import { addBundleDraft } from "@/modules/orders/services/bundle-draft-service";
import { applyItemDiscount, createDiscountDefinition } from "@/modules/orders/services/discount-service";
import { addDraftItem, removeDraftItem } from "@/modules/orders/services/draft-item-service";
import { recordOrderAllergy } from "@/modules/orders/services/order-allergy-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { AppError } from "@/shared/errors/app-error";
import { runReport } from "@/modules/reporting/services/report-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { moveOrderItems } from "@/workflows/move-order-items/move-order-items";
import { setItemSeat } from "@/workflows/set-item-seat/set-item-seat";
import { splitOrderItem } from "@/workflows/split-order-item/split-order-item";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { allergenList, tagBurger } from "../../fixtures/allergen-fixtures";
import { actorWith } from "../../fixtures/employee-fixtures";
import { sellableItem } from "../../fixtures/menu-fixtures";
import {
  baconCheeseburger,
  clearOrderData,
  createOrderScenario,
  itemRows,
  MANAGER_ORDER_PERMISSIONS,
  newKey,
  onHand,
  orderRow,
  plainItem,
  seatedSession,
  type Burger,
  type OrderScenario,
} from "../../fixtures/order-fixtures";
import { MANAGER_SETTLEMENT_PERMISSIONS, tender } from "../../fixtures/settlement-fixtures";

// Phase 36 part 5 (policy 9): a bundle is a priced line plus zero-priced component lines, each an
// ordinary order item with every snapshot, so SEND, the kitchen and inventory are unchanged.

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    if (error instanceof AppError) {
      return error.code;
    }

    return readConstraintName(error) ?? (error as Error).message;
  }

  return undefined;
}

describe("prix-fixe and combo items (Phase 36 part 5)", () => {
  let scenario: OrderScenario;
  let burger: Burger;
  let manager: Actor;
  let combo: Awaited<ReturnType<typeof setUpCombo>>;

  /** "Burger Combo" at 18.00: the burger, Fries or Onion rings (+1.50), and a Soda. */
  async function setUpCombo() {
    const fries = await plainItem(database(), scenario.owner, "4.00", "Fries");
    const rings = await plainItem(database(), scenario.owner, "5.00", "Onion rings");
    const soda = await plainItem(database(), scenario.owner, "3.00", "Soda");
    const { item } = await sellableItem(database(), scenario.owner, { price: "18.00", name: "Burger Combo" });
    const config = await saveBundleConfiguration(database(), scenario.owner, item.id, {
      expectedVersion: item.version,
      slots: [
        { name: "Main", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [{ componentMenuItemId: burger.menuItem.id, upcharge: "0" }] },
        {
          name: "Side",
          defaultCourse: 1,
          minimumChoices: 1,
          maximumChoices: 1,
          options: [
            { componentMenuItemId: fries.id, upcharge: "0", isDefault: true },
            { componentMenuItemId: rings.id, upcharge: "1.50" },
          ],
        },
        { name: "Drink", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [{ componentMenuItemId: soda.id, upcharge: "0" }] },
      ],
    });
    const slot = (name: string) => config.slots.find((entry) => entry.name === name)!.id;

    return { item, fries, rings, soda, main: slot("Main"), side: slot("Side"), drink: slot("Drink") };
  }

  beforeEach(async () => {
    scenario = await createOrderScenario(database());
    burger = await baconCheeseburger(database(), scenario);
    manager = await actorWith(database(), scenario, [...MANAGER_ORDER_PERMISSIONS, "orders.move-items", "orders.create"]);
    combo = await setUpCombo();
  });

  const settlementVersion = async (settlementId: string) =>
    (await database().execute<{ version: number }>(sqlText`SELECT version FROM order_settlements WHERE id = ${settlementId}`))[0]!.version;

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function dineInOrder() {
    const session = await seatedSession(database(), scenario);

    return { session, order: await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id }) };
  }

  const choices = (side = combo.rings.id) => [
    { slotId: combo.main, menuItemId: burger.menuItem.id, selections: burger.canonicalSelections, specialInstructions: "Toasted bun" },
    { slotId: combo.side, menuItemId: side, selections: [], specialInstructions: null },
    { slotId: combo.drink, menuItemId: combo.soda.id, selections: [], specialInstructions: null },
  ];

  const addCombo = (orderId: string, version: number, side?: string) =>
    addBundleDraft(database(), scenario.serverActor, orderId, { menuItemId: combo.item.id, choices: choices(side), expectedVersion: version });

  it("sends the canonical Burger Combo: one priced line, components with their own snapshots, consumption and tickets", async () => {
    const { order } = await dineInOrder();
    const added = await addCombo(order.id, order.version);
    const key = newKey();
    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: key });
    const rows = await itemRows(database(), order.id);
    const parent = rows.find((row) => row.id === added.itemId)!;
    const children = rows.filter((row) => row.bundleParentOrderItemId === added.itemId);
    const child = (name: string) => children.find((row) => row.menuItemNameSnapshot === name)!;

    // The bundle line carries the money: 18.00 plus the 1.50 onion rings upcharge.
    expect(parent).toMatchObject({
      status: "SUBMITTED",
      menuItemNameSnapshot: "Burger Combo",
      basePriceSnapshot: "18.00",
      modifierTotalSnapshot: "1.50",
      unitPriceSnapshot: "19.50",
      lineTotalSnapshot: "19.50",
      recipeId: null,
      prepStationIdsSnapshot: [],
    });
    expect(children).toHaveLength(3);
    expect(children.every((row) => row.lineTotalSnapshot === "0.00" && row.status === "SUBMITTED" && row.sendBatchId === sent.batchId)).toBe(true);
    expect(child("Onion rings")).toMatchObject({ bundleSlotNameSnapshot: "Side", bundleNameSnapshot: "Burger Combo", bundleUpchargeSnapshot: "1.50" });
    expect(child("Bacon Cheeseburger")).toMatchObject({
      recipeId: burger.recipe.id,
      recipeVersionId: burger.revision.id,
      kitchenInstructionsSnapshot: "Cook medium; No onion; Extra pickles; Swiss, not American; Toasted bun",
      prepStationIdsSnapshot: [burger.grill.id],
      bundleUpchargeSnapshot: "0.00",
      taxCategoryId: null,
    });
    expect((await orderRow(database(), order.id)).subtotal).toBe("19.50");

    // The burger's modifiers keep their names but carry no price inside the bundle.
    const modifiers = await database().select().from(orderItemModifiers).where(eq(orderItemModifiers.orderItemId, child("Bacon Cheeseburger").id));

    expect(modifiers.map((row) => row.priceAdjustmentSnapshot)).toEqual(["0.00", "0.00", "0.00", "0.00"]);

    // The burger consumes exactly what the canonical burger does; the bundle line consumes nothing.
    const consumption = await database()
      .select()
      .from(orderItemInventoryConsumption)
      .where(inArray(orderItemInventoryConsumption.orderItemId, rows.map((row) => row.id)));
    const { beef, bun, swiss, pickles, bacon } = burger.stock;

    expect(consumption.every((row) => row.orderItemId === child("Bacon Cheeseburger").id)).toBe(true);
    expect(new Map(consumption.map((row) => [row.inventoryItemId, row.baseQuantity]))).toEqual(
      new Map([
        [beef.id, "8.0000"],
        [bun.id, "1.0000"],
        [swiss.id, "1.0000"],
        [pickles.id, "5.0000"],
        [bacon.id, "2.0000"],
      ]),
    );
    expect(await onHand(database(), beef.id)).toBe("92.0000");
    expect(await reconcileBalances(database(), scenario.organizationId)).toEqual([]);

    // The kitchen gets the burger, named with its bundle; the bundle line makes no ticket.
    const tickets = await database().select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderId, order.id));

    expect(tickets.map((row) => [row.orderItemId, row.menuItemNameSnapshot])).toEqual([[child("Bacon Cheeseburger").id, "Bacon Cheeseburger (Burger Combo)"]]);

    // A retry with the same key adds no batch, ticket, ledger row or snapshot.
    const ledgerBefore = (await database().select().from(inventoryTransactions)).length;
    const retry = await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: key });

    expect(retry).toMatchObject({ replayed: true, batchId: sent.batchId });
    expect(await database().select().from(orderSendBatches).where(eq(orderSendBatches.orderId, order.id))).toHaveLength(1);
    expect(await database().select().from(kitchenTicketItems).where(eq(kitchenTicketItems.orderId, order.id))).toHaveLength(1);
    expect((await database().select().from(inventoryTransactions)).length).toBe(ledgerBefore);
  });

  it("checks the choices, and offers a bundle only while each course can be filled", async () => {
    const { order } = await dineInOrder();

    expect(
      await codeOf(
        addBundleDraft(database(), scenario.serverActor, order.id, {
          menuItemId: combo.item.id,
          choices: choices().slice(0, 2),
          expectedVersion: order.version,
        }),
      ),
    ).toBe("BUNDLE_CHOICES_REQUIRED");
    expect(
      await codeOf(addDraftItem(database(), scenario.serverActor, order.id, { menuItemId: combo.item.id, quantity: 1, selections: [], specialInstructions: null, expectedVersion: order.version })),
    ).toBe("BUNDLE_CHOICES_REQUIRED");

    // Onion rings unavailable: the Side course still has Fries, so the bundle is offered without them.
    await database().update(menuItems).set({ available: false }).where(eq(menuItems.id, combo.rings.id));

    const findCombo = async () =>
      (await getOperationalMenu(database(), scenario.serverActor))
        .menus.flatMap((menu) => menu.categories.flatMap((category) => category.items))
        .find((item) => item.menuItemId === combo.item.id);

    expect((await findCombo())!.bundle!.slots.find((slot) => slot.name === "Side")!.options.map((option) => option.name)).toEqual(["Fries"]);
    expect(await codeOf(addCombo(order.id, order.version))).toBe("BUNDLE_OPTION_UNAVAILABLE");

    // With the Soda gone too, the Drink course can't be filled, so the bundle isn't sold.
    await database().update(menuItems).set({ available: false }).where(eq(menuItems.id, combo.soda.id));
    expect(await findCombo()).toBeUndefined();
  });

  it("voids a bundle with its components, and a component alone without changing the price", async () => {
    const { order } = await dineInOrder();
    const added = await addCombo(order.id, order.version);
    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });
    const [soda] = (await itemRows(database(), order.id)).filter((row) => row.menuItemNameSnapshot === "Soda");
    const afterChild = await voidOrderItem(database(), manager, order.id, soda!.id, {
      reason: "Guest skipped the drink",
      disposition: "UNPREPARED",
      expectedVersion: sent.orderVersion,
    });

    expect((await orderRow(database(), order.id)).subtotal).toBe("19.50");

    await voidOrderItem(database(), manager, order.id, added.itemId, {
      reason: "Wrong order",
      disposition: "UNPREPARED",
      expectedVersion: afterChild.version,
    });

    const rows = await itemRows(database(), order.id);

    expect(rows.every((row) => row.status === "VOIDED")).toBe(true);
    expect((await orderRow(database(), order.id)).subtotal).toBe("0.00");
    // The never-prepared burger's stock came back.
    expect(await onHand(database(), burger.stock.beef.id)).toBe("100.0000");
  });

  it("keeps a bundle whole for moves, seats, discounts and drafts", async () => {
    const { session, order } = await dineInOrder();
    const added = await addCombo(order.id, order.version);
    const sent = await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });
    const component = added.componentIds[0]!;
    const definition = await createDiscountDefinition(database(), manager, {
      code: `TEN_${Date.now()}`,
      name: "Ten percent",
      scope: "ITEM",
      discountType: "PERCENTAGE",
      value: "10",
    });

    expect(await codeOf(applyItemDiscount(database(), manager, order.id, component, { discountDefinitionId: definition.id, reason: "x", expectedVersion: sent.orderVersion }))).toBe(
      "BUNDLE_COMPONENT",
    );
    expect(await codeOf(setItemSeat(database(), scenario.serverActor, order.id, component, { expectedVersion: sent.orderVersion, seatNumber: 2 }))).toBe(
      "BUNDLE_COMPONENT",
    );

    const seated = await setItemSeat(database(), scenario.serverActor, order.id, added.itemId, { expectedVersion: sent.orderVersion, seatNumber: 2 });

    expect((await itemRows(database(), order.id)).every((row) => row.seatNumber === 2)).toBe(true);

    const second = await createOrder(database(), scenario.serverActor, { orderType: "DINE_IN", tableSessionId: session.id });

    expect(
      await codeOf(
        moveOrderItems(database(), manager, order.id, {
          itemIds: [component],
          expectedVersion: seated.version,
          idempotencyKey: newKey(),
          target: { orderId: second.id, expectedVersion: second.version },
        }),
      ),
    ).toBe("BUNDLE_COMPONENT");

    await moveOrderItems(database(), manager, order.id, {
      itemIds: [added.itemId],
      expectedVersion: seated.version,
      idempotencyKey: newKey(),
      target: { orderId: second.id, expectedVersion: second.version },
    });

    expect(await itemRows(database(), order.id)).toEqual([]);
    expect(await itemRows(database(), second.id)).toHaveLength(4);
    expect((await orderRow(database(), second.id)).subtotal).toBe("19.50");

    // The database keeps a component's bundle snapshots frozen, and the component with its bundle.
    expect(await codeOf(database().update(orderItems).set({ bundleUpchargeSnapshot: "0.00" }).where(eq(orderItems.id, added.componentIds[1]!)))).toBe(
      "order_items_frozen",
    );
  });

  it("adds and removes a bundle draft as a whole", async () => {
    const { order } = await dineInOrder();
    const added = await addCombo(order.id, order.version, combo.fries.id);

    // A draft previews its price on the line (the check counts sent items only).
    expect((await itemRows(database(), order.id)).find((row) => row.id === added.itemId)!.lineTotalSnapshot).toBe("18.00");
    expect(await codeOf(removeDraftItem(database(), scenario.serverActor, order.id, added.componentIds[0]!, { expectedVersion: added.orderVersion }))).toBe(
      "BUNDLE_COMPONENT",
    );

    await removeDraftItem(database(), scenario.serverActor, order.id, added.itemId, { expectedVersion: added.orderVersion });
    expect(await itemRows(database(), order.id)).toEqual([]);
  });

  it("reports the bundle with its components' cost, and the components on their own", async () => {
    const cashier = await actorWith(database(), scenario, [...MANAGER_SETTLEMENT_PERMISSIONS, "reports.view", "reports.sales", "inventory.cost.view"]);
    const { order } = await dineInOrder();
    const added = await addCombo(order.id, order.version);

    await sendOrderItems(database(), scenario.serverActor, order.id, { expectedVersion: added.orderVersion, idempotencyKey: newKey() });

    const due = (await orderRow(database(), order.id)).totalDue;
    const settlement = await openSettlement(database(), cashier, order.id);

    await tender(database(), cashier, settlement.settlementId, { tenderType: "EXTERNAL_CARD", amount: due, cardBrand: "VISA", cardLastFour: "4242" });
    await completeSettlement(database(), cashier, settlement.settlementId, { expectedVersion: await settlementVersion(settlement.settlementId), idempotencyKey: newKey() });

    const today = (await readLocationClock(database(), scenario.locationA, new Date())).businessDate;
    const report = await runReport(database(), cashier, "menu", { locationId: scenario.locationA, from: today, to: today });
    const section = (key: string) => report.sections.find((entry) => entry.key === key)!;
    const comboRow = section("items").rows.find((row) => row.name === "Burger Combo")!;

    // The bundle line carries the sales, and its cost is its burger's consumption.
    expect(comboRow).toMatchObject({ quantity: 1, grossSales: "19.50" });
    expect(Number(comboRow.theoreticalCost)).toBeGreaterThan(0);
    expect(section("items").rows.some((row) => row.name === "Bacon Cheeseburger")).toBe(false);
    expect(section("itemMix").rows.map((row) => row.name)).toEqual(["Burger Combo"]);
    expect(section("bundle-components").rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bundle: "Burger Combo", course: "Side", component: "Onion rings", quantity: 1, upcharges: "1.50" }),
        expect.objectContaining({ bundle: "Burger Combo", course: "Main", component: "Bacon Cheeseburger", quantity: 1 }),
      ]),
    );
  });

  it("refuses a bundle with its own prep, and a bundle as a component", async () => {
    const [current] = await database().select().from(menuItems).where(eq(menuItems.id, burger.menuItem.id));

    expect(
      await codeOf(
        saveBundleConfiguration(database(), scenario.owner, burger.menuItem.id, {
          expectedVersion: current!.version,
          slots: [{ name: "Side", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [{ componentMenuItemId: combo.fries.id, upcharge: "0" }] }],
        }),
      ),
    ).toBe("BUNDLE_HAS_OWN_PREP");

    const { item } = await sellableItem(database(), scenario.owner, { price: "30.00", name: "Family deal" });

    expect(
      await codeOf(
        saveBundleConfiguration(database(), scenario.owner, item.id, {
          expectedVersion: item.version,
          slots: [{ name: "Combo", defaultCourse: 1, minimumChoices: 1, maximumChoices: 1, options: [{ componentMenuItemId: combo.item.id, upcharge: "0" }] }],
        }),
      ),
    ).toBe("BUNDLE_COMPONENT_INVALID");
  });

  it("asks for an allergy acknowledgment on the component, never on the bundle line", async () => {
    const list = await allergenList(database(), scenario.owner);

    await tagBurger(database(), scenario.owner, burger, list);

    const order = await createOrder(database(), scenario.serverActor, { orderType: "TAKEOUT", customerName: "Pickup" });
    const allergy = await recordOrderAllergy(database(), scenario.serverActor, {
      orderId: order.id,
      expectedVersion: order.version,
      allergenId: list.MILK.id,
      severity: "SEVERE",
      note: null,
    });
    const added = await addCombo(order.id, allergy.orderVersion);
    const components = (await itemRows(database(), order.id)).filter((row) => row.bundleParentOrderItemId === added.itemId);
    const burgerPart = components.find((row) => row.menuItemId === burger.menuItem.id)!;
    const key = newKey();
    const refusal = await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: key,
    }).catch((error: unknown) => error);

    // Each component is checked on its own (the untagged side and drink are unreviewed, so possible
    // conflicts); the bundle line, which has no recipe, is never on the list.
    expect(refusal).toMatchObject({ code: "ALLERGEN_ACKNOWLEDGMENT_REQUIRED" });

    const flagged = (refusal as { details: { items: { orderItemId: string; allergens: string[] }[] } }).details.items;

    expect(flagged.map((item) => item.orderItemId).sort()).toEqual(components.map((row) => row.id).sort());
    expect(flagged.find((item) => item.orderItemId === burgerPart.id)!.allergens).toEqual(["MILK"]);
    expect((await itemRows(database(), order.id)).every((row) => row.status === "DRAFT")).toBe(true);

    await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: key,
      acknowledgedAllergenItemIds: components.map((row) => row.id),
    });

    const rows = await itemRows(database(), order.id);

    expect(rows.find((row) => row.id === burgerPart.id)!.allergyAcknowledgedAt).not.toBeNull();
    expect(rows.find((row) => row.id === added.itemId)!.allergyAcknowledgedAt).toBeNull();
  });

  it("holds and fires a component's course like any item, and shares only the bundle line", async () => {
    const { order } = await dineInOrder();
    const firer = await actorWith(database(), scenario, [...MANAGER_ORDER_PERMISSIONS, "orders.fire", "orders.move-items", "orders.create"]);
    const added = await addBundleDraft(database(), scenario.serverActor, order.id, {
      menuItemId: combo.item.id,
      choices: choices().map((choice) => (choice.slotId === combo.main ? { ...choice, courseNumber: 2 } : choice)),
      expectedVersion: order.version,
    });

    await sendOrderItems(database(), scenario.serverActor, order.id, {
      expectedVersion: added.orderVersion,
      idempotencyKey: newKey(),
      fire: "FIRST_COURSE",
    });

    const burgerPart = (await itemRows(database(), order.id)).find(
      (row) => row.bundleParentOrderItemId === added.itemId && row.menuItemId === burger.menuItem.id,
    )!;
    const [ticket] = await database()
      .select({ id: kitchenTickets.id, courseNumber: kitchenTickets.courseNumber, heldAt: kitchenTickets.heldAt })
      .from(kitchenTickets)
      .innerJoin(kitchenTicketItems, eq(kitchenTicketItems.ticketId, kitchenTickets.id))
      .where(eq(kitchenTicketItems.orderItemId, burgerPart.id));

    expect(burgerPart.courseNumber).toBe(2);
    expect(ticket).toMatchObject({ courseNumber: 2 });
    expect(ticket!.heldAt).not.toBeNull();
    expect(await heldCoursesForOrder(database(), order.id)).toEqual([2]);
    expect((await fireCourse(database(), firer, order.id, 2)).firedTicketIds).toEqual([ticket!.id]);
    expect(await heldCoursesForOrder(database(), order.id)).toEqual([]);

    // A component can't be shared; the bundle line can, and its components stay where they are.
    const share = (itemId: string) =>
      orderRow(database(), order.id).then((row) =>
        splitOrderItem(database(), firer, order.id, itemId, {
          shareCount: 2,
          targets: [{ orderId: order.id, expectedVersion: row.version }, { newCheck: true }],
          expectedVersion: row.version,
          idempotencyKey: newKey(),
        }),
      );

    expect(await codeOf(share(burgerPart.id))).toMatch(/BUNDLE/);

    await share(added.itemId);

    const rows = await itemRows(database(), order.id);

    expect(rows.find((row) => row.id === added.itemId)!.status).toBe("SPLIT");
    expect(rows.filter((row) => row.bundleParentOrderItemId === added.itemId)).toHaveLength(3);
  });
});
