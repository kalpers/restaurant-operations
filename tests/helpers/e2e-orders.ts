import { randomBytes, randomUUID } from "node:crypto";

import { and, eq, inArray, like, or } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  idempotencyRecords,
  inventoryBalances,
  inventoryTransactions,
  locations,
  orderDiscounts,
  orderItemDiscounts,
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
  settlements,
  settlementStatusHistory,
  settlementTenders,
  tableConditionHistory,
  tableSessions,
  tableSessionTables,
  unitsOfMeasure,
  userRoles,
  users,
} from "../../src/db/schema";
import { withTransaction } from "../../src/db/transactions/transaction-context";
import { hashPassword } from "../../src/modules/auth/password";
import type { PermissionCode } from "../../src/modules/auth/permission-catalog";
import {
  getUserAuthContext,
  requirePermission,
} from "../../src/modules/auth/services/permission-service";
import type { Actor } from "../../src/modules/auth/types";
import { createItem as createInventoryItem, setItemLocation } from "../../src/modules/inventory/services/item-service";
import { postInventoryTransaction } from "../../src/modules/inventory/services/posting-service";
import {
  createCategory,
  createItem,
  createMenu,
  createPlacement,
  setMenuLocation,
} from "../../src/modules/menu/services/catalog-service";
import { addModifierEffect } from "../../src/modules/menu/services/modifier-effect-service";
import {
  attachGroup,
  createGroup,
  createModifier,
  setGroupModifier,
} from "../../src/modules/menu/services/modifier-service";
import { changePrice } from "../../src/modules/menu/services/pricing-service";
import { addIngredient } from "../../src/modules/recipes/services/ingredient-service";
import {
  createDraftRevision,
  createRecipe,
  publishRevision,
} from "../../src/modules/recipes/services/recipe-service";
import { createTable } from "../../src/modules/restaurant/services/table-service";
import { addDraftItem } from "../../src/modules/orders/services/draft-item-service";
import { createOrder } from "../../src/modules/orders/services/order-service";
import { applyOrderDiscount, createDiscountDefinition } from "../../src/modules/orders/services/discount-service";
import { openSettlement, recordTender } from "../../src/modules/settlements/services/settlement-service";
import { completeSettlement } from "../../src/workflows/close-order/complete-settlement";
import { sendOrderItems } from "../../src/workflows/submit-order/submit-order";
import { seatParty } from "../../src/workflows/seat-party/seat-party";

loadLocalEnv();
pointAtTestDatabase();

// Separate from the other specs' data and removed by these markers when the spec ends.
// Specs run on parallel workers, so every spec that uses these helpers passes its own
// scope: one spec's cleanup must never disable another's accounts mid-test.
export type E2eScope = { emailDomain: string; rolePrefix: string; tablePrefix: string };

export const ORDERS_SCOPE: E2eScope = {
  emailDomain: "orders-e2e.example.test",
  rolePrefix: "ORDERS_E2E_",
  tablePrefix: "ORD-",
};

export const SETTLEMENTS_SCOPE: E2eScope = {
  emailDomain: "settlements-e2e.example.test",
  rolePrefix: "SETTLEMENTS_E2E_",
  tablePrefix: "SET-",
};

export const REPORTS_SCOPE: E2eScope = {
  emailDomain: "reports-e2e.example.test",
  rolePrefix: "REPORTS_E2E_",
  tablePrefix: "REP-",
};

export const CODE_PREFIX = "E2EO_";

export type OrdersAccount = { id: string; email: string; password: string };

