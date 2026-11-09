import { and, asc, eq, max } from "drizzle-orm";

import type { Database } from "@/db";
import {
  kitchenRemakeConsumption,
  kitchenRemakes,
  kitchenTicketItems,
  kitchenTickets,
  orderItemInventoryConsumption,
  orderItems,
  orders,
} from "@/db/schema";
import { withTransaction } from "@/db/transactions/transaction-context";
import { runIdempotent } from "@/infrastructure/idempotency/idempotency-service";
import { writeOutboxEvents, type OutboxEventInput } from "@/infrastructure/outbox/outbox";
import type { Actor } from "@/modules/auth/types";
import { postRemakeConsumption } from "@/modules/inventory/services/order-consumption";
import { appendItemStatusHistory } from "@/modules/kitchen/repositories/kitchen-repository";
import { assertCanWorkStationType, assertKitchenPermission } from "@/modules/kitchen/services/access";
import { REMAKE_SCOPE } from "@/modules/kitchen/types";
import { readOrderLocation } from "@/modules/orders/repositories/order-repository";
import { assertOrderOpen } from "@/modules/orders/rules/order-lifecycle";
import { BusinessRuleError, NotFoundError } from "@/shared/errors/app-error";

export type RemakeResult = {
  remakeId: string;
  orderItemId: string;
  attemptNumber: number;
  ticketIds: string[];
  ticketItemIds: string[];
  requestedAt: string;
};

/**
 * Remake (approved policy 7): an explicit, reasoned new attempt at a sent Order Item. In one
 * transaction it creates a new ticket and NEW item at every station the item was originally
 * routed to, with the original snapshots, and posts additional CONSUME copied from the
 * item's immutable `order_item_inventory_consumption` rows (never from current Recipes),
 * through the Phase 8 posting rules. A shortage rolls everything back. It changes no price,
 * discount, snapshot, total or Order version, and creates no Order Item. The idempotency key
 * makes a retry return the first result with no second attempt or posting.
 */
