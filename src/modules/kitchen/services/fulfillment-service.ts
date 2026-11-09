import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/db";
import { kitchenTicketItems, kitchenTickets } from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents } from "@/infrastructure/outbox/outbox";
import type { Actor } from "@/modules/auth/types";
import { NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { appendItemStatusHistory, itemStatusEvent, notifyReadyTickets } from "../repositories/kitchen-repository";
import { planTransition } from "../rules/fulfillment-rules";
import { ACTION_PERMISSION, type FulfillmentAction, type KitchenItemStatus } from "../types";
import { assertCanWorkStationType, assertKitchenPermission } from "./access";

export type TransitionResult = {
  id: string;
  ticketId: string;
  status: KitchenItemStatus;
  version: number;
  /** True when the item was already in the target state: nothing was written. */
  alreadyApplied: boolean;
};

/**
 * Start (NEW -> PREPARING), ready (PREPARING -> READY) or complete/bump (READY ->
 * COMPLETED) one station item. The item row is locked and the client's version checked, so
 * two cooks can't both move it; a repeat of an action that already happened returns the
 * current state with no new history. Inventory is never touched: it was consumed at SEND.
 * Nothing here closes or changes the Order.
 */
export async function transitionTicketItem(
  database: Database,
  actor: Actor,
  ticketItemId: string,
  action: FulfillmentAction,
  input: { expectedVersion: number },
): Promise<TransitionResult> {
  assertKitchenPermission(actor, ACTION_PERMISSION[action]);

  return withTransaction(database, async (transaction) => {
    const [row] = await transaction
      .select({ item: kitchenTicketItems, ticket: kitchenTickets })
      .from(kitchenTicketItems)
      .innerJoin(kitchenTickets, eq(kitchenTickets.id, kitchenTicketItems.ticketId))
      .where(
        and(
          eq(kitchenTicketItems.id, ticketItemId),
          eq(kitchenTickets.organizationId, actor.organizationId),
          eq(kitchenTickets.locationId, actor.locationId),
        ),
      )
      .for("update", { of: kitchenTicketItems });

    if (!row) {
      throw new NotFoundError("ticket item");
    }

    const { item, ticket } = row;

    assertCanWorkStationType(actor, ticket.stationTypeSnapshot);

    const plan = planTransition(item.status as KitchenItemStatus, action);

    if (plan.kind === "already") {
      return {
        id: item.id,
        ticketId: item.ticketId,
        status: plan.to,
        version: item.version,
        alreadyApplied: true,
      };
    }

    if (item.version !== input.expectedVersion) {
      throw new ConcurrencyError("ticket item", item.id);
    }

    const at = new Date();
    const stamp =
      plan.to === "PREPARING"
        ? { startedAt: at, startedByUserId: actor.userId }
        : plan.to === "READY"
          ? { readyAt: at, readyByUserId: actor.userId }
          : { completedAt: at, completedByUserId: actor.userId };
    const [updated] = await transaction
      .update(kitchenTicketItems)
      .set({
        status: plan.to,
        ...stamp,
        version: sql`${kitchenTicketItems.version} + 1`,
        updatedAt: at,
      })
      .where(eq(kitchenTicketItems.id, item.id))
      .returning({ version: kitchenTicketItems.version });

    await appendItemStatusHistory(transaction, [
      { ticketItemId: item.id, status: plan.to, userId: actor.userId, at },
    ]);
    await writeOutboxEvents(transaction, [itemStatusEvent(ticket, item, plan.to, at)]);

    if (plan.to === "READY") {
      await notifyReadyTickets(transaction, [ticket.id], at);
    }

    return {
      id: item.id,
      ticketId: item.ticketId,
      status: plan.to,
      version: updated!.version,
      alreadyApplied: false,
    };
  });
}