export const uniqueCode = () => `${CODE_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string, scope: E2eScope): Promise<OrdersAccount> {
  const location = await mainLocation();
  const email = `user-${randomUUID()}@${scope.emailDomain}`;
  const password = randomBytes(24).toString("base64url");
  const [user] = await getDatabase()
    .insert(users)
    .values({ email, normalizedEmail: email, passwordHash: await hashPassword(password) })
    .returning({ id: users.id });

  await getDatabase().insert(userRoles).values({ userId: user!.id, roleId, locationId: location.id });

  return { id: user!.id, email, password };
}

export async function createRoleAccount(roleCode: string, scope: E2eScope = ORDERS_SCOPE): Promise<OrdersAccount> {
  const [role] = await getDatabase().select({ id: roles.id }).from(roles).where(eq(roles.code, roleCode));

  return insertAccount(role!.id, scope);
}

export async function createPermissionAccount(
  codes: readonly PermissionCode[],
  scope: E2eScope = ORDERS_SCOPE,
): Promise<OrdersAccount> {
  const { organizationId } = await mainLocation();
  const [role] = await getDatabase()
    .insert(roles)
    .values({
      organizationId,
      code: `${scope.rolePrefix}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Orders E2E fixture",
    })
    .returning({ id: roles.id });
  const rows = await getDatabase()
    .select({ id: permissions.id })
    .from(permissions)
    .where(inArray(permissions.code, [...codes]));

  await getDatabase()
    .insert(rolePermissions)
    .values(rows.map((row) => ({ roleId: role!.id, permissionId: row.id })));

  return insertAccount(role!.id, scope);
}

async function actorOf(account: OrdersAccount): Promise<Actor> {
  const location = await mainLocation();
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "menu.view", locationId: location.id });
}

async function unit(code: string) {
  const [row] = await getDatabase().select({ id: unitsOfMeasure.id }).from(unitsOfMeasure).where(eq(unitsOfMeasure.code, code));

  return row!.id;
}

/**
 * A burger sold at MAIN for 12.00 on its own menu: a required Temperature (Medium) and an
 * optional Extra Pickles (+0.75, ADJUST pickles +2). Recipe: beef 1 EACH, pickles 3 EACH.
 * Plus a 2.50 soda with no recipe. Both ingredients have 50 on hand.
 */
export async function createOrderMenu(owner: OrdersAccount) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const each = await unit("EACH");
  const suffix = randomUUID().slice(0, 6);
  const stock = async (name: string) => {
    const item = await createInventoryItem(database, actor, {
      code: uniqueCode(),
      name,
      description: null,
      measurementType: "COUNT",
      baseUnitId: each,
    });

    await setItemLocation(database, actor, item.id, {
      parLevel: null,
      reorderLevel: null,
      reorderTarget: null,
      storageNote: null,
      active: true,
      expectedVersion: null,
    });
    await withTransaction(database, (transaction) =>
      postInventoryTransaction(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        inventoryItemId: item.id,
        type: "RECEIVE",
        quantity: "50",
        unitOfMeasureId: each,
        incomingTotalCost: "25.00",
        createdByUserId: actor.userId,
      }),
    );

    return item;
  };
  const beef = await stock(`E2E Patty ${suffix}`);
  const pickles = await stock(`E2E Pickle ${suffix}`);
  const menu = await createMenu(database, actor, { code: uniqueCode(), name: `E2E Orders ${suffix}`, description: null, displayOrder: 0 });

  await setMenuLocation(database, actor, menu.id, { locationId: actor.locationId, active: true });

  const category = await createCategory(database, actor, {
    code: uniqueCode(),
    name: `E2E Mains ${suffix}`,
    description: null,
    displayOrder: 0,
  });
  const sell = async (name: string, price: string) => {
    const item = await createItem(database, actor, {
      code: uniqueCode(),
      name,
      shortName: null,
      description: null,
      itemType: "FOOD",
      displayOrder: 0,
    });

    await changePrice(database, actor, item.id, { locationId: null, price, effectiveFrom: null }, new Date("2024-01-01T00:00:00Z"));
    await createPlacement(database, actor, { menuId: menu.id, menuCategoryId: category.id, menuItemId: item.id, displayOrder: 0 });

    return item;
  };
  const burger = await sell(`E2E Burger ${suffix}`, "12.00");
  const soda = await sell(`E2E Soda ${suffix}`, "2.50");
  const modifier = (name: string, priceAdjustment: string, instruction: string) =>
    createModifier(database, actor, {
      code: uniqueCode(),
      name,
      description: null,
      priceAdjustment,
      preparationEffectType: "INSTRUCTION",
      preparationInstruction: instruction,
    });
  const medium = await modifier("Medium", "0.00", "Cook medium");
  const extraPickles = await modifier("Extra Pickles", "0.75", "Extra pickles");
  const group = async (name: string, selectionType: "REQUIRED_SINGLE" | "OPTIONAL_MULTIPLE", modifierId: string) => {
    const created = await createGroup(database, actor, {
      code: uniqueCode(),
      name,
      description: null,
      selectionType,
      minimumSelections: selectionType === "REQUIRED_SINGLE" ? 1 : 0,
      maximumSelections: selectionType === "REQUIRED_SINGLE" ? 1 : 3,
      displayOrder: 0,
    });

    await setGroupModifier(database, actor, created.id, { modifierId, displayOrder: 0, active: true });
    await attachGroup(database, actor, burger.id, {
      modifierGroupId: created.id,
      displayOrder: selectionType === "REQUIRED_SINGLE" ? 0 : 1,
      requiredOverride: null,
      minimumOverride: null,
      maximumOverride: null,
    });
  };

  await group("Temperature", "REQUIRED_SINGLE", medium.id);
  await group("Toppings", "OPTIONAL_MULTIPLE", extraPickles.id);

  const recipe = await createRecipe(database, actor, { code: uniqueCode(), name: `E2E Burger ${suffix}`, description: null, menuItemId: burger.id });
  const draft = await createDraftRevision(database, actor, recipe.id, { yieldQuantity: "1", yieldUnitId: each, preparationNotes: null });
  const first = await addIngredient(database, actor, recipe.id, draft.id, {
    inventoryItemId: beef.id,
    quantity: "1",
    unitOfMeasureId: each,
    preparationNote: null,
    sortOrder: 0,
    expectedVersion: draft.version,
  });
  const second = await addIngredient(database, actor, recipe.id, draft.id, {
    inventoryItemId: pickles.id,
    quantity: "3",
    unitOfMeasureId: each,
    preparationNote: null,
    sortOrder: 1,
    expectedVersion: first.revisionVersion,
  });

  await publishRevision(database, actor, recipe.id, draft.id, { effectiveFrom: null, expectedVersion: second.revisionVersion }, new Date("2024-01-01T00:00:00Z"));
  await addModifierEffect(database, actor, extraPickles.id, {
    menuItemId: burger.id,
    inventoryItemId: pickles.id,
    effectType: "ADJUST",
    quantity: "2",
    unitOfMeasureId: each,
  });

  return { categoryName: category.name, burger, soda, beef, pickles };
}

