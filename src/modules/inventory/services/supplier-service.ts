import { and, asc, desc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import {
  inventoryItems,
  supplierItemCostHistory,
  supplierItems,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { compareDecimals, toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";

import { convertItemQuantity, requireItemFacts } from "../repositories/conversion-repository";
import { assertAnyPermission, assertPermission, canSeeCost } from "./access";

type SupplierInput = {
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
};

export async function listSuppliers(executor: DatabaseExecutor, actor: Actor) {
  assertAnyPermission(actor, ["purchasing.view", "suppliers.manage"]);

  return executor
    .select()
    .from(suppliers)
    .where(eq(suppliers.organizationId, actor.organizationId))
    .orderBy(asc(suppliers.name));
}

export async function createSupplier(
  database: Database,
  actor: Actor,
  input: SupplierInput & { code: string },
) {
  assertPermission(actor, "suppliers.manage");

  try {
    const [row] = await database
      .insert(suppliers)
      .values({ ...input, organizationId: actor.organizationId })
      .returning();

    return row!;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("CODE_TAKEN", "Another supplier already uses that code.");
    }

    throw error;
  }
}

export async function updateSupplier(
  database: Database,
  actor: Actor,
  supplierId: string,
  input: SupplierInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "suppliers.manage");

  const { expectedVersion, ...values } = input;

  return updateVersioned(database, suppliers, {
    id: supplierId,
    organizationId: actor.organizationId,
    expectedVersion,
    values,
    label: "supplier",
  });
}

export async function requireSupplier(
  executor: DatabaseExecutor,
  actor: Actor,
  supplierId: string,
) {
  const [supplier] = await executor
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.id, supplierId), eq(suppliers.organizationId, actor.organizationId)));

  if (!supplier) {
    throw new NotFoundError("supplier");
  }

  return supplier;
}

const normalizeCost = (value: string | null) => {
  if (value === null) {
    return null;
  }

  let cost: string;

  try {
    cost = toScale(value, 4);
  } catch {
    throw new BusinessRuleError("INVALID_COST", "A cost has at most four decimal places.");
  }

  if (compareDecimals(cost, "0") < 0) {
    throw new BusinessRuleError("INVALID_COST", "A cost can't be negative.");
  }

  return cost;
};

/** A supplier's items, with costs only for holders of `inventory.cost.view`. */
export async function listSupplierItems(
  executor: DatabaseExecutor,
  actor: Actor,
  filter: { supplierId?: string; inventoryItemId?: string } = {},
) {
  assertAnyPermission(actor, ["purchasing.view", "suppliers.manage"]);

  const rows = await executor
    .select({
      id: supplierItems.id,
      supplierId: supplierItems.supplierId,
      supplierName: suppliers.name,
      inventoryItemId: supplierItems.inventoryItemId,
      inventoryItemName: inventoryItems.name,
      supplierSku: supplierItems.supplierSku,
      purchaseUnitId: supplierItems.purchaseUnitId,
      purchaseUnitCode: unitsOfMeasure.code,
      baseUnitsPerPurchase: supplierItems.baseUnitsPerPurchase,
      lastUnitCost: supplierItems.lastUnitCost,
      active: supplierItems.active,
      version: supplierItems.version,
    })
    .from(supplierItems)
    .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
    .innerJoin(inventoryItems, eq(inventoryItems.id, supplierItems.inventoryItemId))
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, supplierItems.purchaseUnitId))
    .where(
      and(
        eq(supplierItems.organizationId, actor.organizationId),
        filter.supplierId ? eq(supplierItems.supplierId, filter.supplierId) : undefined,
        filter.inventoryItemId ? eq(supplierItems.inventoryItemId, filter.inventoryItemId) : undefined,
      ),
    )
    .orderBy(asc(suppliers.name), asc(inventoryItems.name));
  const showCost = canSeeCost(actor);

  return rows.map((row) => ({ ...row, lastUnitCost: showCost ? row.lastUnitCost : null }));
}