export async function remakeOrderItem(
  database: Database,
  actor: Actor,
  orderId: string,
  orderItemId: string,
  input: { reason: string; idempotencyKey: string },
): Promise<RemakeResult & { replayed: boolean }> {
  assertKitchenPermission(actor, "fulfillment.remake");

  const reason = input.reason.trim();

  if (!reason) {
    throw new BusinessRuleError("REASON_REQUIRED", "Enter a reason for the remake.");
  }

  const outcome = await withTransaction(database, (transaction) =>
    runIdempotent<RemakeResult>(
      transaction,
      {
        organizationId: actor.organizationId,
        scope: REMAKE_SCOPE,
        key: input.idempotencyKey,
        actorUserId: actor.userId,
        request: { orderId, orderItemId, reason },
      },
      async (idempotencyRecordId) => {
        // A void locks the order FOR UPDATE, so a Remake and a void of the same order
        // serialize here.
        const [order] = await transaction
          .select({ id: orders.id, status: orders.status })
          .from(orders)
          .where(
            and(
              eq(orders.id, orderId),
              eq(orders.organizationId, actor.organizationId),
              eq(orders.locationId, actor.locationId),
            ),
          )
          .for("share");

        if (!order) {
          throw new NotFoundError("order");
        }

        assertOrderOpen(order.status);

        const [item] = await transaction
          .select({ id: orderItems.id, status: orderItems.status })
          .from(orderItems)
          .where(and(eq(orderItems.id, orderItemId), eq(orderItems.orderId, orderId)))
          .for("update");

        if (!item) {
          throw new NotFoundError("order item");
        }

        if (item.status !== "SUBMITTED") {
          throw new BusinessRuleError(
            "ITEM_NOT_SUBMITTED",
            "Only a sent item that hasn't been voided can be remade.",
          );
        }

        const original = await transaction
          .select({ item: kitchenTicketItems, ticket: kitchenTickets })
          .from(kitchenTicketItems)
          .innerJoin(kitchenTickets, eq(kitchenTickets.id, kitchenTicketItems.ticketId))
          .where(and(eq(kitchenTicketItems.orderItemId, orderItemId), eq(kitchenTicketItems.attemptNumber, 1)))
          .orderBy(asc(kitchenTickets.prepStationId));

        if (original.length === 0) {
          throw new BusinessRuleError(
            "NO_STATION_WORK",
            "This item isn't prepared at any station, so there is nothing to remake.",
          );
        }

        for (const { ticket } of original) {
          assertCanWorkStationType(actor, ticket.stationTypeSnapshot);
        }

        const [last] = await transaction
          .select({
            attempt: max(kitchenTicketItems.attemptNumber),
          })
          .from(kitchenTicketItems)
          .where(eq(kitchenTicketItems.orderItemId, orderItemId));
        const attemptNumber = (last?.attempt ?? 1) + 1;
        const [source] = await transaction
          .select({ id: kitchenTicketItems.id })
          .from(kitchenTicketItems)
          .where(
            and(
              eq(kitchenTicketItems.orderItemId, orderItemId),
              eq(kitchenTicketItems.attemptNumber, attemptNumber - 1),
            ),
          )
          .orderBy(asc(kitchenTicketItems.id))
          .limit(1);
        const at = new Date();
        const location = await readOrderLocation(transaction, actor.locationId, at);
        const [remake] = await transaction
          .insert(kitchenRemakes)
          .values({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            orderId,
            orderItemId,
            attemptNumber,
            sourceTicketItemId: source!.id,
            reason,
            idempotencyRecordId,
            requestedByUserId: actor.userId,
            requestedAt: at,
          })
          .returning({ id: kitchenRemakes.id });
        const ticketIds: string[] = [];
        const ticketItemIds: string[] = [];
        const events: OutboxEventInput[] = [];

        for (const { item: first, ticket } of original) {
          const [newTicket] = await transaction
            .insert(kitchenTickets)
            .values({
              organizationId: ticket.organizationId,
              locationId: ticket.locationId,
              prepStationId: ticket.prepStationId,
              orderId: ticket.orderId,
              sendBatchId: ticket.sendBatchId,
              remakeId: remake!.id,
              attemptNumber,
              businessDate: location.businessDate,
              submittedAt: at,
              stationCodeSnapshot: ticket.stationCodeSnapshot,
              stationNameSnapshot: ticket.stationNameSnapshot,
              stationTypeSnapshot: ticket.stationTypeSnapshot,
              orderNumberSnapshot: ticket.orderNumberSnapshot,
              orderTypeSnapshot: ticket.orderTypeSnapshot,
              batchNumberSnapshot: ticket.batchNumberSnapshot,
              tableLabelSnapshot: ticket.tableLabelSnapshot,
              pickupLabelSnapshot: ticket.pickupLabelSnapshot,
              serverNameSnapshot: ticket.serverNameSnapshot,
              createdAt: at,
            })
            .returning({ id: kitchenTickets.id });
          const [newItem] = await transaction
            .insert(kitchenTicketItems)
            .values({
              ticketId: newTicket!.id,
              locationId: first.locationId,
              prepStationId: first.prepStationId,
              orderId: first.orderId,
              orderItemId,
              attemptNumber,
              status: "NEW",
              quantity: first.quantity,
              menuItemCodeSnapshot: first.menuItemCodeSnapshot,
              menuItemNameSnapshot: first.menuItemNameSnapshot,
              modifierSnapshots: first.modifierSnapshots,
              kitchenInstructionsSnapshot: first.kitchenInstructionsSnapshot,
              submittedAt: at,
              createdAt: at,
              updatedAt: at,
            })
            .returning({ id: kitchenTicketItems.id });

          await appendItemStatusHistory(transaction, [
            {
              ticketItemId: newItem!.id,
              status: "NEW",
              reason: `Remake ${attemptNumber - 1}: ${reason}`,
              userId: actor.userId,
              at,
            },
          ]);
          ticketIds.push(newTicket!.id);
          ticketItemIds.push(newItem!.id);
          events.push({
            organizationId: actor.organizationId,
            locationId: actor.locationId,
            eventType: "kitchen.ticket-created",
            aggregateType: "kitchen_ticket",
            aggregateId: newTicket!.id,
            payload: {
              orderId,
              sendBatchId: ticket.sendBatchId,
              prepStationId: ticket.prepStationId,
              stationType: ticket.stationTypeSnapshot,
              attemptNumber,
            },
            occurredAt: at,
          });
        }

        const consumption = await transaction
          .select()
          .from(orderItemInventoryConsumption)
          .where(eq(orderItemInventoryConsumption.orderItemId, orderItemId))
          .orderBy(asc(orderItemInventoryConsumption.inventoryItemId));
        const postings = await postRemakeConsumption(transaction, {
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          remakeId: remake!.id,
          occurredAt: at,
          createdByUserId: actor.userId,
          lines: consumption.map((row) => ({
            orderItemId,
            inventoryItemId: row.inventoryItemId,
            baseQuantity: row.baseQuantity,
          })),
        });

        if (postings.length > 0) {
          await transaction.insert(kitchenRemakeConsumption).values(
            postings.map((posting) => {
              const sourceRow = consumption.find((row) => row.inventoryItemId === posting.inventoryItemId)!;

              return {
                organizationId: actor.organizationId,
                remakeId: remake!.id,
                orderItemId,
                inventoryItemId: posting.inventoryItemId,
                baseQuantity: posting.baseQuantity,
                baseUnitId: posting.baseUnitId,
                sourceConsumptionId: sourceRow.id,
                inventoryTransactionId: posting.posting.transactionId,
              };
            }),
          );
        }

        events.push({
          organizationId: actor.organizationId,
          locationId: actor.locationId,
          eventType: "kitchen.remake-requested",
          aggregateType: "kitchen_remake",
          aggregateId: remake!.id,
          payload: { orderId, orderItemId, attemptNumber },
          occurredAt: at,
        });
        await writeOutboxEvents(transaction, events);

        return {
          remakeId: remake!.id,
          orderItemId,
          attemptNumber,
          ticketIds,
          ticketItemIds,
          requestedAt: at.toISOString(),
        };
      },
    ),
  );

  return { ...outcome.response, replayed: outcome.replayed };
}
