import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { auditEvents, inventoryTransactions, kitchenTickets, orderItemTransfers, orders } from "@/db/schema";
import { getExpoView, getStationQueue } from "@/modules/kitchen/queries/kitchen-queries";
import { readOrderDetail } from "@/modules/orders/queries/order-queries";
import { applyItemDiscount, applyOrderDiscount, createDiscountDefinition } from "@/modules/orders/services/discount-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { moveOrderItems } from "@/workflows/move-order-items/move-order-items";
import { setItemSeat } from "@/workflows/set-item-seat/set-item-seat";
import { splitCheckBySeat } from "@/workflows/split-by-seat/split-by-seat";
import { splitOrderItem } from "@/workflows/split-order-item/split-order-item";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";
import { voidOrderItem } from "@/workflows/void-order-item/void-order-item";

import { actorWith } from "../../fixtures/employee-fixtures";
import {
  COOK_PERMISSIONS,
  createKitchenScenario,
  outboxFor,
  ticketItemsForOrder,
  type KitchenScenario,
} from "../../fixtures/kitchen-fixtures";
import { uniqueCode } from "../../fixtures/menu-fixtures";
import {
  clearOrderData,
  itemRows,
  MANAGER_ORDER_PERMISSIONS,
  newKey,
  orderRow,
  seatedSession,
  SERVER_ORDER_PERMISSIONS,
} from "../../fixtures/order-fixtures";
import { settlementRow, tender } from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : `DB:${(error as Error).message}`;
  }

  return undefined;
}

