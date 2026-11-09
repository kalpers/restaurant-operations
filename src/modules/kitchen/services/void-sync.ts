import { eq, inArray, sql } from "drizzle-orm";

import { kitchenRemakeConsumption, kitchenTicketItems } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";

import {
  appendItemStatusHistory,
  itemStatusEvent,
  lockItemsForOrderItem,
  notifyReadyTickets,
  ticketsByIds,
} from "../repositories/kitchen-repository";
import { planVoidCancellation } from "../rules/fulfillment-rules";
import type { KitchenItemStatus } from "../types";

/**
 * Fulfillment side of a submitted Order Item void, run inside the void transaction before
 * any Inventory reversal (approved policy 6). Locks every station item of every attempt,
 * refuses `UNPREPARED` if any has started, cancels the active items with history and
 * outbox events, and keeps COMPLETED and CANCELLED rows as they are. For `UNPREPARED` it
 * returns the Remake CONSUME rows, so the void reverses them with the original.
 */
export async function cancelFulfillmentForVoid(
  transaction: DatabaseTransaction,
  input: {
    orderItemId: string;
    disposition: "UNPREPARED" | "PREPARED_OR_DISCARDED";
    reason: string;
    actorUserId: string;
    at: Date;
  },
): Promise<{ cancelledItemIds: string[]; remakeTransactionIds: string[] }> {
  const items = await lockItemsForOrderItem(transaction, input.orderItemId);
  const { cancelIds } = planVoidCancellation(
    items.map((item) => ({ id: item.id, status: item.status as KitchenItemStatus })),
    input.disposition,
  );
  const reason = `Order item voided (${input.disposition}): ${input.reason}`;

  if (cancelIds.length > 0) {
    await transaction
      .update(kitchenTicketItems)
      .set({
        status: "CANCELLED",
        cancelledAt: input.at,
        cancelledByUserId: input.actorUserId,
        cancelReason: reason,
        version: sql`${kitchenTicketItems.version} + 1`,
        updatedAt: input.at,
      })
      .where(inArray(kitchenTicketItems.id, cancelIds));
    await appendItemStatusHistory(
      transaction,
      cancelIds.map((id) => ({
        ticketItemId: id,
        status: "CANCELLED" as const,
        reason,
        userId: input.actorUserId,
        at: input.at,
      })),
    );

    const cancelled = items.filter((item) => cancelIds.includes(item.id));
    const tickets = new Map(
      (await ticketsByIds(transaction, [...new Set(cancelled.map((item) => item.ticketId))])).map(
        (ticket) => [ticket.id, ticket],
      ),
    );

    await writeOutboxEvents(
      transaction,
      cancelled.map((item) => itemStatusEvent(tickets.get(item.ticketId)!, item, "CANCELLED", input.at)),
    );
    // Cancelling the last unfinished item can leave the rest of a ticket ready.
    await notifyReadyTickets(transaction, [...tickets.keys()], input.at);
  }

  const remakeTransactionIds =
    input.disposition === "UNPREPARED"
      ? (
          await transaction
            .select({ id: kitchenRemakeConsumption.inventoryTransactionId })
            .from(kitchenRemakeConsumption)
            .where(eq(kitchenRemakeConsumption.orderItemId, input.orderItemId))
        ).map((row) => row.id)
      : [];

  return { cancelledItemIds: cancelIds, remakeTransactionIds };
}
