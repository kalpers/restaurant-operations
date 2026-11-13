import { sql } from "drizzle-orm";

import { getDemandHistory } from "@/modules/orders/queries/demand-history";
import { DEMAND_MEASURES, hourLabel, MEASURE_LABELS, type DemandMeasure } from "@/modules/scheduling/rules/demand-forecast";
import {
  addDecimals,
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  subtractDecimals,
  toScale,
} from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";

import type { ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

// Phase 24 policy 16 (D8): forecast vs actual. Reads the stored forecast that was used for
// each past business date (the latest one) and the closed checks of that date. Nothing is
// recomputed from current ratios or settings.

const ACTUAL_KEY: Record<DemandMeasure, "diningCovers" | "barChecks" | "takeoutChecks" | "allChecks"> = {
  DINING_COVERS: "diningCovers",
  BAR_CHECKS: "barChecks",
  TAKEOUT_CHECKS: "takeoutChecks",
  ALL_CHECKS: "allChecks",
};

type Peak = { hour: number; value: string } | null;

function higher(peak: Peak, hour: number, value: string): Peak {
  if (compareDecimals(value, "0") <= 0) {
    return peak;
  }

  if (!peak || compareDecimals(value, peak.value) > 0 || (compareDecimals(value, peak.value) === 0 && hour < peak.hour)) {
    return { hour, value };
  }

  return peak;
}

export async function forecastAccuracySection(context: ReportContext, now = new Date()): Promise<ReportSection> {
  const { filters, settings } = context;
  const today = businessDateOf(now, settings);
  const stored = await rowsOf<{
    business_date: string;
    hour: number | null;
    measure: string | null;
    forecast_value: string | null;
  }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (fd.business_date) fd.business_date, fd.demand_forecast_id
        FROM demand_forecast_dates fd
        JOIN demand_forecasts f ON f.id = fd.demand_forecast_id
        WHERE f.location_id = ${filters.locationId}
          AND fd.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND fd.business_date < ${today}::date
          AND fd.status <> 'NOT_ENOUGH_HISTORY'
        ORDER BY fd.business_date, f.created_at DESC, f.id DESC
      )
      SELECT l.business_date::text AS business_date, h.hour, h.measure, h.forecast_value::text AS forecast_value
      FROM latest l
      LEFT JOIN demand_forecast_hours h
        ON h.demand_forecast_id = l.demand_forecast_id AND h.business_date = l.business_date
      ORDER BY l.business_date, h.hour
    `,
  );
  const dates = [...new Set(stored.map((row) => row.business_date))];
  const history =
    dates.length > 0
      ? await getDemandHistory(context.tx, {
          locationId: filters.locationId,
          timeZone: settings.timeZone,
          fromDate: dates[0]!,
          toDate: dates[dates.length - 1]!,
        })
      : { hours: [], openDates: [] };
  const rows = [];

  for (const date of dates) {
    for (const measure of DEMAND_MEASURES) {
      let forecastTotal = "0";
      let forecastPeak: Peak = null;

      for (const row of stored) {
        if (row.business_date === date && row.measure === measure && row.forecast_value !== null && row.hour !== null) {
          forecastTotal = addDecimals(forecastTotal, row.forecast_value);
          forecastPeak = higher(forecastPeak, row.hour, row.forecast_value);
        }
      }

      let actualTotal = 0;
      let actualPeak: Peak = null;

      for (const hour of history.hours) {
        if (hour.businessDate === date) {
          const value = hour[ACTUAL_KEY[measure]];

          actualTotal += value;
          actualPeak = higher(actualPeak, hour.hour, String(value));
        }
      }

      const forecast = toScale(forecastTotal, 2);
      const actual = toScale(String(actualTotal), 2);
      const difference = subtractDecimals(actual, forecast);

      rows.push({
        businessDate: date,
        measure: MEASURE_LABELS[measure].name,
        forecast,
        actual,
        difference: toScale(difference, 2),
        differencePercent:
          compareDecimals(forecast, "0") > 0
            ? divideRoundHalfUp(multiplyExact(difference, "100"), forecast, 1)
            : null,
        forecastBusiest: forecastPeak ? hourLabel(forecastPeak.hour) : null,
        actualBusiest: actualPeak ? hourLabel(actualPeak.hour) : null,
      });
    }
  }

  return {
    key: "forecastAccuracy",
    title: "Forecast vs actual",
    description:
      "For past business dates with a stored forecast (the latest one a manager used): the forecast and the closed checks, per day. A positive difference means busier than forecast.",
    columns: [
      { key: "businessDate", label: "Business date", kind: "date" },
      { key: "measure", label: "Demand", kind: "text" },
      { key: "forecast", label: "Forecast", kind: "quantity" },
      { key: "actual", label: "Actual", kind: "quantity" },
      { key: "difference", label: "Difference", kind: "quantity" },
      { key: "differencePercent", label: "Difference %", kind: "percent" },
      { key: "forecastBusiest", label: "Forecast busiest hour", kind: "text" },
      { key: "actualBusiest", label: "Actual busiest hour", kind: "text" },
    ],
    rows,
  };
}
