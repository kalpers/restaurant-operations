import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, like } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  idempotencyRecords,
  kitchenTicketItems,
  kitchenTicketItemStatusHistory,
  kitchenTickets,
  locations,
  menuItemModifierGroups,
  modifierGroupModifiers,
  notifications,
  orderItemInventoryConsumption,
  orderItemModifiers,
  orderItems,
  orderItemStatusHistory,
  orderItemVoids,
  orders,
  orderSendBatches,
  orderStatusHistory,
  permissions,
  restaurantAreas,
  restaurantTables,
  rolePermissions,
  roles,
  tableConditionHistory,
  tableSessions,
  tableSessionTables,
  userRoles,
  users,
} from "../../src/db/schema";
import { hashPassword } from "../../src/modules/auth/password";
import type { PermissionCode } from "../../src/modules/auth/permission-catalog";
import { getUserAuthContext, requirePermission } from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createStation, setItemRouting } from "../../src/modules/menu/services/prep-station-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { seatParty } from "../../src/workflows/seat-party/seat-party";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";

import { deleteOrderExtras } from "./e2e-order-extras";
import { createOrderMenu } from "./e2e-orders";

loadLocalEnv();
pointAtTestDatabase();

// Separate markers from the other specs, so each spec's cleanup removes only its own data.
const EMAIL_DOMAIN = "kitchen-e2e.example.test";
const ROLE_PREFIX = "KITCHEN_E2E_";
const TABLE_PREFIX = "KIT-";

export type KitchenAccount = { id: string; email: string; password: string };

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string): Promise<KitchenAccount> {
  const location = await mainLocation();
  const email = `user-${randomUUID()}@${EMAIL_DOMAIN}`;
  const password = randomBytes(24).toString("base64url");
  const [user] = await getDatabase()
    .insert(users)
    .values({ email, normalizedEmail: email, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });

  await getDatabase().insert(userRoles).values({ userId: user!.id, roleId, locationId: location.id });

  return { id: user!.id, email, password };
}

export async function createKitchenRoleAccount(roleCode: string): Promise<KitchenAccount> {
  const [role] = await getDatabase().select({ id: roles.id }).from(roles).where(eq(roles.code, roleCode));

  return insertAccount(role!.id);
}

