import { eq } from "drizzle-orm";

import { employees, kitchenTicketItems, kitchenTickets } from "@/db/schema";
import type { DatabaseTransaction } from "@/db/transactions/transaction-context";
import { writeOutboxEvents, type OutboxEventInput } from "@/infrastructure/outbox/outbox";
import { readStationFacts } from "@/modules/menu/queries/station-facts";
import { tableNumbersForSessions } from "@/modules/restaurant/queries/session-facts";

import { appendItemStatusHistory, displayName } from "../repositories/kitchen-repository";
import { groupByStation } from "../rules/fulfillment-rules";
import type { ModifierSnapshot } from "../types";

export type SentItemForTickets = {
  orderItemId: string;
  quantity: number;
  menuItemCodeSnapshot: string;
  menuItemNameSnapshot: string;
  kitchenInstructionsSnapshot: string | null;
  /** The immutable routing snapshot written at SEND. */
  prepStationIds: readonly string[];
  modifiers: readonly ModifierSnapshot[];
};

export type TicketGenerationInput = {
  organizationId: string;
  locationId: string;
  actorUserId: string;
  order: {
    id: string;
    orderNumber: number;
    orderType: string;
    tableSessionId: string | null;
    customerName: string | null;
    assignedServerEmployeeId: string | null;
  };
  batch: { id: string; batchNumber: number; sentAt: Date; businessDate: string };
  items: readonly SentItemForTickets[];
};

/**
 * Creates the station work for one send batch, inside the SEND transaction (approved
 * policies 2, 3, 5 and 9): one ticket per batch and station, one NEW item per routed Order
 * Item, each with its initial history row, and a `kitchen.ticket-created` outbox event per
 * ticket. Routing comes only from the snapshot; EXPO stations and empty routes create no
 * work. Database uniqueness on (batch, station) and (item, station, attempt) makes a
 * duplicate impossible even if this ran twice.
 */
export async function createTicketsForSendBatch(
  transaction: DatabaseTransaction,
  input: TicketGenerationInput,
): Promise<{ ticketIds: string[] }> {
  const stationIds = input.items.flatMap((item) => [...item.prepStationIds]);
  const stations = await readStationFacts(transaction, input.locationId, stationIds);
  const groups = groupByStation(
    input.items,
    new Map([...stations].map(([id, station]) => [id, station.stationType])),
  );

  if (groups.size === 0) {
    return { ticketIds: [] };
  }

  const tables = input.order.tableSessionId
    ? ((await tableNumbersForSessions(transaction, [input.order.tableSessionId])).get(
        input.order.tableSessionId,
      ) ?? [])
    : [];
  const [server] = input.order.assignedServerEmployeeId
    ? await transaction
        .select({
          first: employees.firstName,
          last: employees.lastName,
          preferred: employees.preferredName,
        })
        .from(employees)
        .where(eq(employees.id, input.order.assignedServerEmployeeId))
    : [];
  const at = input.batch.sentAt;
  const ticketIds: string[] = [];
  const events: OutboxEventInput[] = [];

  for (const [stationId, items] of groups) {
    const station = stations.get(stationId)!;
    const [ticket] = await transaction
      .insert(kitchenTickets)
      .values({
        organizationId: input.organizationId,
        locationId: input.locationId,
        prepStationId: stationId,
        orderId: input.order.id,
        sendBatchId: input.batch.id,
        attemptNumber: 1,
        businessDate: input.batch.businessDate,
        submittedAt: at,
        stationCodeSnapshot: station.code,
        stationNameSnapshot: station.name,
        stationTypeSnapshot: station.stationType,
        orderNumberSnapshot: input.order.orderNumber,
        orderTypeSnapshot: input.order.orderType,
        batchNumberSnapshot: input.batch.batchNumber,
        tableLabelSnapshot: tables.length > 0 ? tables.join("+") : null,
        pickupLabelSnapshot: input.order.customerName,
        serverNameSnapshot: server ? displayName(server.first, server.last, server.preferred) : null,
        createdAt: at,
      })
      .returning({ id: kitchenTickets.id });
    const created = await transaction
      .insert(kitchenTicketItems)
      .values(
        items.map((item) => ({
          ticketId: ticket!.id,
          locationId: input.locationId,
          prepStationId: stationId,
          orderId: input.order.id,
          orderItemId: item.orderItemId,
          attemptNumber: 1,
          status: "NEW",
          quantity: item.quantity,
          menuItemCodeSnapshot: item.menuItemCodeSnapshot,
          menuItemNameSnapshot: item.menuItemNameSnapshot,
          modifierSnapshots: item.modifiers,
          kitchenInstructionsSnapshot: item.kitchenInstructionsSnapshot,
          submittedAt: at,
          createdAt: at,
          updatedAt: at,
        })),
      )
      .returning({ id: kitchenTicketItems.id });

    await appendItemStatusHistory(
      transaction,
      created.map((row) => ({
        ticketItemId: row.id,
        status: "NEW" as const,
        reason: `Send batch ${input.batch.batchNumber}`,
        userId: input.actorUserId,
        at,
      })),
    );
    ticketIds.push(ticket!.id);
    events.push({
      organizationId: input.organizationId,
      locationId: input.locationId,
      eventType: "kitchen.ticket-created",
      aggregateType: "kitchen_ticket",
      aggregateId: ticket!.id,
      payload: {
        orderId: input.order.id,
        sendBatchId: input.batch.id,
        prepStationId: stationId,
        stationType: station.stationType,
        attemptNumber: 1,
      },
      occurredAt: at,
    });
  }

  await writeOutboxEvents(transaction, events);

  return { ticketIds };
}
