import { and, eq } from "drizzle-orm";

import { inventoryItems, inventoryItemUnitConversions, unitConversions, unitsOfMeasure } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { NotFoundError } from "@/shared/errors/app-error";

import { toBaseQuantity, type ConversionContext } from "../rules/unit-resolution";

export async function loadConversionContext(
  executor: DatabaseExecutor,
  inventoryItemId: string,
): Promise<ConversionContext> {
  const [units, generic, product] = await Promise.all([
    executor
      .select({
        id: unitsOfMeasure.id,
        code: unitsOfMeasure.code,
        measurementType: unitsOfMeasure.measurementType,
      })
      .from(unitsOfMeasure),
    executor
      .select({
        fromUnitId: unitConversions.fromUnitId,
        toUnitId: unitConversions.toUnitId,
        factor: unitConversions.factor,
      })
      .from(unitConversions)
      .where(eq(unitConversions.active, true)),
    executor
      .select({
        id: inventoryItemUnitConversions.id,
        fromUnitId: inventoryItemUnitConversions.fromUnitId,
        toUnitId: inventoryItemUnitConversions.toUnitId,
        factor: inventoryItemUnitConversions.factor,
      })
      .from(inventoryItemUnitConversions)
      .where(
        and(
          eq(inventoryItemUnitConversions.inventoryItemId, inventoryItemId),
          eq(inventoryItemUnitConversions.active, true),
        ),
      ),
  ]);

  return { units, generic, product };
}

export type ItemFacts = {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  measurementType: string;
  baseUnitId: string;
  active: boolean;
};

export async function findItemFacts(
  executor: DatabaseExecutor,
  organizationId: string,
  inventoryItemId: string,
): Promise<ItemFacts | null> {
  const [item] = await executor
    .select({
      id: inventoryItems.id,
      organizationId: inventoryItems.organizationId,
      code: inventoryItems.code,
      name: inventoryItems.name,
      measurementType: inventoryItems.measurementType,
      baseUnitId: inventoryItems.baseUnitId,
      active: inventoryItems.active,
    })
    .from(inventoryItems)
    .where(
      and(eq(inventoryItems.id, inventoryItemId), eq(inventoryItems.organizationId, organizationId)),
    );

  return item ?? null;
}

export async function requireItemFacts(
  executor: DatabaseExecutor,
  organizationId: string,
  inventoryItemId: string,
): Promise<ItemFacts> {
  const item = await findItemFacts(executor, organizationId, inventoryItemId);

  if (!item) {
    throw new NotFoundError("inventory item");
  }

  return item;
}

/** A quantity of an item in any convertible unit, expressed in its base unit. */
export async function convertItemQuantity(
  executor: DatabaseExecutor,
  item: { id: string; baseUnitId: string },
  quantity: string,
  unitId: string,
): Promise<string> {
  const context = await loadConversionContext(executor, item.id);

  return toBaseQuantity(context, quantity, unitId, item.baseUnitId);
}
