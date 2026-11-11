import { and, asc, eq } from "drizzle-orm";

import type { Database } from "@/db";
import { isUniqueViolation } from "@/db/helpers/database-errors";
import { updateVersioned } from "@/db/helpers/versioned-update";
import { nextVersion } from "@/db/helpers/versioning";
import {
  inventoryItemLocations,
  inventoryItems,
  inventoryItemUnitConversions,
  inventoryTransactions,
  locations,
  supplierItems,
  suppliers,
  unitsOfMeasure,
} from "@/db/schema";
import { withTransaction, type DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";
import { toScale } from "@/shared/decimal/decimal";
import { BusinessRuleError, ConflictError, NotFoundError } from "@/shared/errors/app-error";
import { ConcurrencyError } from "@/shared/errors/concurrency-error";

import { requireItemFacts } from "../repositories/conversion-repository";
import { assertThresholds } from "../rules/replenishment";
import { validateProductConversion } from "../rules/unit-resolution";
import { assertAnyPermission, assertPermission } from "./access";

type ItemInput = {
  name: string;
  description: string | null;
  measurementType: "COUNT" | "WEIGHT" | "VOLUME";
  baseUnitId: string;
};

async function requireUnitOfType(
  executor: DatabaseExecutor,
  unitId: string,
  measurementType: string,
) {
  const [unit] = await executor
    .select({ measurementType: unitsOfMeasure.measurementType, active: unitsOfMeasure.active })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.id, unitId));

  if (!unit) {
    throw new NotFoundError("unit of measure");
  }

  if (unit.measurementType !== measurementType) {
    throw new BusinessRuleError(
      "INCOMPATIBLE_BASE_UNIT",
      "The stock unit must match the item's measurement type.",
    );
  }
}

export async function listItems(executor: DatabaseExecutor, actor: Actor) {
  assertAnyPermission(actor, ["inventory.view", "inventory.configure"]);

  return executor
    .select({
      id: inventoryItems.id,
      code: inventoryItems.code,
      name: inventoryItems.name,
      description: inventoryItems.description,
      measurementType: inventoryItems.measurementType,
      baseUnitId: inventoryItems.baseUnitId,
      baseUnitCode: unitsOfMeasure.code,
      active: inventoryItems.active,
      version: inventoryItems.version,
    })
    .from(inventoryItems)
    .innerJoin(unitsOfMeasure, eq(unitsOfMeasure.id, inventoryItems.baseUnitId))
    .where(eq(inventoryItems.organizationId, actor.organizationId))
    .orderBy(asc(inventoryItems.name));
}