/** A new dining table at MAIN with a seated party of two. */
export async function seatE2eParty(owner: OrdersAccount, scope: E2eScope = ORDERS_SCOPE) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const location = await mainLocation();
  const [dining] = await database
    .select({ id: restaurantAreas.id })
    .from(restaurantAreas)
    .where(and(eq(restaurantAreas.locationId, location.id), eq(restaurantAreas.areaType, "DINING")));
  const tableNumber = `${scope.tablePrefix}${randomUUID().slice(0, 6)}`;
  const { id: tableId } = await createTable(database, actor, {
    restaurantAreaId: dining!.id,
    tableNumber,
    name: null,
    capacity: 4,
    minimumCapacity: null,
    sortOrder: null,
  });
  const session = await seatParty(database, actor, { tableIds: [tableId], partySize: 2, serverEmployeeId: null });

  return { tableNumber, tableId, sessionId: session.id };
}

/** A takeout order with one unsent soda, opened by the owner through the services. */
export async function takeoutWithDraft(owner: OrdersAccount, menuItemId: string) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const order = await createOrder(database, actor, { orderType: "TAKEOUT" });
  const added = await addDraftItem(database, actor, order.id, {
    expectedVersion: order.version,
    menuItemId,
    quantity: 1,
    selections: [],
    specialInstructions: null,
  });

  return { orderId: order.id, version: added.orderVersion };
}

/** An order (takeout, or dine-in on a session) with the given items sent, through the services. */
export async function sentOrderFor(
  owner: OrdersAccount,
  menuItemIds: readonly string[],
  options: { tableSessionId?: string } = {},
) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const order = options.tableSessionId
    ? await createOrder(database, actor, { orderType: "DINE_IN", tableSessionId: options.tableSessionId })
    : await createOrder(database, actor, { orderType: "TAKEOUT" });
  let version = order.version;

  for (const menuItemId of menuItemIds) {
    version = (
      await addDraftItem(database, actor, order.id, {
        expectedVersion: version,
        menuItemId,
        quantity: 1,
        selections: [],
        specialInstructions: null,
      })
    ).orderVersion;
  }

  const sent = await sendOrderItems(database, actor, order.id, {
    expectedVersion: version,
    idempotencyKey: `e2e-${randomUUID()}`,
  });

  return { orderId: order.id, version: sent.orderVersion };
}