export async function createKitchenPermissionAccount(codes: readonly PermissionCode[]): Promise<KitchenAccount> {
  const { organizationId } = await mainLocation();
  const [role] = await getDatabase()
    .insert(roles)
    .values({
      organizationId,
      code: `${ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Kitchen E2E fixture",
    })
    .returning({ id: roles.id });
  const rows = await getDatabase()
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));

  await getDatabase()
    .insert(rolePermissions)
    .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));

  return insertAccount(role!.id);
}

async function actorOf(account: KitchenAccount): Promise<Actor> {
  const location = await mainLocation();
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "menu.view", locationId: location.id });
}

/**
 * The orders E2E menu (burger with a required Medium, soda), with the burger routed to a new
 * kitchen station and the soda to a new bar station, both unique to this run.
 */
export async function createKitchenMenu(owner: KitchenAccount) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const menu = await createOrderMenu(owner);
  const suffix = randomUUID().slice(0, 4).toUpperCase();
  const grill = await createStation(database, actor, {
    code: `KGRL${suffix}`,
    name: `Grill ${suffix}`,
    stationType: "KITCHEN",
    sortOrder: 0,
  });
  const bar = await createStation(database, actor, {
    code: `KBAR${suffix}`,
    name: `Bar ${suffix}`,
    stationType: "BAR",
    sortOrder: 1,
  });

  await setItemRouting(database, actor, menu.burger.id, { prepStationIds: [grill.id] });
  await setItemRouting(database, actor, menu.soda.id, { prepStationIds: [bar.id] });

  return { ...menu, grill, bar };
}

async function seatKitchenParty(owner: KitchenAccount) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const location = await mainLocation();
  const [dining] = await database
    .select({ id: restaurantAreas.id })
    .from(restaurantAreas)
    .where(and(eq(restaurantAreas.locationId, location.id), eq(restaurantAreas.areaType, "DINING")));
  const tableNumber = `${TABLE_PREFIX}${randomUUID().slice(0, 6)}`;
  const { id: tableId } = await createTable(database, actor, {
    restaurantAreaId: dining!.id,
    tableNumber,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });
  const session = await seatParty(database, actor, { tableIds: [tableId], partySize: 2, serverEmployeeId: null });

  return { tableNumber, sessionId: session.id };
}

/**
 * Opens and sends an order through the services, as a server would from the order screen:
 * dine-in at a new table (seated by `seater`), or takeout.
 */
export async function sendKitchenOrder(
  server: KitchenAccount,
  seater: KitchenAccount,
  lines: { menuItemId: string; selections?: { modifierGroupId: string; modifierId: string }[]; courseNumber?: number }[],
  orderType: "DINE_IN" | "TAKEOUT" = "DINE_IN",
  options: { send?: boolean } = {},
) {
  const database = getDatabase();
  const actor = await actorOf(server);
  const seated = orderType === "DINE_IN" ? await seatKitchenParty(seater) : null;
  const order = seated
    ? await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: seated.sessionId })
    : await createOrder(database, actor, { orderType: "TAKEOUT", customerName: "Pickup Pat" });
  let version = order.version;

  for (const line of lines) {
    const added = await addDraftItem(database, actor, order.id, {
      expectedVersion: version,
      menuItemId: line.menuItemId,
      quantity: 1,
      selections: line.selections ?? [],
      specialInstructions: null,
      courseNumber: line.courseNumber,
    });

    version = added.orderVersion;
  }

  // Phase 17: `send: false` leaves the items as drafts, for a send from the order screen.
  if (options.send !== false) {
    await sendOrderItems(database, actor, order.id, {
      expectedVersion: version,
      idempotencyKey: `e2e-${randomUUID()}`,
    });
  }

  return { orderId: order.id, orderNumber: order.orderNumber, tableNumber: seated?.tableNumber ?? null };
}

/** The burger's required Medium, read from the menu the helper created. */
export async function mediumSelection(menuItemId: string) {
  const [row] = await getDatabase()
    .select({ groupId: modifierGroupModifiers.modifierGroupId, modifierId: modifierGroupModifiers.modifierId })
    .from(menuItemModifierGroups)
    .innerJoin(modifierGroupModifiers, eq(modifierGroupModifiers.modifierGroupId, menuItemModifierGroups.modifierGroupId))
    .where(and(eq(menuItemModifierGroups.menuItemId, menuItemId), eq(menuItemModifierGroups.displayOrder, 0)));

  return [{ modifierGroupId: row!.groupId, modifierId: row!.modifierId }];
}

export async function orderStatus(orderId: string): Promise<{ status: string; tableSessionId: string | null }> {
  const [row] = await getDatabase()
    .select({ status: orders.status, tableSessionId: orders.tableSessionId })
    .from(orders)
    .where(eq(orders.id, orderId));

  return row!;
}

export async function ticketItemStatuses(orderId: string): Promise<string[]> {
  return (
    await getDatabase()
      .select({ status: kitchenTicketItems.status })
      .from(kitchenTicketItems)
      .where(eq(kitchenTicketItems.orderId, orderId))
  ).map((row) => row.status);
}

export async function firstTicketItem(orderId: string) {
  const [row] = await getDatabase()
    .select({ id: kitchenTicketItems.id, version: kitchenTicketItems.version })
    .from(kitchenTicketItems)
    .where(eq(kitchenTicketItems.orderId, orderId));

  return row!;
}

const APPEND_ONLY = [
  "order_status_history",
  "order_item_status_history",
  "order_send_batches",
  "order_item_inventory_consumption",
  "order_item_voids",
  "kitchen_ticket_item_status_history",
];

const GUARDED: readonly [string, string][] = [
  ["kitchen_tickets", "kitchen_tickets_guard_trigger"],
  ["order_items", "order_items_freeze_trigger"],
  ["order_item_modifiers", "order_item_modifiers_freeze_trigger"],
  ["kitchen_ticket_items", "kitchen_ticket_items_guard_trigger"],
  ["notifications", "notifications_guard_trigger"],
];

/**
 * Removes the orders, kitchen work, notifications, sessions, tables and accounts this spec
 * created. The spec makes no Remakes, so tickets and items delete in order. Outbox events
 * stay in the disposable test database; accounts are disabled, not deleted.
 */
export async function removeKitchenE2eData(): Promise<void> {
  const database = getDatabase();
  const userIds = (
    await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`))
  ).map((row) => row.id);

  if (userIds.length === 0) {
    await closeDatabase();

    return;
  }

  const orderIds = (
    await database.select({ id: orders.id }).from(orders).where(inArray(orders.openedByUserId, userIds))
  ).map((row) => row.id);
  const tableIds = (
    await database
      .select({ id: restaurantTables.id })
      .from(restaurantTables)
      .where(like(restaurantTables.tableNumber, `${TABLE_PREFIX}%`))
  ).map((row) => row.id);

  await database.transaction(async (transaction) => {
    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}` as never);
    }

    if (orderIds.length) {
      await deleteOrderExtras(transaction, orderIds);

      const workIds = (
        await transaction
          .select({ id: kitchenTicketItems.id })
          .from(kitchenTicketItems)
          .where(inArray(kitchenTicketItems.orderId, orderIds))
      ).map((row) => row.id);

      await transaction.delete(notifications).where(inArray(notifications.orderId, orderIds));

      if (workIds.length) {
        await transaction
          .delete(kitchenTicketItemStatusHistory)
          .where(inArray(kitchenTicketItemStatusHistory.ticketItemId, workIds));
        await transaction.delete(kitchenTicketItems).where(inArray(kitchenTicketItems.id, workIds));
      }

      await transaction.delete(kitchenTickets).where(inArray(kitchenTickets.orderId, orderIds));

      const itemIds = (
        await transaction.select({ id: orderItems.id }).from(orderItems).where(inArray(orderItems.orderId, orderIds))
      ).map((row) => row.id);

      if (itemIds.length) {
        await transaction.delete(orderItemVoids).where(inArray(orderItemVoids.orderItemId, itemIds));
        await transaction
          .delete(orderItemInventoryConsumption)
          .where(inArray(orderItemInventoryConsumption.orderItemId, itemIds));
        await transaction.delete(orderItemStatusHistory).where(inArray(orderItemStatusHistory.orderItemId, itemIds));
        await transaction.delete(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, itemIds));
        await transaction.delete(orderItems).where(inArray(orderItems.id, itemIds));
      }

      await transaction.delete(orderSendBatches).where(inArray(orderSendBatches.orderId, orderIds));
      await transaction.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
      await transaction.delete(orders).where(inArray(orders.id, orderIds));
    }

    await transaction.delete(idempotencyRecords).where(inArray(idempotencyRecords.actorUserId, userIds));

    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    for (const [table, trigger] of GUARDED) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}` as never);
    }
  });

  const sessionIds = (
    await database.select({ id: tableSessions.id }).from(tableSessions).where(inArray(tableSessions.createdByUserId, userIds))
  ).map((row) => row.id);

  if (sessionIds.length) {
    await database.delete(tableSessionTables).where(inArray(tableSessionTables.tableSessionId, sessionIds));
    await database.delete(tableSessions).where(inArray(tableSessions.id, sessionIds));
  }

  if (tableIds.length) {
    await database.delete(tableConditionHistory).where(inArray(tableConditionHistory.restaurantTableId, tableIds));
    await database.delete(restaurantTables).where(inArray(restaurantTables.id, tableIds));
  }

  await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
  await database
    .delete(roles)
    .where(like(roles.code, `${ROLE_PREFIX}%`))
    .catch(() => undefined);
  await database.update(users).set({ active: false, disabledAt: new Date() }).where(inArray(users.id, userIds));
  await closeDatabase();
}