export async function createItem(
  database: Database,
  actor: Actor,
  input: ItemInput & { code: string },
) {
  assertPermission(actor, "inventory.configure");

  try {
    return await withTransaction(database, async (transaction) => {
      await requireUnitOfType(transaction, input.baseUnitId, input.measurementType);

      const [row] = await transaction
        .insert(inventoryItems)
        .values({ ...input, organizationId: actor.organizationId })
        .returning();

      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError("CODE_TAKEN", "Another inventory item already uses that code.");
    }

    throw error;
  }
}

/**
 * The stock unit and measurement type fix how every ledger row was counted, so they can't
 * change once the item has stock history anywhere.
 */
export async function updateItem(
  database: Database,
  actor: Actor,
  itemId: string,
  input: ItemInput & { active: boolean; expectedVersion: number },
) {
  assertPermission(actor, "inventory.configure");

  return withTransaction(database, async (transaction) => {
    const current = await requireItemFacts(transaction, actor.organizationId, itemId);

    if (
      current.baseUnitId !== input.baseUnitId ||
      current.measurementType !== input.measurementType
    ) {
      const [history] = await transaction
        .select({ id: inventoryTransactions.id })
        .from(inventoryTransactions)
        .where(eq(inventoryTransactions.inventoryItemId, itemId))
        .limit(1);

      if (history) {
        throw new BusinessRuleError(
          "BASE_UNIT_LOCKED",
          "This item has stock history, so its stock unit can't change.",
        );
      }

      await requireUnitOfType(transaction, input.baseUnitId, input.measurementType);
    }

    const { expectedVersion, ...values } = input;

    return updateVersioned(transaction, inventoryItems, {
      id: itemId,
      organizationId: actor.organizationId,
      expectedVersion,
      values,
      label: "inventory item",
    });
  });
}

/** Item detail for configuration: identity, conversions, and its levels at each location. */
export async function getItemConfiguration(
  executor: DatabaseExecutor,
  actor: Actor,
  itemId: string,
) {
  assertAnyPermission(actor, ["inventory.view", "inventory.configure"]);

  const item = await requireItemFacts(executor, actor.organizationId, itemId);
  const [record] = await executor.select().from(inventoryItems).where(eq(inventoryItems.id, itemId));
  const conversions = await executor
    .select()
    .from(inventoryItemUnitConversions)
    .where(eq(inventoryItemUnitConversions.inventoryItemId, itemId))
    .orderBy(asc(inventoryItemUnitConversions.createdAt));
  const levels = await executor
    .select({
      configuration: inventoryItemLocations,
      locationName: locations.name,
    })
    .from(inventoryItemLocations)
    .innerJoin(locations, eq(locations.id, inventoryItemLocations.locationId))
    .where(eq(inventoryItemLocations.inventoryItemId, itemId));

  return {
    item: { ...item, description: record!.description, version: record!.version },
    conversions,
    locations: levels.map((row) => ({ ...row.configuration, locationName: row.locationName })),
  };
}

type LevelInput = {
  parLevel: string | null;
  reorderLevel: string | null;
  reorderTarget: string | null;
  storageNote: string | null;
  active: boolean;
  /** Phase 19 (D8). Undefined leaves it as it is; null clears it. */
  preferredSupplierItemId?: string | null;
};

/** The preferred supplier item must sell this item, in this organization, and be active. */
async function assertPreferredSupplierItem(
  executor: DatabaseExecutor,
  actor: Actor,
  itemId: string,
  supplierItemId: string,
) {
  const [row] = await executor
    .select({ active: supplierItems.active, supplierActive: suppliers.active })
    .from(supplierItems)
    .innerJoin(suppliers, eq(suppliers.id, supplierItems.supplierId))
    .where(
      and(
        eq(supplierItems.id, supplierItemId),
        eq(supplierItems.inventoryItemId, itemId),
        eq(supplierItems.organizationId, actor.organizationId),
      ),
    );

  if (!row) {
    throw new NotFoundError("supplier item");
  }

  if (!row.active || !row.supplierActive) {
    throw new BusinessRuleError("SUPPLIER_ITEM_INACTIVE", "That supplier item is inactive.");
  }
}

const normalizeLevel = (value: string | null) => {
  if (value === null) {
    return null;
  }

  try {
    return toScale(value, 4);
  } catch {
    throw new BusinessRuleError(
      "INVALID_THRESHOLD",
      "Levels are numbers with at most four decimal places.",
    );
  }
};

/**
 * Stocks an item at the actor's location (or changes its levels there). Levels are in the
 * item's base unit. `expectedVersion` is required to change an existing configuration.
 */
export async function setItemLocation(
  database: Database,
  actor: Actor,
  itemId: string,
  input: LevelInput & { expectedVersion: number | null },
) {
  assertPermission(actor, "inventory.configure");

  const levels = {
    parLevel: normalizeLevel(input.parLevel),
    reorderLevel: normalizeLevel(input.reorderLevel),
    reorderTarget: normalizeLevel(input.reorderTarget),
  };

  assertThresholds(levels);

  return withTransaction(database, async (transaction) => {
    await requireItemFacts(transaction, actor.organizationId, itemId);

    if (input.preferredSupplierItemId) {
      await assertPreferredSupplierItem(transaction, actor, itemId, input.preferredSupplierItemId);
    }

    const preferred =
      input.preferredSupplierItemId === undefined ? {} : { preferredSupplierItemId: input.preferredSupplierItemId };
    const [existing] = await transaction
      .select()
      .from(inventoryItemLocations)
      .where(
        and(
          eq(inventoryItemLocations.inventoryItemId, itemId),
          eq(inventoryItemLocations.locationId, actor.locationId),
        ),
      );

    if (!existing) {
      const [row] = await transaction
        .insert(inventoryItemLocations)
        .values({
          ...levels,
          ...preferred,
          storageNote: input.storageNote,
          active: input.active,
          organizationId: actor.organizationId,
          inventoryItemId: itemId,
          locationId: actor.locationId,
        })
        .returning();

      return row!;
    }

    if (input.expectedVersion === null) {
      throw new ConcurrencyError("stock configuration", existing.id);
    }

    return updateVersioned(transaction, inventoryItemLocations, {
      id: existing.id,
      organizationId: actor.organizationId,
      expectedVersion: input.expectedVersion,
      values: { ...levels, ...preferred, storageNote: input.storageNote, active: input.active },
      label: "stock configuration",
    });
  });
}

type ConversionInput = { fromUnitId: string; toUnitId: string; factor: string };

async function activeConversions(executor: DatabaseExecutor, itemId: string) {
  return executor
    .select()
    .from(inventoryItemUnitConversions)
    .where(
      and(
        eq(inventoryItemUnitConversions.inventoryItemId, itemId),
        eq(inventoryItemUnitConversions.active, true),
      ),
    );
}

/** Adds a packaging conversion for one item, refusing ambiguity and cycles. */
export async function addConversion(
  database: Database,
  actor: Actor,
  itemId: string,
  input: ConversionInput,
) {
  assertPermission(actor, "inventory.configure");

  return withTransaction(database, async (transaction) => {
    // Lock the item so two editors can't add conflicting conversions at once.
    await transaction
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(
        and(eq(inventoryItems.id, itemId), eq(inventoryItems.organizationId, actor.organizationId)),
      )
      .for("update");
    await requireItemFacts(transaction, actor.organizationId, itemId);

    for (const unitId of [input.fromUnitId, input.toUnitId]) {
      const [unit] = await transaction
        .select({ id: unitsOfMeasure.id })
        .from(unitsOfMeasure)
        .where(eq(unitsOfMeasure.id, unitId));

      if (!unit) {
        throw new NotFoundError("unit of measure");
      }
    }

    validateProductConversion(await activeConversions(transaction, itemId), input);

    try {
      const [row] = await transaction
        .insert(inventoryItemUnitConversions)
        .values({ ...input, factor: toScale(input.factor, 6), inventoryItemId: itemId })
        .returning();

      return row!;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          "AMBIGUOUS_CONVERSION",
          "This item already converts from that unit.",
        );
      }

      throw error;
    }
  });
}