/** Settles an order in exact cash and closes it, through the Phase 11 services. */
export async function settleInCashFor(owner: OrdersAccount, orderId: string) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const opened = await openSettlement(database, actor, orderId);
  const recorded = await recordTender(database, actor, opened.settlementId, {
    idempotencyKey: `e2e-${randomUUID()}`,
    expectedVersion: opened.settlementVersion,
    tenderType: "CASH",
    outcome: "RECORDED",
    amount: opened.orderAmountSnapshot,
    tipAmount: null,
    receivedAmount: opened.orderAmountSnapshot,
    externalReference: null,
    providerName: null,
    cardBrand: null,
    cardLastFour: null,
    authorizationReference: null,
    otherDescription: null,
    failureReason: null,
  });

  await completeSettlement(database, actor, opened.settlementId, {
    expectedVersion: recorded.settlementVersion,
    idempotencyKey: `e2e-${randomUUID()}`,
  });
}

/** Applies a 100% order comp, so the amount due is 0.00. */
export async function compOrder(owner: OrdersAccount, orderId: string, version: number) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const definition = await createDiscountDefinition(database, actor, {
    code: uniqueCode(),
    name: "E2E full comp",
    scope: "ORDER",
    discountType: "PERCENTAGE",
    value: "100",
  });

  await applyOrderDiscount(database, actor, orderId, {
    discountDefinitionId: definition.id,
    reason: "Comped for the test",
    expectedVersion: version,
  });
}

/** Every stored tender text column for the given orders, for the no-card-data check. */
export async function tenderTextFor(orderIds: readonly string[]): Promise<string> {
  const rows = await getDatabase()
    .select({ tender: settlementTenders })
    .from(settlementTenders)
    .innerJoin(settlements, eq(settlements.id, settlementTenders.settlementId))
    .where(inArray(settlements.orderId, [...orderIds]));

  return JSON.stringify(rows);
}

export async function orderStatus(orderId: string): Promise<string> {
  const [row] = await getDatabase().select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));

  return row!.status;
}

export async function onHand(inventoryItemId: string): Promise<string> {
  const [row] = await getDatabase()
    .select({ quantity: inventoryBalances.quantityOnHand })
    .from(inventoryBalances)
    .where(eq(inventoryBalances.inventoryItemId, inventoryItemId));

  return row?.quantity ?? "0.0000";
}

export async function ledgerTypesFor(inventoryItemId: string): Promise<string[]> {
  return (
    await getDatabase()
      .select({ type: inventoryTransactions.transactionType })
      .from(inventoryTransactions)
      .where(eq(inventoryTransactions.inventoryItemId, inventoryItemId))
      .orderBy(inventoryTransactions.sequence)
  ).map((row) => row.type);
}

export async function sessionsCreatedBy(userId: string): Promise<number> {
  return (await getDatabase().select({ id: tableSessions.id }).from(tableSessions).where(eq(tableSessions.createdByUserId, userId))).length;
}

const APPEND_ONLY = [
  "order_status_history",
  "order_item_status_history",
  "order_send_batches",
  "order_item_inventory_consumption",
  "order_item_voids",
  "settlement_status_history",
];

/**
 * Removes the orders, sessions, tables and accounts this spec created. Order history is
 * append-only, so the triggers are lifted for this transaction only. Menu, recipe and
 * stock configuration stays, marked by its code prefix, in the disposable test database.
 */
