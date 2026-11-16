import type { DatabaseExecutor } from "@/db/transactions/transaction-context";
import { NotFoundError } from "@/shared/errors/app-error";
import type { BusinessDateSettings } from "@/shared/time/business-date-service";

import { findRulesRow } from "../repositories/config-repository";
import { findExcludedDates, findLocationClockSettings } from "../repositories/forecast-repository";
import { DEFAULT_RULE_ROW } from "../rules/schedule-rules";

/**
 * Phase 25 policy 3 (D1): the location's forecast settings that Scheduling owns (Phase 24
 * policies 5-6), for the item forecast: its clock, look-back weeks, minimum samples and active
 * excluded dates. Read-only; no permission check (callers check their own).
 */
export async function readForecastInputs(
  executor: DatabaseExecutor,
  locationId: string,
): Promise<{
  clock: BusinessDateSettings;
  settings: { lookbackWeeks: number; minimumSamples: number };
  excludedDates: string[];
}> {
  const [clock, rules, excluded] = await Promise.all([
    findLocationClockSettings(executor, locationId),
    findRulesRow(executor, locationId),
    findExcludedDates(executor, locationId),
  ]);

  if (!clock) {
    throw new NotFoundError("location");
  }

  const row = rules ?? DEFAULT_RULE_ROW;

  return {
    clock,
    settings: { lookbackWeeks: row.forecastLookbackWeeks, minimumSamples: row.forecastMinimumSamples },
    excludedDates: excluded.map((entry) => entry.excludedDate).sort(),
  };
}