describe("seat numbers and split by seat (Phase 29)", () => {
  let scenario: KitchenScenario;
  let server: Awaited<ReturnType<typeof actorWith>>;
  let manager: Awaited<ReturnType<typeof actorWith>>;

  beforeEach(async () => {
    scenario = await createKitchenScenario(database());
    server = await actorWith(database(), scenario.base, [
      ...SERVER_ORDER_PERMISSIONS,
      "orders.move-items",
      "settlements.view",
      "settlements.create",
      "settlements.tender.cash",
      "settlements.complete",
    ]);
    manager = await actorWith(database(), scenario.base, [
      ...MANAGER_ORDER_PERMISSIONS,
      ...COOK_PERMISSIONS,
      "orders.move-items",
    ]);
  });

  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  async function checkAtTable(partySize = 3) {
    const session = await seatedSession(database(), scenario.base, { partySize });
    const order = await createOrder(database(), server, { orderType: "DINE_IN", tableSessionId: session.id });

    return { ...order, sessionId: session.id };
  }

  async function add(orderId: string, menuItemId: string, seatNumber?: number | null) {
    return addDraftItem(database(), server, orderId, {
      expectedVersion: (await orderRow(database(), orderId)).version,
      menuItemId,
      quantity: 1,
      selections: [],
      specialInstructions: null,
      ...(seatNumber === undefined ? {} : { seatNumber }),
    });
  }

  async function send(orderId: string) {
    return sendOrderItems(database(), server, orderId, {
      expectedVersion: (await orderRow(database(), orderId)).version,
      idempotencyKey: newKey(),
    });
  }

  async function seat(orderId: string, itemId: string, seatNumber: number | null, actor = server) {
    return setItemSeat(database(), actor, orderId, itemId, {
      expectedVersion: (await orderRow(database(), orderId)).version,
      seatNumber,
    });
  }

  async function split(orderId: string, key = newKey(), actor = server) {
    return splitCheckBySeat(database(), actor, orderId, {
      expectedVersion: (await orderRow(database(), orderId)).version,
      idempotencyKey: key,
    });
  }

  const checksAt = (sessionId: string) =>
    database().select({ id: orders.id }).from(orders).where(eq(orders.tableSessionId, sessionId));

  it("stores the seat given on add, Table when none, and refuses seats on takeout", async () => {
    const check = await checkAtTable();
    const onSeat = await add(check.id, scenario.fries.id, 2);
    const onTable = await add(check.id, scenario.fries.id);
    const rows = await itemRows(database(), check.id);

    expect(rows.find((row) => row.id === onSeat.itemId)?.seatNumber).toBe(2);
    expect(rows.find((row) => row.id === onTable.itemId)?.seatNumber).toBeNull();

    const detail = await readOrderDetail(database(), server, check.id);

    expect(detail.partySize).toBe(3);
    expect(detail.items.find((item) => item.id === onSeat.itemId)?.seatNumber).toBe(2);

    const takeout = await createOrder(database(), server, { orderType: "TAKEOUT" });

    expect(await codeOf(add(takeout.id, scenario.fries.id, 1))).toBe("SEAT_NOT_ALLOWED");
    expect(await codeOf(add(takeout.id, scenario.fries.id, null))).toBeUndefined();
    expect(await codeOf(add(check.id, scenario.fries.id, 31))).toBe("INVALID_SEAT");
    // The database is the final word on the range.
    expect(
      await codeOf(database().execute(sql`UPDATE order_items SET seat_number = 0 WHERE id = ${onSeat.itemId}`)),
    ).toMatch(/^DB:/);
  });

  it("changes a sent item's seat without touching snapshots, tickets, stock or the audit trail", async () => {
    const check = await checkAtTable();

    await addDraftItem(database(), server, check.id, {
      expectedVersion: (await orderRow(database(), check.id)).version,
      menuItemId: scenario.burger.menuItem.id,
      quantity: 1,
      selections: scenario.burger.canonicalSelections,
      specialInstructions: null,
      seatNumber: 1,
    });
    await add(check.id, scenario.fries.id, 2);
    await send(check.id);

    const [burger, fries] = await itemRows(database(), check.id);
    const ticketsBefore = await ticketItemsForOrder(database(), check.id);
    const [{ ledger: ledgerBefore }] = await database()
      .select({ ledger: sql<number>`count(*)::int` })
      .from(inventoryTransactions);
    const [{ audits: auditsBefore }] = await database()
      .select({ audits: sql<number>`count(*)::int` })
      .from(auditEvents);
    const versionBefore = (await orderRow(database(), check.id)).version;

    const result = await seat(check.id, burger!.id, 3);

    expect(result).toMatchObject({ seatNumber: 3, version: versionBefore + 1 });

    const [after] = (await itemRows(database(), check.id)).filter((row) => row.id === burger!.id);
    // Everything but the seat, the row version and updated_at is as it was.
    const frozen = (row: typeof after) =>
      Object.fromEntries(
        Object.entries(row!).filter(([column]) => !["seatNumber", "version", "updatedAt"].includes(column)),
      );

    expect(after!.seatNumber).toBe(3);
    expect(frozen(after)).toEqual(frozen(burger));
    expect(await ticketItemsForOrder(database(), check.id)).toEqual(ticketsBefore);
    expect(
      (await database().select({ ledger: sql<number>`count(*)::int` }).from(inventoryTransactions))[0]!.ledger,
    ).toBe(ledgerBefore);
    expect((await database().select({ audits: sql<number>`count(*)::int` }).from(auditEvents))[0]!.audits).toBe(
      auditsBefore,
    );

    const events = (await outboxFor(database(), [check.id])).filter((event) => event.eventType === "order.item-seat-changed");

    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({ orderItemId: burger!.id, seatNumber: 3 });

    // Clearing to Table works; the same seat again changes nothing.
    await seat(check.id, fries!.id, null);

    const unchanged = (await orderRow(database(), check.id)).version;

    expect((await seat(check.id, fries!.id, null)).version).toBe(unchanged);

    // A draft's seat change emits no event.
    const draft = await add(check.id, scenario.fries.id, 1);

    await seat(check.id, draft.itemId, 2);

    expect(
      (await outboxFor(database(), [check.id])).filter(
        (event) => event.eventType === "order.item-seat-changed" && (event.payload as { orderItemId: string }).orderItemId === draft.itemId,
      ),
    ).toHaveLength(0);
  });

  it("refuses a seat change on a stale version, a voided item, while settling and once closed", async () => {
    const check = await checkAtTable();

    await add(check.id, scenario.fries.id, 1);
    await add(check.id, scenario.fries.id, 2);
    await send(check.id);

    const [first, second] = await itemRows(database(), check.id);

    expect(
      await codeOf(setItemSeat(database(), server, check.id, first!.id, { expectedVersion: 1, seatNumber: 2 })),
    ).toBe("CONCURRENCY_CONFLICT");

    await voidOrderItem(database(), manager, check.id, second!.id, {
      reason: "Wrong item",
      disposition: "UNPREPARED",
      expectedVersion: (await orderRow(database(), check.id)).version,
    });

    expect(await codeOf(seat(check.id, second!.id, 3))).toBe("ITEM_VOIDED");

    const viewer = await actorWith(database(), scenario.base, ["orders.view"]);

    expect(await codeOf(seat(check.id, first!.id, 3, viewer))).toBe("PERMISSION_DENIED");

    const settlement = await openSettlement(database(), server, check.id);

    expect(await codeOf(seat(check.id, first!.id, 3))).toBe("SETTLEMENT_IN_PROGRESS");

    const due = (await orderRow(database(), check.id)).totalDue;

    await tender(database(), server, settlement.settlementId, { amount: due, receivedAmount: due });
    await completeSettlement(database(), server, settlement.settlementId, {
      expectedVersion: (await settlementRow(database(), settlement.settlementId)).version,
      idempotencyKey: newKey(),
    });

    expect((await orderRow(database(), check.id)).status).toBe("CLOSED");
    expect(await codeOf(seat(check.id, first!.id, 3))).toBe("ORDER_NOT_OPEN");
  });

  it("shows the current seat on the station queue and Expo", async () => {
    const check = await checkAtTable();

    await add(check.id, scenario.fries.id, 2);
    await send(check.id);

    const [fries] = await itemRows(database(), check.id);
    const queueSeat = async () =>
      (await getStationQueue(database(), scenario.cook, { stationType: "KITCHEN" })).active
        .flatMap((ticket) => ticket.items)
        .find((item) => item.orderItemId === fries!.id)?.seatNumber;
    const expoSeat = async () =>
      (await getExpoView(database(), scenario.cook)).orders
        .find((order) => order.orderId === check.id)
        ?.items.find((item) => item.orderItemId === fries!.id)?.seatNumber;

    expect(await queueSeat()).toBe(2);
    expect(await expoSeat()).toBe(2);

    await seat(check.id, fries!.id, 4);

    expect(await queueSeat()).toBe(4);
    expect(await expoSeat()).toBe(4);
  });

  it("keeps the seat when an item moves and on a shared item's original", async () => {
    const check = await checkAtTable();

    await add(check.id, scenario.fries.id, 2);
    await add(check.id, scenario.cocktail.id, 3);
    await send(check.id);

    const [fries, cocktail] = await itemRows(database(), check.id);
    const moved = await moveOrderItems(database(), server, check.id, {
      itemIds: [fries!.id],
      expectedVersion: (await orderRow(database(), check.id)).version,
      idempotencyKey: newKey(),
      target: { newCheck: true },
    });

    expect((await itemRows(database(), moved.targetOrderId))[0]).toMatchObject({ id: fries!.id, seatNumber: 2 });

    await splitOrderItem(database(), server, check.id, cocktail!.id, {
      shareCount: 2,
      targets: [{ orderId: check.id, expectedVersion: (await orderRow(database(), check.id)).version }, { newCheck: true }],
      expectedVersion: (await orderRow(database(), check.id)).version,
      idempotencyKey: newKey(),
    });

    expect((await itemRows(database(), check.id)).find((row) => row.id === cocktail!.id)).toMatchObject({
      status: "SPLIT",
      seatNumber: 3,
    });

    // Amendment 4: a shared original's seat can still change; nothing else about it can.
    await seat(check.id, cocktail!.id, 1);

    expect((await itemRows(database(), check.id)).find((row) => row.id === cocktail!.id)?.seatNumber).toBe(1);
    expect(
      await codeOf(database().execute(sql`UPDATE order_items SET special_instructions = 'x' WHERE id = ${cocktail!.id}`)),
    ).toMatch(/^DB:/);
  });

  it("leaves a shared original on the first check when splitting by seat", async () => {
    const check = await checkAtTable();

    await add(check.id, scenario.fries.id, 1);
    await add(check.id, scenario.fries.id, 2);
    await add(check.id, scenario.cocktail.id, 3);
    await send(check.id);

    const [, , cocktail] = await itemRows(database(), check.id);

    await splitOrderItem(database(), server, check.id, cocktail!.id, {
      shareCount: 2,
      targets: [{ orderId: check.id, expectedVersion: (await orderRow(database(), check.id)).version }, { newCheck: true }],
      expectedVersion: (await orderRow(database(), check.id)).version,
      idempotencyKey: newKey(),
    });

    const result = await split(check.id);

    expect(result.checks.map((entry) => entry.seat)).toEqual([2]);
    expect((await itemRows(database(), check.id)).map((row) => row.id)).toContain(cocktail!.id);
  });

  it("splits a check by seat through recorded moves and replays a retried key", async () => {
    const check = await checkAtTable(4);

    await add(check.id, scenario.fries.id, 1);
    await add(check.id, scenario.cocktail.id, 2);
    await add(check.id, scenario.fries.id, 3);
    await add(check.id, scenario.cocktail.id, null);
    await send(check.id);

    const draft = await add(check.id, scenario.fries.id, 2);
    const sent = await itemRows(database(), check.id);
    const [seat1, seat2, seat3, table] = sent.filter((row) => row.status === "SUBMITTED");
    const itemOff = await createDiscountDefinition(database(), manager, {
      code: uniqueCode("ITM"),
      name: "Two off",
      scope: "ITEM",
      discountType: "FIXED_AMOUNT",
      value: "2.00",
    });
    const orderOff = await createDiscountDefinition(database(), manager, {
      code: uniqueCode("ORD"),
      name: "One off",
      scope: "ORDER",
      discountType: "FIXED_AMOUNT",
      value: "1.00",
    });

    await applyItemDiscount(database(), manager, check.id, seat2!.id, {
      discountDefinitionId: itemOff.id,
      reason: "Weak pour",
      expectedVersion: (await orderRow(database(), check.id)).version,
    });
    await applyOrderDiscount(database(), manager, check.id, {
      discountDefinitionId: orderOff.id,
      reason: "Regulars",
      expectedVersion: (await orderRow(database(), check.id)).version,
    });

    const ticketOrdersBefore = await database()
      .select({ id: kitchenTickets.id, orderId: kitchenTickets.orderId })
      .from(kitchenTickets)
      .where(eq(kitchenTickets.orderId, check.id));
    const [{ ledger: ledgerBefore }] = await database()
      .select({ ledger: sql<number>`count(*)::int` })
      .from(inventoryTransactions);
    const key = newKey();
    const result = await split(check.id, key);

    expect(result.replayed).toBe(false);
    expect(result.stayingSeat).toBe(1);
    expect(result.checks.map((entry) => entry.seat)).toEqual([2, 3]);

    // Seat 1 and the Table item stay, with the order discount.
    expect((await itemRows(database(), check.id)).map((row) => row.id).sort()).toEqual([seat1!.id, table!.id].sort());
    expect(await orderRow(database(), check.id)).toMatchObject({ itemSubtotal: "15.50", discountTotal: "1.00", subtotal: "14.50" });

    const seat2Check = result.checks[0]!;
    const seat3Check = result.checks[1]!;

    expect((await itemRows(database(), seat2Check.orderId)).map((row) => row.id).sort()).toEqual([seat2!.id, draft.itemId].sort());
    // The item discount travelled with the cocktail; the draft fries count once sent.
    expect(await orderRow(database(), seat2Check.orderId)).toMatchObject({
      tableSessionId: check.sessionId,
      itemSubtotal: "11.00",
      discountTotal: "2.00",
      subtotal: "9.00",
    });
    expect((await itemRows(database(), seat3Check.orderId)).map((row) => row.id)).toEqual([seat3!.id]);
    expect(await orderRow(database(), seat3Check.orderId)).toMatchObject({ subtotal: "4.50" });

    const transfers = await database()
      .select()
      .from(orderItemTransfers)
      .where(inArray(orderItemTransfers.toOrderId, [seat2Check.orderId, seat3Check.orderId]));

    expect(transfers).toHaveLength(3);
    expect(transfers.every((row) => row.fromOrderId === check.id)).toBe(true);
    expect(new Set(transfers.map((row) => row.transferGroupId)).size).toBe(2);

    // Tickets keep their original order; nothing moved in stock.
    expect(
      await database()
        .select({ id: kitchenTickets.id, orderId: kitchenTickets.orderId })
        .from(kitchenTickets)
        .where(eq(kitchenTickets.orderId, check.id)),
    ).toEqual(ticketOrdersBefore);
    expect(
      (await database().select({ ledger: sql<number>`count(*)::int` }).from(inventoryTransactions))[0]!.ledger,
    ).toBe(ledgerBefore);

    // Amendment 1: each seat moved is one ordinary move in the audit trail.
    const audits = await database()
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "orders.items-moved"), eq(auditEvents.entityId, check.id)));

    expect(audits).toHaveLength(2);
    expect(await checksAt(check.sessionId)).toHaveLength(3);
  });

  it("replays the first outcome for the same key and request", async () => {
    const check = await checkAtTable();

    await add(check.id, scenario.fries.id, 1);
    await add(check.id, scenario.fries.id, 2);

    const before = (await orderRow(database(), check.id)).version;
    const key = newKey();
    const first = await splitCheckBySeat(database(), server, check.id, { expectedVersion: before, idempotencyKey: key });
    const again = await splitCheckBySeat(database(), server, check.id, { expectedVersion: before, idempotencyKey: key });

    expect(again.replayed).toBe(true);
    expect(again.checks).toEqual(first.checks);
    expect(await checksAt(check.sessionId)).toHaveLength(2);
  });

  it("refuses to split takeout, one seat, a check being settled, a stale version or without orders.create", async () => {
    const takeout = await createOrder(database(), server, { orderType: "TAKEOUT" });

    expect(await codeOf(split(takeout.id))).toBe("TAKEOUT_CANNOT_SPLIT");

    const check = await checkAtTable();

    await add(check.id, scenario.fries.id, 2);
    await add(check.id, scenario.cocktail.id, null);

    expect(await codeOf(split(check.id))).toBe("NOTHING_TO_SPLIT");

    await add(check.id, scenario.fries.id, 3);

    expect(
      await codeOf(splitCheckBySeat(database(), server, check.id, { expectedVersion: 1, idempotencyKey: newKey() })),
    ).toBe("CONCURRENCY_CONFLICT");

    const noCreate = await actorWith(database(), scenario.base, ["orders.view", "orders.edit", "orders.move-items"]);

    expect(await codeOf(split(check.id, newKey(), noCreate))).toBe("PERMISSION_DENIED");

    await send(check.id);
    await openSettlement(database(), server, check.id);

    expect(await codeOf(split(check.id))).toBe("SETTLEMENT_IN_PROGRESS");
    // Refusals write nothing.
    expect(await checksAt(check.sessionId)).toHaveLength(1);
  });
});
