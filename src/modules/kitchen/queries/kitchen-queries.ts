import { and, asc, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";

import { kitchenTicketItems, kitchenTickets, orderItems, orders } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { AuthorizationError } from "@/shared/errors/app-error";

import { ageBand, compareQueue, deriveTicketStatus, type AgeBand } from "../rules/fulfillment-rules";
import {
  ACTION_PERMISSION,
  type KitchenItemStatus,
  type ModifierSnapshot,
  type StationType,
} from "../types";
import { assertCanViewStationType, canWorkStationType, viewableStationTypes } from "../services/access";

// Purpose-built station DTOs (plan section 37): only operational data. No price, discount,
// cost, HR or guest-contact field is selected. Everything shown is a SEND-time snapshot.

export type QueueItem = {
  id: string;
  version: number;
  orderItemId: string;
  status: KitchenItemStatus;
  quantity: number;
  name: string;
  modifiers: ModifierSnapshot[];
  instructions: string | null;
  attemptNumber: number;
  submittedAt: string;
  startedAt: string | null;
  readyAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  actions: { start: boolean; ready: boolean; complete: boolean };
};

export type QueueTicket = {
  id: string;
  orderId: string;
  orderNumber: number;
  orderType: string;
  tableLabel: string | null;
  pickupLabel: string | null;
  serverName: string | null;
  stationId: string;
  stationCode: string;
  stationName: string;
  stationType: StationType;
  batchNumber: number;
  attemptNumber: number;
  isRemake: boolean;
  /** Phase 17: the course this ticket carries, and when it was fired (null while held). */
  courseNumber: number;
  firedAt: string | null;
  submittedAt: string;
  /** Whole seconds since the ticket was fired (Phase 17), from server time. Never stored. */
  ageSeconds: number;
  ageBand: AgeBand;
  status: KitchenItemStatus;
  items: QueueItem[];
};

export type QueueFilter = {
  stationType: StationType;
  stationId?: string;
  status?: KitchenItemStatus;
  orderType?: "DINE_IN" | "BAR" | "TAKEOUT";
};

const ACTIVE: KitchenItemStatus[] = ["NEW", "PREPARING", "READY"];
/** Completed tickets stay visible this long, so a bump can be checked. */
const RECENT_MINUTES = 30;

type ItemRow = typeof kitchenTicketItems.$inferSelect;
type TicketRow = typeof kitchenTickets.$inferSelect;

function toQueueItem(actor: Actor, ticket: TicketRow, item: ItemRow): QueueItem {
  const canWork = canWorkStationType(actor, ticket.stationTypeSnapshot as StationType);
  const can = (action: "start" | "ready" | "complete") =>
    canWork && actor.permissions.has(ACTION_PERMISSION[action]);

  return {
    id: item.id,
    version: item.version,
    orderItemId: item.orderItemId,
    status: item.status as KitchenItemStatus,
    quantity: item.quantity,
    name: item.menuItemNameSnapshot,
    modifiers: item.modifierSnapshots as ModifierSnapshot[],
    instructions: item.kitchenInstructionsSnapshot,
    attemptNumber: item.attemptNumber,
    submittedAt: item.submittedAt.toISOString(),
    startedAt: item.startedAt?.toISOString() ?? null,
    readyAt: item.readyAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
    cancelledAt: item.cancelledAt?.toISOString() ?? null,
    cancelReason: item.cancelReason,
    actions: {
      start: item.status === "NEW" && can("start"),
      ready: item.status === "PREPARING" && can("ready"),
      complete: item.status === "READY" && can("complete"),
    },
  };
}

/** Age counts from when the kitchen got the work (fired), not when it was sent. */
function ageSecondsFrom(firedAt: Date | null, now: Date): number {
  return firedAt ? Math.max(0, Math.floor((now.getTime() - firedAt.getTime()) / 1000)) : 0;
}

function toQueueTicket(actor: Actor, ticket: TicketRow, items: ItemRow[], now: Date): QueueTicket {
  const sorted = [...items].sort((a, b) =>
    compareQueue(
      { submittedAt: a.submittedAt, ticketId: a.ticketId, id: a.id },
      { submittedAt: b.submittedAt, ticketId: b.ticketId, id: b.id },
    ),
  );

  return {
    id: ticket.id,
    orderId: ticket.orderId,
    orderNumber: ticket.orderNumberSnapshot,
    orderType: ticket.orderTypeSnapshot,
    tableLabel: ticket.tableLabelSnapshot,
    pickupLabel: ticket.pickupLabelSnapshot,
    serverName: ticket.serverNameSnapshot,
    stationId: ticket.prepStationId,
    stationCode: ticket.stationCodeSnapshot,
    stationName: ticket.stationNameSnapshot,
    stationType: ticket.stationTypeSnapshot as StationType,
    batchNumber: ticket.batchNumberSnapshot,
    attemptNumber: ticket.attemptNumber,
    isRemake: ticket.remakeId !== null,
    courseNumber: ticket.courseNumber,
    firedAt: ticket.firedAt?.toISOString() ?? null,
    submittedAt: ticket.submittedAt.toISOString(),
    ageSeconds: ageSecondsFrom(ticket.firedAt, now),
    ageBand: ticket.firedAt ? ageBand(ticket.firedAt, now) : "normal",
    status: deriveTicketStatus(items.map((item) => item.status as KitchenItemStatus)),
    items: sorted.map((item) => toQueueItem(actor, ticket, item)),
  };
}

function loadTickets(
  executor: DatabaseExecutor,
  actor: Actor,
  where: { stationTypes: StationType[]; stationId?: string; orderType?: string },
) {
  const conditions = [
    eq(kitchenTickets.organizationId, actor.organizationId),
    // Phase 17: held courses stay off the station queues until fired.
    isNotNull(kitchenTickets.firedAt),
    eq(kitchenTickets.locationId, actor.locationId),
    inArray(kitchenTickets.stationTypeSnapshot, where.stationTypes),
  ];

  if (where.stationId) {
    conditions.push(eq(kitchenTickets.prepStationId, where.stationId));
  }

  if (where.orderType) {
    conditions.push(eq(kitchenTickets.orderTypeSnapshot, where.orderType));
  }

  // Active work first narrows the tickets; items are then loaded in full for each.
  const activeTicketIds = executor
    .selectDistinct({ id: kitchenTicketItems.ticketId })
    .from(kitchenTicketItems)
    .where(
      and(
        eq(kitchenTicketItems.locationId, actor.locationId),
        inArray(kitchenTicketItems.status, ACTIVE),
      ),
    );

  return { conditions, activeTicketIds };
}

/**
 * A Kitchen or Bar queue: tickets with active work, FIFO, plus recently completed tickets.
 * The station type is the authorization boundary; the station, status and order-type
 * filters only narrow what the actor may already see.
 */
export async function getStationQueue(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: QueueFilter,
  now = new Date(),
): Promise<{ active: QueueTicket[]; recentlyCompleted: QueueTicket[]; serverTime: string }> {
  assertCanViewStationType(actor, filter.stationType);

  const { conditions, activeTicketIds } = loadTickets(executor, actor, {
    stationTypes: [filter.stationType],
    stationId: filter.stationId,
    orderType: filter.orderType,
  });
  const activeTickets = await executor
    .select()
    .from(kitchenTickets)
    .where(and(...conditions, inArray(kitchenTickets.id, activeTicketIds)))
    .orderBy(asc(kitchenTickets.firedAt), asc(kitchenTickets.id));
  const recentTickets = await executor
    .select()
    .from(kitchenTickets)
    .where(and(...conditions, gte(kitchenTickets.submittedAt, new Date(now.getTime() - 12 * 3600_000))))
    .orderBy(desc(kitchenTickets.submittedAt), desc(kitchenTickets.id))
    .limit(200);
  const ticketIds = [...new Set([...activeTickets, ...recentTickets].map((ticket) => ticket.id))];
  const items =
    ticketIds.length === 0
      ? []
      : await executor.select().from(kitchenTicketItems).where(inArray(kitchenTicketItems.ticketId, ticketIds));
  const itemsOf = (ticketId: string) => items.filter((item) => item.ticketId === ticketId);
  const active = activeTickets
    .map((ticket) => toQueueTicket(actor, ticket, itemsOf(ticket.id), now))
    .map((ticket) =>
      filter.status ? { ...ticket, items: ticket.items.filter((item) => item.status === filter.status) } : ticket,
    )
    .filter((ticket) => ticket.items.length > 0);
  const cutoff = now.getTime() - RECENT_MINUTES * 60_000;
  const recentlyCompleted = recentTickets
    .filter((ticket) => !activeTickets.some((entry) => entry.id === ticket.id))
    .map((ticket) => toQueueTicket(actor, ticket, itemsOf(ticket.id), now))
    .filter(
      (ticket) =>
        ticket.status === "COMPLETED" &&
        ticket.items.some((item) => item.completedAt && Date.parse(item.completedAt) >= cutoff),
    )
    .slice(0, 10);

  return { active, recentlyCompleted, serverTime: now.toISOString() };
}

export type ExpoOrder = {
  orderId: string;
  orderNumber: number;
  orderType: string;
  tableLabel: string | null;
  pickupLabel: string | null;
  serverName: string | null;
  oldestSubmittedAt: string;
  /** Seconds since the oldest fired ticket; 0 while everything is held. */
  ageSeconds: number;
  ageBand: AgeBand;
  /** Overall readiness of the order's fired items across every station and attempt. */
  status: KitchenItemStatus;
  /** Phase 17: courses sent but not yet fired, lowest first. */
  heldCourses: number[];
  items: {
    orderItemId: string;
    name: string;
    quantity: number;
    status: KitchenItemStatus;
    /** Phase 17: the item's course is held (not yet fired). */
    held: boolean;
    courseNumber: number;
    stations: { code: string; name: string; status: KitchenItemStatus; attemptNumber: number }[];
  }[];
};

/**
 * EXPO: a read-only consolidation of the station work the actor may view, grouped by the
 * order each item is on now (Phase 17: work follows a moved item), with each item's overall
 * readiness derived across all stations and attempts. Held courses are listed apart. It
 * creates no work and has no actions.
 */
export async function getExpoView(
  executor: DatabaseExecutor,
  actor: Actor,
  now = new Date(),
): Promise<{ orders: ExpoOrder[]; serverTime: string }> {
  const stationTypes = viewableStationTypes(actor);

  if (stationTypes.length === 0) {
    throw new AuthorizationError();
  }

  const scope = and(
    eq(kitchenTickets.organizationId, actor.organizationId),
    eq(kitchenTickets.locationId, actor.locationId),
    inArray(kitchenTickets.stationTypeSnapshot, stationTypes),
  );
  const activeOrderIds = executor
    .selectDistinct({ id: orderItems.orderId })
    .from(kitchenTicketItems)
    .innerJoin(kitchenTickets, eq(kitchenTickets.id, kitchenTicketItems.ticketId))
    .innerJoin(orderItems, eq(orderItems.id, kitchenTicketItems.orderItemId))
    .where(and(scope, inArray(kitchenTicketItems.status, ACTIVE)));
  const rows = await executor
    .select({
      item: kitchenTicketItems,
      ticket: kitchenTickets,
      orderId: orderItems.orderId,
      orderNumber: orders.orderNumber,
      orderType: orders.orderType,
      courseNumber: orderItems.courseNumber,
    })
    .from(kitchenTicketItems)
    .innerJoin(kitchenTickets, eq(kitchenTickets.id, kitchenTicketItems.ticketId))
    .innerJoin(orderItems, eq(orderItems.id, kitchenTicketItems.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .where(and(scope, inArray(orderItems.orderId, activeOrderIds)))
    .orderBy(asc(kitchenTickets.submittedAt), asc(kitchenTicketItems.submittedAt), asc(kitchenTicketItems.id));
  const byOrder = new Map<string, typeof rows>();

  for (const row of rows) {
    byOrder.set(row.orderId, [...(byOrder.get(row.orderId) ?? []), row]);
  }

  const result: ExpoOrder[] = [];

  for (const [orderId, orderRows] of byOrder) {
    const first = orderRows[0]!;
    const fired = orderRows.filter((row) => row.ticket.firedAt !== null);
    const oldestFired = fired
      .map((row) => row.ticket.firedAt!)
      .reduce<Date | null>((oldest, at) => (oldest === null || at < oldest ? at : oldest), null);
    const itemIds = [...new Set(orderRows.map((row) => row.item.orderItemId))];
    const items = itemIds.map((orderItemId) => {
      const work = orderRows.filter((row) => row.item.orderItemId === orderItemId);

      return {
        orderItemId,
        name: work[0]!.item.menuItemNameSnapshot,
        quantity: work[0]!.item.quantity,
        status: deriveTicketStatus(work.map((row) => row.item.status as KitchenItemStatus)),
        held: work.some((row) => row.ticket.firedAt === null && row.item.status === "NEW"),
        courseNumber: work[0]!.courseNumber,
        stations: work.map((row) => ({
          code: row.ticket.stationCodeSnapshot,
          name: row.ticket.stationNameSnapshot,
          status: row.item.status as KitchenItemStatus,
          attemptNumber: row.item.attemptNumber,
        })),
      };
    });

    result.push({
      orderId,
      orderNumber: first.orderNumber,
      orderType: first.orderType,
      tableLabel: first.ticket.tableLabelSnapshot,
      pickupLabel: first.ticket.pickupLabelSnapshot,
      serverName: first.ticket.serverNameSnapshot,
      oldestSubmittedAt: first.ticket.submittedAt.toISOString(),
      ageSeconds: ageSecondsFrom(oldestFired, now),
      ageBand: oldestFired ? ageBand(oldestFired, now) : "normal",
      status: deriveTicketStatus(
        (fired.length > 0 ? fired : orderRows).map((row) => row.item.status as KitchenItemStatus),
      ),
      heldCourses: [
        ...new Set(orderRows.filter((row) => row.ticket.firedAt === null).map((row) => row.ticket.courseNumber)),
      ].sort((a, b) => a - b),
      items,
    });
  }

  return { orders: result, serverTime: now.toISOString() };
}

export type OrderItemFulfillment = {
  status: KitchenItemStatus;
  attempts: number;
  /** Phase 17: the item's course is held at its stations. */
  held: boolean;
  /** The first-attempt station item a Remake would follow. */
  stations: { ticketItemId: string; code: string; status: KitchenItemStatus; attemptNumber: number }[];
};

/**
 * Fulfillment per Order Item, for the order screen, found through the items on the order
 * now (Phase 17: work follows a moved item). The order's own `orders.view` check is the
 * caller's; this exposes only statuses and station codes.
 */
export async function fulfillmentForOrder(
  executor: DatabaseExecutor,
  orderId: string,
): Promise<Map<string, OrderItemFulfillment>> {
  const rows = await executor
    .select({
      item: kitchenTicketItems,
      code: kitchenTickets.stationCodeSnapshot,
      firedAt: kitchenTickets.firedAt,
    })
    .from(kitchenTicketItems)
    .innerJoin(kitchenTickets, eq(kitchenTickets.id, kitchenTicketItems.ticketId))
    .innerJoin(orderItems, eq(orderItems.id, kitchenTicketItems.orderItemId))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(kitchenTicketItems.attemptNumber), asc(kitchenTickets.stationCodeSnapshot));
  const result = new Map<string, OrderItemFulfillment>();

  for (const orderItemId of new Set(rows.map((row) => row.item.orderItemId))) {
    const own = rows.filter((row) => row.item.orderItemId === orderItemId);

    result.set(orderItemId, {
      status: deriveTicketStatus(own.map((row) => row.item.status as KitchenItemStatus)),
      attempts: Math.max(...own.map((row) => row.item.attemptNumber)),
      held: own.some((row) => row.firedAt === null && row.item.status === "NEW"),
      stations: own.map((row) => ({
        ticketItemId: row.item.id,
        code: row.code,
        status: row.item.status as KitchenItemStatus,
        attemptNumber: row.item.attemptNumber,
      })),
    });
  }

  return result;
}
