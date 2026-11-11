import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { employees, orderNumberCounters, orders } from "@/db/schema";
import { withTransaction, type DatabaseTransaction } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { lockSessionForOrder } from "@/modules/restaurant/queries/session-facts";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

import { appendOrderHistory, readOrderLocation } from "../repositories/order-repository";
import { AREA_TYPE_FOR_ORDER, type OrderType } from "../types";
import { assertPermission } from "./access";

export type CreateOrderInput =
  | { orderType: "DINE_IN" | "BAR"; tableSessionId: string }
  | { orderType: "TAKEOUT"; customerName?: string | null };

/** The next display number for a Location's business date, unique under concurrency. */
async function nextOrderNumber(
  transaction: DatabaseTransaction,
  locationId: string,
  businessDate: string,
): Promise<number> {
  const [row] = await transaction
    .insert(orderNumberCounters)
    .values({ locationId, businessDate, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [orderNumberCounters.locationId, orderNumberCounters.businessDate],
      set: { lastNumber: sql`${orderNumberCounters.lastNumber} + 1` },
    })
    .returning({ lastNumber: orderNumberCounters.lastNumber });

  return row!.lastNumber;
}

/** The actor's own Employee record, if their login is linked to one. Context only. */
async function actorEmployeeId(transaction: DatabaseTransaction, actor: Actor) {
  const [row] = await transaction
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.userId, actor.userId), eq(employees.organizationId, actor.organizationId)));

  return row?.id ?? null;
}

/**
 * Opens an order. DINE_IN and BAR attach to an ACTIVE Table Session whose tables are in a
 * DINING or BAR area respectively, and take the session's Guest Party and server. TAKEOUT
 * has no session and no table. Nothing moves stock.
 */
export async function createOrder(
  database: Database,
  actor: Actor,
  input: CreateOrderInput,
): Promise<{ id: string; orderNumber: number; version: number }> {
  assertPermission(actor, "orders.create");

  return withTransaction(database, (transaction) => createOrderInTransaction(transaction, actor, input));
}

/**
 * The body of `createOrder`, for a caller already inside a transaction (Phase 17: a "new
 * check" opened while moving items). The caller checks `orders.create` itself.
 */
export async function createOrderInTransaction(
  transaction: DatabaseTransaction,
  actor: Actor,
  input: CreateOrderInput,
): Promise<{ id: string; orderNumber: number; version: number }> {
  {
    const now = new Date();
    const location = await readOrderLocation(transaction, actor.locationId, now);

    if (!location.active) {
      throw new BusinessRuleError("LOCATION_INACTIVE", "This location isn't active.");
    }

    let tableSessionId: string | null = null;
    let guestPartyId: string | null = null;
    let serverEmployeeId: string | null = null;
    let customerName: string | null = null;
    const openedByEmployeeId = await actorEmployeeId(transaction, actor);

    if (input.orderType === "TAKEOUT") {
      if (!location.allowTakeout) {
        throw new BusinessRuleError("TAKEOUT_DISABLED", "Takeout isn't enabled at this location.");
      }

      customerName = input.customerName?.trim() || null;
      serverEmployeeId = openedByEmployeeId;
    } else {
      const session = await lockSessionForOrder(transaction, actor.locationId, input.tableSessionId);

      if (!session) {
        throw new NotFoundError("table session");
      }

      if (session.status !== "ACTIVE") {
        throw new BusinessRuleError(
          "SESSION_NOT_ACTIVE",
          "That table session has ended, so it can't take a new order.",
        );
      }

      const wanted = AREA_TYPE_FOR_ORDER[input.orderType];

      if (session.areaTypes.length !== 1 || session.areaTypes[0] !== wanted) {
        throw new BusinessRuleError(
          "ORDER_TYPE_AREA_MISMATCH",
          input.orderType === "BAR"
            ? "A bar order needs a party seated in a bar area."
            : "A dine-in order needs a party seated in a dining area.",
        );
      }

      tableSessionId = session.id;
      guestPartyId = session.guestPartyId;
      serverEmployeeId = session.assignedServerEmployeeId;
    }

    const orderNumber = await nextOrderNumber(transaction, actor.locationId, location.businessDate);
    const [order] = await transaction
      .insert(orders)
      .values({
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        orderType: input.orderType satisfies OrderType,
        orderNumber,
        businessDate: location.businessDate,
        tableSessionId,
        guestPartyId,
        customerName,
        openedByUserId: actor.userId,
        openedByEmployeeId,
        assignedServerEmployeeId: serverEmployeeId,
        openedAt: now,
      })
      .returning({ id: orders.id, orderNumber: orders.orderNumber, version: orders.version });

    await appendOrderHistory(transaction, {
      orderId: order!.id,
      status: "OPEN",
      reason: null,
      userId: actor.userId,
      at: now,
    });

    return order!;
  }
}
