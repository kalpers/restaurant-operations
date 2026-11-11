import { randomBytes, randomUUID } from "node:crypto";

import { eq, inArray, like, or } from "drizzle-orm";

import { loadLocalEnv, pointAtTestDatabase } from "../../src/config/tooling-env";
import { closeDatabase, getDatabase } from "../../src/db";
import {
  inventoryBalances,
  inventoryCountLines,
  inventoryCounts,
  inventoryItemLocations,
  inventoryItems,
  inventoryItemUnitConversions,
  inventoryTransactions,
  locations,
  permissions,
  purchaseOrderLines,
  purchaseOrderReceiptLines,
  purchaseOrderReceipts,
  purchaseOrders,
  recipes,
  recipeVersionIngredients,
  recipeVersions,
  rolePermissions,
  roles,
  supplierItemCostHistory,
  supplierItems,
  suppliers,
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
import {
  addConversion,
  createItem,
  setItemLocation,
} from "../../src/modules/inventory/services/item-service";
import { postInventoryTransaction } from "../../src/modules/inventory/services/posting-service";
import {
  createSupplier,
  createSupplierItem,
} from "../../src/modules/inventory/services/supplier-service";
import { clearAuditEvents } from "../fixtures/audit-cleanup";
import { clearStockSignalRows } from "./e2e-stock-signals";

loadLocalEnv();
pointAtTestDatabase();

// Separate from the other specs' data, and removed by these markers when the spec ends.
const EMAIL_DOMAIN = "inventory-e2e.example.test";
const ROLE_PREFIX = "INVENTORY_E2E_";
export const CODE_PREFIX = "E2EI_";

export type InventoryAccount = { id: string; email: string; password: string };

export const uniqueCode = (suffix = "") =>
  `${CODE_PREFIX}${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}${suffix}`;

async function mainLocation() {
  const [location] = await getDatabase()
    .select({ id: locations.id, organizationId: locations.organizationId })
    .from(locations)
    .where(eq(locations.locationCode, "MAIN"));

  return location!;
}

async function insertAccount(roleId: string): Promise<InventoryAccount> {
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

export async function createRoleAccount(roleCode: string): Promise<InventoryAccount> {
  const [role] = await getDatabase().select({ id: roles.id }).from(roles).where(eq(roles.code, roleCode));

  return insertAccount(role!.id);
}

export async function createPermissionAccount(codes: readonly PermissionCode[]): Promise<InventoryAccount> {
  const { organizationId } = await mainLocation();
  const [role] = await getDatabase()
    .insert(roles)
    .values({
      organizationId,
      code: `${ROLE_PREFIX}${randomUUID().replaceAll("-", "_").toUpperCase()}`,
      name: "Inventory E2E fixture",
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

async function actorOf(account: InventoryAccount): Promise<Actor> {
  const location = await mainLocation();
  const context = await getUserAuthContext(getDatabase(), account.id);

  return requirePermission(context!, { permission: "inventory.view", locationId: location.id });
}

export async function unitId(code: string) {
  const [unit] = await getDatabase()
    .select({ id: unitsOfMeasure.id })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.code, code));

  return unit!.id;
}

/** An item stocked at MAIN, optionally with packaging and an opening balance. */
export async function createStockedItem(
  owner: InventoryAccount,
  options: {
    name: string;
    baseUnit: string;
    measurementType?: "COUNT" | "WEIGHT" | "VOLUME";
    conversions?: { from: string; to: string; factor: string }[];
    opening?: string;
  },
) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const baseUnitId = await unitId(options.baseUnit);
  const item = await createItem(database, actor, {
    code: uniqueCode("_ITM"),
    name: options.name,
    description: null,
    measurementType: options.measurementType ?? "COUNT",
    baseUnitId,
  });

  for (const conversion of options.conversions ?? []) {
    await addConversion(database, actor, item.id, {
      fromUnitId: await unitId(conversion.from),
      toUnitId: await unitId(conversion.to),
      factor: conversion.factor,
    });
  }

  await setItemLocation(database, actor, item.id, {
    parLevel: null,
    reorderLevel: null,
    reorderTarget: null,
    storageNote: null,
    active: true,
    expectedVersion: null,
  });

  if (options.opening) {
    await withTransaction(database, (transaction) =>
      postInventoryTransaction(transaction, {
        organizationId: actor.organizationId,
        locationId: actor.locationId,
        inventoryItemId: item.id,
        type: "RECEIVE",
        quantity: options.opening!,
        unitOfMeasureId: baseUnitId,
        incomingTotalCost: options.opening!,
        createdByUserId: actor.userId,
      }),
    );
  }

  return item;
}

export async function createSupplierFor(
  owner: InventoryAccount,
  name: string,
  items: { inventoryItemId: string; purchaseUnit: string; lastUnitCost: string }[],
) {
  const database = getDatabase();
  const actor = await actorOf(owner);
  const supplier = await createSupplier(database, actor, {
    code: uniqueCode("_SUP"),
    name,
    contactName: null,
    phone: null,
    email: null,
  });

  for (const item of items) {
    await createSupplierItem(database, actor, supplier.id, {
      inventoryItemId: item.inventoryItemId,
      purchaseUnitId: await unitId(item.purchaseUnit),
      supplierSku: null,
      lastUnitCost: item.lastUnitCost,
    });
  }

  return supplier;
}

export async function ledgerRowsFor(inventoryItemId: string) {
  return getDatabase()
    .select()
    .from(inventoryTransactions)
    .where(eq(inventoryTransactions.inventoryItemId, inventoryItemId));
}

const APPEND_ONLY = [
  "inventory_transactions",
  "purchase_order_receipts",
  "purchase_order_receipt_lines",
  "supplier_item_cost_history",
] as const;

/**
 * Test cleanup. Posted history is append-only, so this lifts the triggers for its own
 * transaction only, removes what this spec created, and restores them.
 */
export async function removeInventoryE2eData(): Promise<void> {
  const database = getDatabase();
  const accounts = await database
    .select({ id: users.id })
    .from(users)
    .where(like(users.normalizedEmail, `%@${EMAIL_DOMAIN}`));
  const userIds = accounts.map((row) => row.id);
  const itemIds = (
    await database.select({ id: inventoryItems.id }).from(inventoryItems).where(like(inventoryItems.code, `${CODE_PREFIX}%`))
  ).map((row) => row.id);
  const supplierIds = (
    await database.select({ id: suppliers.id }).from(suppliers).where(like(suppliers.code, `${CODE_PREFIX}%`))
  ).map((row) => row.id);
  const recipeIds = (
    await database.select({ id: recipes.id }).from(recipes).where(like(recipes.code, `${CODE_PREFIX}%`))
  ).map((row) => row.id);

  await clearAuditEvents(database, { userIds });
  await database.transaction(async (transaction) => {
    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    await transaction.execute("ALTER TABLE recipe_version_ingredients DISABLE TRIGGER recipe_version_ingredients_freeze_trigger" as never);
    await transaction.execute("ALTER TABLE recipe_versions DISABLE TRIGGER recipe_versions_forbid_published_delete_trigger" as never);

    const ownSupplierItemIds = supplierIds.length
      ? (await transaction.select({ id: supplierItems.id }).from(supplierItems).where(inArray(supplierItems.supplierId, supplierIds))).map(
          (row) => row.id,
        )
      : [];

    await clearStockSignalRows(transaction, { userIds, inventoryItemIds: itemIds, supplierItemIds: ownSupplierItemIds });

    if (userIds.length) {
      const countIds = (
        await transaction.select({ id: inventoryCounts.id }).from(inventoryCounts).where(inArray(inventoryCounts.startedByUserId, userIds))
      ).map((row) => row.id);

      if (countIds.length) {
        await transaction.delete(inventoryCountLines).where(inArray(inventoryCountLines.inventoryCountId, countIds));
        await transaction.delete(inventoryCounts).where(inArray(inventoryCounts.id, countIds));
      }
    }

    if (supplierIds.length) {
      const orderIds = (
        await transaction.select({ id: purchaseOrders.id }).from(purchaseOrders).where(inArray(purchaseOrders.supplierId, supplierIds))
      ).map((row) => row.id);
      const supplierItemIds = (
        await transaction.select({ id: supplierItems.id }).from(supplierItems).where(inArray(supplierItems.supplierId, supplierIds))
      ).map((row) => row.id);

      if (orderIds.length) {
        const receiptIds = (
          await transaction.select({ id: purchaseOrderReceipts.id }).from(purchaseOrderReceipts).where(inArray(purchaseOrderReceipts.purchaseOrderId, orderIds))
        ).map((row) => row.id);

        if (supplierItemIds.length) {
          await transaction.delete(supplierItemCostHistory).where(inArray(supplierItemCostHistory.supplierItemId, supplierItemIds));
        }

        if (receiptIds.length) {
          await transaction.delete(purchaseOrderReceiptLines).where(inArray(purchaseOrderReceiptLines.receiptId, receiptIds));
          await transaction.delete(purchaseOrderReceipts).where(inArray(purchaseOrderReceipts.id, receiptIds));
        }

        await transaction.delete(purchaseOrderLines).where(inArray(purchaseOrderLines.purchaseOrderId, orderIds));
        await transaction.delete(purchaseOrders).where(inArray(purchaseOrders.id, orderIds));
      }

      if (supplierItemIds.length) {
        await transaction.delete(supplierItemCostHistory).where(inArray(supplierItemCostHistory.supplierItemId, supplierItemIds));
        await transaction.delete(supplierItems).where(inArray(supplierItems.id, supplierItemIds));
      }

      await transaction.delete(suppliers).where(inArray(suppliers.id, supplierIds));
    }

    if (recipeIds.length) {
      const versionIds = (
        await transaction.select({ id: recipeVersions.id }).from(recipeVersions).where(inArray(recipeVersions.recipeId, recipeIds))
      ).map((row) => row.id);

      if (versionIds.length) {
        await transaction.delete(recipeVersionIngredients).where(inArray(recipeVersionIngredients.recipeVersionId, versionIds));
        await transaction.delete(recipeVersions).where(inArray(recipeVersions.id, versionIds));
      }

      await transaction.delete(recipes).where(inArray(recipes.id, recipeIds));
    }

    if (itemIds.length) {
      await transaction.delete(recipeVersionIngredients).where(inArray(recipeVersionIngredients.inventoryItemId, itemIds));
      await transaction.delete(inventoryTransactions).where(inArray(inventoryTransactions.inventoryItemId, itemIds));
      await transaction.delete(inventoryBalances).where(inArray(inventoryBalances.inventoryItemId, itemIds));
      await transaction.delete(inventoryItemUnitConversions).where(inArray(inventoryItemUnitConversions.inventoryItemId, itemIds));
      await transaction.delete(inventoryItemLocations).where(inArray(inventoryItemLocations.inventoryItemId, itemIds));
      await transaction.delete(inventoryItems).where(inArray(inventoryItems.id, itemIds));
    }

    if (userIds.length) {
      // Anything else these users posted (on seeded items) goes too.
      await transaction.delete(inventoryTransactions).where(or(inArray(inventoryTransactions.createdByUserId, userIds)));
      await transaction.delete(userRoles).where(inArray(userRoles.userId, userIds));
      await transaction.delete(users).where(inArray(users.id, userIds));
    }

    for (const table of APPEND_ONLY) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    await transaction.execute("ALTER TABLE recipe_version_ingredients ENABLE TRIGGER recipe_version_ingredients_freeze_trigger" as never);
    await transaction.execute("ALTER TABLE recipe_versions ENABLE TRIGGER recipe_versions_forbid_published_delete_trigger" as never);
  });

  const fixtureRoles = await database.select({ id: roles.id }).from(roles).where(like(roles.code, `${ROLE_PREFIX}%`));
  const roleIds = fixtureRoles.map((row) => row.id);

  if (roleIds.length) {
    await database.delete(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
    await database.delete(roles).where(inArray(roles.id, roleIds));
  }

  await closeDatabase();
}