/**
 * Deactivates a conversion. Its history isn't needed for the ledger, which stores base
 * quantities, but the row is kept so a past configuration can be explained.
 */
export async function deactivateConversion(
  database: Database,
  actor: Actor,
  itemId: string,
  conversionId: string,
  expectedVersion: number,
) {
  assertPermission(actor, "inventory.configure");

  return withTransaction(database, async (transaction) => {
    await requireItemFacts(transaction, actor.organizationId, itemId);

    const rows = await transaction
      .update(inventoryItemUnitConversions)
      .set({
        active: false,
        version: nextVersion(inventoryItemUnitConversions.version),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(inventoryItemUnitConversions.id, conversionId),
          eq(inventoryItemUnitConversions.inventoryItemId, itemId),
          eq(inventoryItemUnitConversions.version, expectedVersion),
        ),
      )
      .returning();

    if (!rows[0]) {
      throw new ConcurrencyError("unit conversion", conversionId);
    }

    return rows[0];
  });
}


/** Units offered when entering quantities. Which ones convert depends on the item. */
export async function listUnitChoices(executor: DatabaseExecutor, actor: Actor) {
  assertAnyPermission(actor, ["inventory.view", "inventory.configure", "purchasing.view", "suppliers.manage"]);

  return executor
    .select({
      id: unitsOfMeasure.id,
      code: unitsOfMeasure.code,
      name: unitsOfMeasure.name,
      measurementType: unitsOfMeasure.measurementType,
    })
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.active, true))
    .orderBy(asc(unitsOfMeasure.measurementType), asc(unitsOfMeasure.code));
}