/**
 * Says how a supplier sells an item. The base quantity of one purchase unit is computed
 * from the item's conversions now, and refused if the unit can't be converted.
 */
export async function createSupplierItem(
  database: Database,
  actor: Actor,
  supplierId: string,
  input: {
    inventoryItemId: string;
    purchaseUnitId: string;
    supplierSku: string | null;
    lastUnitCost: string | null;
  },
) {
  assertPermission(actor, "suppliers.manage");

  const lastUnitCost = normalizeCost(input.lastUnitCost);

  try {
    return await withTransaction(database, async (transaction) => {
      await requireSupplier(transaction, actor, supplierId);

      const item = await requireItemFacts(transaction, actor.organizationId, input.inventoryItemId);
      const baseUnitsPerPurchase = await convertItemQuantity(
        transaction,
        item,
        "1",
        input.purchaseUnitId,
      );
      const [row] = await transaction
        .insert(supplierItems)
        .values({
          organizationId: actor.organizationId,
          supplierId,
          inventoryItemId: item.id,
          purchaseUnitId: input.purchaseUnitId,
          supplierSku: input.supplierSku,
          baseUnitsPerPurchase,
          lastUnitCost,
        })
        .returning();

      if (lastUnitCost !== null) {
        await transaction.insert(supplierItemCostHistory).values({
          supplierItemId: row!.id,
          unitCost: lastUnitCost,
          source: "MANUAL",
          recordedByUserId: actor.userId,
        });
      }

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        "SUPPLIER_ITEM_EXISTS",
        "This supplier already sells that item in that unit.",
      );
    }

    throw error;
  }
}

/**
 * Changes a supplier item's SKU, listed cost or active state. A new cost is appended to the
 * cost history; purchase orders already placed keep their own snapshot.
 */
export async function updateSupplierItem(
  database: Database,
  actor: Actor,
  supplierItemId: string,
  input: {
    supplierSku: string | null;
    lastUnitCost: string | null;
    active: boolean;
    expectedVersion: number;
  },
) {
  assertPermission(actor, "suppliers.manage");

  const lastUnitCost = normalizeCost(input.lastUnitCost);

  return withTransaction(database, async (transaction) => {
    const [existing] = await transaction
      .select({ lastUnitCost: supplierItems.lastUnitCost })
      .from(supplierItems)
      .where(
        and(
          eq(supplierItems.id, supplierItemId),
          eq(supplierItems.organizationId, actor.organizationId),
        ),
      );

    if (!existing) {
      throw new NotFoundError("supplier item");
    }

    const updated = await updateVersioned(transaction, supplierItems, {
      id: supplierItemId,
      organizationId: actor.organizationId,
      expectedVersion: input.expectedVersion,
      values: { supplierSku: input.supplierSku, lastUnitCost, active: input.active },
      label: "supplier item",
    });

    if (lastUnitCost !== null && lastUnitCost !== existing.lastUnitCost) {
      await transaction.insert(supplierItemCostHistory).values({
        supplierItemId,
        unitCost: lastUnitCost,
        source: "MANUAL",
        recordedByUserId: actor.userId,
      });
    }

    return updated;
  });
}

/** Every price recorded for a supplier item, newest first. Needs cost access. */
export async function listSupplierItemCostHistory(
  executor: DatabaseExecutor,
  actor: Actor,
  supplierItemId: string,
) {
  assertPermission(actor, "inventory.cost.view");

  const [owned] = await executor
    .select({ id: supplierItems.id })
    .from(supplierItems)
    .where(
      and(
        eq(supplierItems.id, supplierItemId),
        eq(supplierItems.organizationId, actor.organizationId),
      ),
    );

  if (!owned) {
    throw new NotFoundError("supplier item");
  }

  return executor
    .select()
    .from(supplierItemCostHistory)
    .where(eq(supplierItemCostHistory.supplierItemId, supplierItemId))
    .orderBy(desc(supplierItemCostHistory.recordedAt));
}
