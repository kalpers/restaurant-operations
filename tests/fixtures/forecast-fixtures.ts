import { inArray } from "drizzle-orm";

import type { Database } from "@/db";
import {
  demandExcludedDates,
  demandForecastDates,
  demandForecastHours,
  demandForecasts,
  shifts,
  staffingRatios,
} from "@/db/schema";
const SNAPSHOT_TABLES = ["demand_forecast_hours", "demand_forecast_dates", "demand_forecasts"] as const;

/**
 * Phase 24: stored forecasts are append-only, so cleanup turns the guard off for its own
 * transaction only. With `periodIds`, only those periods' forecasts go; otherwise all.
 * Ratios and excluded dates go too when clearing everything.
 */
export async function clearDemandForecasts(
  database: Database,
  periodIds?: readonly string[],
): Promise<void> {
  if (periodIds && periodIds.length === 0) {
    return;
  }

  await database.transaction(async (transaction) => {
    for (const table of SNAPSHOT_TABLES) {
      await transaction.execute(`ALTER TABLE ${table} DISABLE TRIGGER ${table}_append_only_trigger` as never);
    }

    const forecastIds = periodIds
      ? (
          await transaction
            .select({ id: demandForecasts.id })
            .from(demandForecasts)
            .where(inArray(demandForecasts.schedulePeriodId, [...periodIds]))
        ).map((row) => row.id)
      : null;

    if (forecastIds === null) {
      await transaction.update(shifts).set({
        demandForecastId: null,
        forecastSuggestedCount: null,
        templateEmployeeCount: null,
      });
      await transaction.delete(demandForecastHours);
      await transaction.delete(demandForecastDates);
      await transaction.delete(demandForecasts);
      await transaction.delete(staffingRatios);
      await transaction.delete(demandExcludedDates);
    } else if (forecastIds.length > 0) {
      await transaction
        .update(shifts)
        .set({ demandForecastId: null, forecastSuggestedCount: null, templateEmployeeCount: null })
        .where(inArray(shifts.demandForecastId, forecastIds));
      await transaction.delete(demandForecastHours).where(inArray(demandForecastHours.demandForecastId, forecastIds));
      await transaction.delete(demandForecastDates).where(inArray(demandForecastDates.demandForecastId, forecastIds));
      await transaction.delete(demandForecasts).where(inArray(demandForecasts.id, forecastIds));
    }

    for (const table of SNAPSHOT_TABLES) {
      await transaction.execute(`ALTER TABLE ${table} ENABLE TRIGGER ${table}_append_only_trigger` as never);
    }
  });
}
