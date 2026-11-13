import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { nextVersion } from "@/db/helpers/versioning";
import {
  demandExcludedDates,
  demandForecastDates,
  demandForecastHours,
  demandForecasts,
  locationSettings,
  locations,
  positions,
  staffingRatios,
} from "@/db/schema";
import type {
  DatabaseExecutor,
  DatabaseTransaction,
} from "@/db/transactions/transaction-context";

// Phase 24 forecast storage: staffing ratios, excluded dates and stored forecasts.

/** The location's time zone and business-day cutoff (for `BusinessDateService`). */
export async function findLocationClockSettings(executor: DatabaseExecutor, locationId: string) {
  const [row] = await executor
    .select({
      timeZone: locations.timezone,
      businessDayCutoff: locationSettings.businessDayCutoff,
    })
    .from(locations)
    .innerJoin(locationSettings, eq(locationSettings.locationId, locations.id))
    .where(eq(locations.id, locationId));

  return row;
}

export function findRatios(executor: DatabaseExecutor, locationId: string, activeOnly = false) {
  return executor
    .select({
      id: staffingRatios.id,
      positionId: staffingRatios.positionId,
      positionName: positions.name,
      measure: staffingRatios.measure,
      unitsPerEmployeeHour: staffingRatios.unitsPerEmployeeHour,
      minimumEmployees: staffingRatios.minimumEmployees,
      maximumEmployees: staffingRatios.maximumEmployees,
      active: staffingRatios.active,
      version: staffingRatios.version,
    })
    .from(staffingRatios)
    .innerJoin(positions, eq(positions.id, staffingRatios.positionId))
    .where(
      activeOnly
        ? and(eq(staffingRatios.locationId, locationId), eq(staffingRatios.active, true))
        : eq(staffingRatios.locationId, locationId),
    )
    .orderBy(desc(staffingRatios.active), asc(positions.name), asc(staffingRatios.id));
}

export type RatioRow = Awaited<ReturnType<typeof findRatios>>[number];

export async function findRatio(executor: DatabaseExecutor, ratioId: string, locationId: string) {
  const [row] = await executor
    .select()
    .from(staffingRatios)
    .where(and(eq(staffingRatios.id, ratioId), eq(staffingRatios.locationId, locationId)));

  return row;
}

export async function insertRatio(
  executor: DatabaseExecutor,
  values: typeof staffingRatios.$inferInsert,
) {
  const [row] = await executor.insert(staffingRatios).values(values).returning();

  return row!;
}

export async function updateRatioRow(
  executor: DatabaseExecutor,
  input: { id: string; locationId: string; expectedVersion: number },
  changes: Partial<typeof staffingRatios.$inferInsert>,
) {
  return executor
    .update(staffingRatios)
    .set({ ...changes, updatedAt: new Date(), version: nextVersion(staffingRatios.version) })
    .where(
      and(
        eq(staffingRatios.id, input.id),
        eq(staffingRatios.locationId, input.locationId),
        eq(staffingRatios.version, input.expectedVersion),
      ),
    )
    .returning();
}

export function findExcludedDates(executor: DatabaseExecutor, locationId: string) {
  return executor
    .select({
      id: demandExcludedDates.id,
      excludedDate: demandExcludedDates.excludedDate,
      reason: demandExcludedDates.reason,
      createdAt: demandExcludedDates.createdAt,
    })
    .from(demandExcludedDates)
    .where(and(eq(demandExcludedDates.locationId, locationId), eq(demandExcludedDates.active, true)))
    .orderBy(desc(demandExcludedDates.excludedDate));
}

export async function insertExcludedDate(
  executor: DatabaseExecutor,
  values: typeof demandExcludedDates.$inferInsert,
) {
  const [row] = await executor.insert(demandExcludedDates).values(values).returning();

  return row!;
}

export async function deactivateExcludedDateRow(
  executor: DatabaseExecutor,
  input: { id: string; locationId: string; userId: string },
) {
  const now = new Date();

  return executor
    .update(demandExcludedDates)
    .set({ active: false, deactivatedAt: now, deactivatedByUserId: input.userId, updatedAt: now })
    .where(
      and(
        eq(demandExcludedDates.id, input.id),
        eq(demandExcludedDates.locationId, input.locationId),
        eq(demandExcludedDates.active, true),
      ),
    )
    .returning();
}

export type StoredForecastInput = {
  forecast: typeof demandForecasts.$inferInsert;
  dates: Omit<typeof demandForecastDates.$inferInsert, "demandForecastId">[];
  hours: Omit<typeof demandForecastHours.$inferInsert, "demandForecastId">[];
};

/** Policy 11: writes one stored forecast, its dates and hours. Never updated afterwards. */
export async function insertStoredForecast(
  transaction: DatabaseTransaction,
  input: StoredForecastInput,
): Promise<string> {
  const [row] = await transaction
    .insert(demandForecasts)
    .values(input.forecast)
    .returning({ id: demandForecasts.id });
  const demandForecastId = row!.id;

  if (input.dates.length > 0) {
    await transaction
      .insert(demandForecastDates)
      .values(input.dates.map((date) => ({ ...date, demandForecastId })));
  }

  // Inserted in chunks to stay well inside PostgreSQL's parameter limit.
  for (let index = 0; index < input.hours.length; index += 1000) {
    await transaction
      .insert(demandForecastHours)
      .values(input.hours.slice(index, index + 1000).map((hour) => ({ ...hour, demandForecastId })));
  }

  return demandForecastId;
}

export function findStoredForecastDates(executor: DatabaseExecutor, forecastIds: readonly string[]) {
  if (forecastIds.length === 0) {
    return Promise.resolve([]);
  }

  return executor
    .select()
    .from(demandForecastDates)
    .where(inArray(demandForecastDates.demandForecastId, [...forecastIds]));
}