export async function removeOrdersE2eData(scope: E2eScope = ORDERS_SCOPE): Promise<void> {
  const database = getDatabase();
  const accounts = await database.select({ id: users.id }).from(users).where(like(users.normalizedEmail, `%@${scope.emailDomain}`));
  const userIds = accounts.map((row) => row.id);

  if (userIds.length === 0) {
    await closeDatabase();

    return;
  }

  const orderIds = (
    await database.select({ id: orders.id }).from(orders).where(inArray(orders.openedByUserId, userIds))
  ).map((row) => row.id);
  const tableIds = (
    await database.select({ id: restaurantTables.id }).from(restaurantTables).where(like(restaurantTables.tableNumber, `${scope.tablePrefix}%`))
  ).map((row) => row.id);

  await database.transaction(async (transaction) => {
    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    await transaction.execute("ALTER TABLE order_items DISABLE TRIGGER order_items_freeze_trigger" as never);
    await transaction.execute("ALTER TABLE order_item_modifiers DISABLE TRIGGER order_item_modifiers_freeze_trigger" as never);
    await transaction.execute("ALTER TABLE order_settlements DISABLE TRIGGER order_settlements_guard_trigger" as never);
    await transaction.execute("ALTER TABLE settlement_tenders DISABLE TRIGGER settlement_tenders_guard_trigger" as never);

    if (orderIds.length) {
      const settlementIds = (
        await transaction.select({ id: settlements.id }).from(settlements).where(inArray(settlements.orderId, orderIds))
      ).map((row) => row.id);

      if (settlementIds.length) {
        await transaction.delete(settlementTenders).where(inArray(settlementTenders.settlementId, settlementIds));
        await transaction.delete(settlementStatusHistory).where(inArray(settlementStatusHistory.settlementId, settlementIds));
        await transaction.delete(settlements).where(inArray(settlements.id, settlementIds));
      }

      const itemIds = (
        await transaction.select({ id: orderItems.id }).from(orderItems).where(inArray(orderItems.orderId, orderIds))
      ).map((row) => row.id);

      if (itemIds.length) {
        await transaction.delete(orderItemDiscounts).where(inArray(orderItemDiscounts.orderItemId, itemIds));
        await transaction.delete(orderItemVoids).where(inArray(orderItemVoids.orderItemId, itemIds));
        await transaction.delete(orderItemInventoryConsumption).where(inArray(orderItemInventoryConsumption.orderItemId, itemIds));
        await transaction.delete(orderItemStatusHistory).where(inArray(orderItemStatusHistory.orderItemId, itemIds));
        await transaction.delete(orderItemModifiers).where(inArray(orderItemModifiers.orderItemId, itemIds));
        await transaction.delete(orderItems).where(inArray(orderItems.id, itemIds));
      }

      await transaction.delete(orderDiscounts).where(inArray(orderDiscounts.orderId, orderIds));
      await transaction.delete(orderSendBatches).where(inArray(orderSendBatches.orderId, orderIds));
      await transaction.delete(orderStatusHistory).where(inArray(orderStatusHistory.orderId, orderIds));
      await transaction.delete(orders).where(inArray(orders.id, orderIds));
    }

    await transaction.delete(idempotencyRecords).where(inArray(idempotencyRecords.actorUserId, userIds));

    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    await transaction.execute("ALTER TABLE order_items ENABLE TRIGGER order_items_freeze_trigger" as never);
    await transaction.execute("ALTER TABLE order_item_modifiers ENABLE TRIGGER order_item_modifiers_freeze_trigger" as never);
    await transaction.execute("ALTER TABLE order_settlements ENABLE TRIGGER order_settlements_guard_trigger" as never);
    await transaction.execute("ALTER TABLE settlement_tenders ENABLE TRIGGER settlement_tenders_guard_trigger" as never);
  });

  const sessionIds = (
    await database
      .select({ id: tableSessions.id })
      .from(tableSessions)
      .where(inArray(tableSessions.createdByUserId, userIds))
  ).map((row) => row.id);

  if (sessionIds.length) {
    await database.delete(tableSessionTables).where(inArray(tableSessionTables.tableSessionId, sessionIds));
    await database.delete(tableSessions).where(inArray(tableSessions.id, sessionIds));
  }

  if (tableIds.length) {
    await database.delete(tableConditionHistory).where(inArray(tableConditionHistory.restaurantTableId, tableIds));
    await database.delete(restaurantTables).where(inArray(restaurantTables.id, tableIds));
  }

  // Users stay referenced by the append-only ledger, so accounts are disabled, not deleted.
  await database.delete(userRoles).where(inArray(userRoles.userId, userIds));
  await database
    .delete(roles)
    .where(or(like(roles.code, `${scope.rolePrefix}%`)))
    .catch(() => undefined);
  await database.update(users).set({ active: false, disabledAt: new Date() }).where(inArray(users.id, userIds));
  await closeDatabase();
}
