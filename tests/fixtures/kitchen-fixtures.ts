import { asc, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db";
import {
  kitchenTicketItems,
  kitchenTicketItemStatusHistory,
  kitchenTickets,
  notifications,
  outboxEvents,
} from "@/db/schema";
import type { PermissionCode } from "@/modules/auth/permission-catalog";
import { createStation, setItemRouting } from "@/modules/menu/services/prep-station-service";
import { addDraftItem } from "@/modules/orders/services/draft-item-service";
import { createOrder } from "@/modules/orders/services/order-service";
import { sendOrderItems } from "@/workflows/submit-order/submit-order";

import { actorWith } from "./employee-fixtures";
import { uniqueCode } from "./menu-fixtures";
import {
  baconCheeseburger,
  createOrderScenario,
  MANAGER_ORDER_PERMISSIONS,
  newKey,
  plainItem,
  seatedSession,
} from "./order-fixtures";

export const COOK_PERMISSIONS: readonly PermissionCode[] = [
  "kitchen.view",
  "kitchen.manage",
  "fulfillment.start",
  "fulfillment.ready",
  "fulfillment.complete",
  "fulfillment.remake",
];

export const BARTENDER_PERMISSIONS: readonly PermissionCode[] = [
  "bar.view",
  "bar.manage",
  "fulfillment.start",
  "fulfillment.ready",
  "fulfillment.complete",
  "fulfillment.remake",
];

/**
 * The order scenario plus the canonical burger (GRILL), fries (FRY), a cocktail (BAR), an
 * EXPO station, and kitchen, bar, view-only and manager actors.
 */
export async function createKitchenScenario(database: Database) {
  const scenario = await createOrderScenario(database);
  const burger = await baconCheeseburger(database, scenario);
  const owner = scenario.owner;
  const station = (name: string, stationType: "KITCHEN" | "BAR" | "EXPO", sortOrder: number) =>
    createStation(database, owner, { code: uniqueCode(name.slice(0, 3).toUpperCase()), name, stationType, sortOrder });
  const fry = await station("Fry", "KITCHEN", 1);
  const bar = await station("Bar", "BAR", 2);
  const expo = await station("Expo", "EXPO", 3);
  const fries = await plainItem(database, owner, "4.50", "Fries");
  const cocktail = await plainItem(database, owner, "11.00", "Margarita");

  await setItemRouting(database, owner, fries.id, { prepStationIds: [fry.id] });
  await setItemRouting(database, owner, cocktail.id, { prepStationIds: [bar.id] });

  return {
    ...scenario,
    /** The order scenario as created, for helpers that need its positions and areas. */
    base: scenario,
    burger,
    stations: { grill: burger.grill, fry, bar, expo },
    fries,
    cocktail,
    cook: await actorWith(database, scenario, COOK_PERMISSIONS),
    bartender: await actorWith(database, scenario, BARTENDER_PERMISSIONS),
    kitchenViewer: await actorWith(database, scenario, ["kitchen.view", "bar.view"]),
    voidManager: await actorWith(database, scenario, [...MANAGER_ORDER_PERMISSIONS, ...COOK_PERMISSIONS]),
  };
}

export type KitchenScenario = Awaited<ReturnType<typeof createKitchenScenario>>;

type Line = { menuItemId: string; quantity?: number; selections?: { modifierGroupId: string; modifierId: string }[]; specialInstructions?: string | null };

/** Opens an order (dine-in by default), adds the lines as drafts, and sends them. */
export async function sendOrder(
  database: Database,
  scenario: KitchenScenario,
  lines: readonly Line[],
  options: { orderType?: "DINE_IN" | "TAKEOUT"; key?: string; customerName?: string } = {},
) {
  const actor = scenario.serverActor;
  const order =
    options.orderType === "TAKEOUT"
      ? await createOrder(database, actor, { orderType: "TAKEOUT", customerName: options.customerName ?? null })
      : await createOrder(database, actor, {
          orderType: "DINE_IN",
          tableSessionId: (await seatedSession(database, scenario.base)).id,
        });
  let version = order.version;

  for (const line of lines) {
    const added = await addDraftItem(database, actor, order.id, {
      expectedVersion: version,
      menuItemId: line.menuItemId,
      quantity: line.quantity ?? 1,
      selections: line.selections ?? [],
      specialInstructions: line.specialInstructions ?? null,
    });

    version = added.orderVersion;
  }

  const key = options.key ?? newKey();
  const sent = await sendOrderItems(database, actor, order.id, { expectedVersion: version, idempotencyKey: key });

  return { order, sent, key };
}

export function ticketsForOrder(database: Database, orderId: string) {
  return database
    .select()
    .from(kitchenTickets)
    .where(eq(kitchenTickets.orderId, orderId))
    .orderBy(asc(kitchenTickets.attemptNumber), asc(kitchenTickets.stationCodeSnapshot));
}

export function ticketItemsForOrder(database: Database, orderId: string) {
  return database
    .select()
    .from(kitchenTicketItems)
    .where(eq(kitchenTicketItems.orderId, orderId))
    .orderBy(asc(kitchenTicketItems.attemptNumber), asc(kitchenTicketItems.createdAt), asc(kitchenTicketItems.id));
}

export async function historyFor(database: Database, ticketItemIds: readonly string[]) {
  if (ticketItemIds.length === 0) {
    return [];
  }

  return database
    .select()
    .from(kitchenTicketItemStatusHistory)
    .where(inArray(kitchenTicketItemStatusHistory.ticketItemId, [...ticketItemIds]))
    .orderBy(asc(kitchenTicketItemStatusHistory.occurredAt), asc(kitchenTicketItemStatusHistory.createdAt));
}

export function outboxFor(database: Database, aggregateIds: readonly string[]) {
  return database
    .select()
    .from(outboxEvents)
    .where(inArray(outboxEvents.aggregateId, [...aggregateIds]))
    .orderBy(asc(outboxEvents.sequence));
}

export function notificationsForOrder(database: Database, orderId: string) {
  return database.select().from(notifications).where(eq(notifications.orderId, orderId));
}
