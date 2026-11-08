import { asc, eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { unitConversions, unitsOfMeasure } from "@/db/schema";
import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import type { Actor } from "@/modules/auth/types";

import {
  convertQuantity,
  type ConversionDefinition,
  type MeasurementType,
  type UnitDefinition,
} from "../rules/unit-conversion";
import { assertPermission } from "./access";

export async function listUnits(executor: DatabaseExecutor, actor: Actor) {
  assertPermission(actor, "recipes.view");

  return executor
    .select()
    .from(unitsOfMeasure)
    .where(eq(unitsOfMeasure.active, true))
    .orderBy(asc(unitsOfMeasure.measurementType), asc(unitsOfMeasure.code));
}

/** The vocabulary and approved conversions, in the shape the pure rules take. */
export async function loadUnitRules(
  executor: DatabaseExecutor,
): Promise<{ units: UnitDefinition[]; conversions: ConversionDefinition[] }> {
  const units = await executor
    .select({ code: unitsOfMeasure.code, measurementType: unitsOfMeasure.measurementType })
    .from(unitsOfMeasure);
  const from = alias(unitsOfMeasure, "from_unit");
  const to = alias(unitsOfMeasure, "to_unit");
  const conversions = await executor
    .select({ from: from.code, to: to.code, factor: unitConversions.factor })
    .from(unitConversions)
    .innerJoin(from, eq(from.id, unitConversions.fromUnitId))
    .innerJoin(to, eq(to.id, unitConversions.toUnitId))
    .where(eq(unitConversions.active, true));

  return {
    units: units.map((unit) => ({
      code: unit.code,
      measurementType: unit.measurementType as MeasurementType,
    })),
    conversions,
  };
}

/** Converts using only approved, same-measurement-type conversions. */
export async function convertUnits(
  executor: DatabaseExecutor,
  actor: Actor,
  input: { quantity: string; fromUnit: string; toUnit: string },
): Promise<string> {
  assertPermission(actor, "recipes.view");

  const { units, conversions } = await loadUnitRules(executor);

  return convertQuantity(input.quantity, input.fromUnit, input.toUnit, units, conversions);
}
