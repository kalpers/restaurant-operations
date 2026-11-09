import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { closeDatabase, getDatabase } from "@/db";
import { inventoryTransactions, kitchenTicketItemStatusHistory, orderItems, orders, tableSessions } from "@/db/schema";
import { transitionTicketItem } from "@/modules/kitchen/services/fulfillment-service";
import { openSettlement } from "@/modules/settlements/services/settlement-service";
import { AppError } from "@/shared/errors/app-error";
import { completeSettlement } from "@/workflows/close-order/complete-settlement";
import { completeTableSession } from "@/workflows/end-table-session/end-table-session";

import { actorWith } from "../../fixtures/employee-fixtures";
import { createKitchenScenario, sendOrder, ticketItemsForOrder } from "../../fixtures/kitchen-fixtures";
import { clearOrderData, itemRows, newKey, orderRow } from "../../fixtures/order-fixtures";
import { sessionRow, tableRow } from "../../fixtures/restaurant-fixtures";
import {
  createSettlementScenario,
  SERVER_SETTLEMENT_PERMISSIONS,
  sentOrder,
  session,
  settlementRow,
  tender,
} from "../../fixtures/settlement-fixtures";

const database = () => getDatabase();

async function codeOf(work: Promise<unknown>): Promise<string | undefined> {
  try {
    await work;
  } catch (error) {
    return error instanceof AppError ? error.code : "DB";
  }

  return undefined;
}

async function settleInCash(actor: Parameters<typeof openSettlement>[1], orderId: string) {
  const { settlementId, orderAmountSnapshot } = await openSettlement(database(), actor, orderId);

  if (orderAmountSnapshot !== "0.00") {
    await tender(database(), actor, settlementId, { amount: orderAmountSnapshot, receivedAmount: orderAmountSnapshot });
  }

  const { version } = await settlementRow(database(), settlementId);

  return completeSettlement(database(), actor, settlementId, { expectedVersion: version, idempotencyKey: newKey() });
}

describe("order closure through settlement", () => {
  afterAll(async () => {
    await clearOrderData(database());
    await closeDatabase();
  });

  it("closes split checks independently; the session waits for both, then for its own completion", async () => {
    const scenario = await createSettlementScenario(database());
    const seated = await session(database(), scenario);
    const host = await actorWith(database(), scenario, ["restaurant.view", "restaurant.complete-session"]);
    const a = await sentOrder(database(), scenario, ["20.00"], { tableSessionId: seated.id });
    const b = await sentOrder(database(), scenario, ["15.00"], { tableSessionId: seated.id });
    const complete = async () =>
      completeTableSession(database(), host, seated.id, { expectedVersion: (await sessionRow(database(), seated.id)).version });

    await settleInCash(scenario.cashier, a.id);

    expect((await orderRow(database(), a.id)).status).toBe("CLOSED");
    expect(await codeOf(complete())).toBe("ORDERS_OPEN");

    await settleInCash(scenario.cashier, b.id);

    // Financially clear, but the guests may still be seated: nothing changed physically.
    expect((await sessionRow(database(), seated.id)).status).toBe("ACTIVE");
    expect((await tableRow(database(), seated.tableId)).condition).toBe("CLEAN");

    await complete();

    expect((await sessionRow(database(), seated.id)).status).toBe("COMPLETED");
    expect((await tableRow(database(), seated.tableId)).condition).toBe("DIRTY");
  });

  it("settles and closes takeout with no table session", async () => {
    const scenario = await createSettlementScenario(database());
    const order = await sentOrder(database(), scenario, ["12.00", "8.00"]);
    const sessionsBefore = await database().select({ count: sql<number>`count(*)::int` }).from(tableSessions);
    const { settlementId } = await openSettlement(database(), scenario.cashier, order.id);

    await tender(database(), scenario.cashier, settlementId, { amount: "5.00", receivedAmount: "5.00" });
    await tender(database(), scenario.cashier, settlementId, { tenderType: "EXTERNAL_CARD", amount: "15.00" });

    const { version } = await settlementRow(database(), settlementId);
    const done = await completeSettlement(database(), scenario.cashier, settlementId, {
      expectedVersion: version,
      idempotencyKey: newKey(),
    });
    const row = await orderRow(database(), order.id);

    expect(done.orderStatus).toBe("CLOSED");
    expect(row).toMatchObject({ orderType: "TAKEOUT", tableSessionId: null, status: "CLOSED" });
    expect(await database().select({ count: sql<number>`count(*)::int` }).from(tableSessions)).toEqual(sessionsBefore);
  });

  it("moves no inventory, changes no fulfillment and no order snapshot", async () => {
    const scenario = await createKitchenScenario(database());
    const cashier = await actorWith(database(), scenario.base, SERVER_SETTLEMENT_PERMISSIONS);
    const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }, { menuItemId: scenario.cocktail.id }]);
    const [fries] = (await ticketItemsForOrder(database(), order.id)).filter(
      (item) => item.prepStationId === scenario.stations.fry.id,
    );

    // Fries are being cooked; the cocktail hasn't started.
    await transitionTicketItem(database(), scenario.cook, fries!.id, "start", { expectedVersion: fries!.version });

    const ledgerBefore = await database().select().from(inventoryTransactions);
    const itemsBefore = await itemRows(database(), order.id);
    const ticketItemsBefore = await ticketItemsForOrder(database(), order.id);
    const historyBefore = await database().select().from(kitchenTicketItemStatusHistory);
    const done = await settleInCash(cashier, order.id);

    expect(done.orderStatus).toBe("CLOSED");
    expect(await database().select().from(inventoryTransactions)).toEqual(ledgerBefore);
    expect(await itemRows(database(), order.id)).toEqual(itemsBefore);
    expect(await ticketItemsForOrder(database(), order.id)).toEqual(ticketItemsBefore);
    expect(await database().select().from(kitchenTicketItemStatusHistory)).toEqual(historyBefore);

    // Fulfillment carries on after the order is paid and closed.
    const [started] = (await ticketItemsForOrder(database(), order.id)).filter((item) => item.id === fries!.id);

    await transitionTicketItem(database(), scenario.cook, fries!.id, "ready", { expectedVersion: started!.version });

    expect((await ticketItemsForOrder(database(), order.id)).find((item) => item.id === fries!.id)!.status).toBe("READY");
    expect((await orderRow(database(), order.id)).status).toBe("CLOSED");
  });

  it("leaves fulfillment unable to settle or close an order", async () => {
    const scenario = await createKitchenScenario(database());
    const { order } = await sendOrder(database(), scenario, [{ menuItemId: scenario.fries.id }], { orderType: "TAKEOUT" });
    const [item] = await ticketItemsForOrder(database(), order.id);
    let version = item!.version;

    for (const action of ["start", "ready", "complete"] as const) {
      version = (await transitionTicketItem(database(), scenario.cook, item!.id, action, { expectedVersion: version })).version;
    }

    expect((await orderRow(database(), order.id)).status).toBe("OPEN");
    expect(
      await database().select().from(orders).where(eq(orders.id, order.id)).then((rows) => rows[0]!.closedAt),
    ).toBeNull();
    expect((await database().select().from(orderItems).where(eq(orderItems.orderId, order.id)))[0]!.status).toBe("SUBMITTED");
  });
});
