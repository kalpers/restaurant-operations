import { sql } from "drizzle-orm";

import { getDemandHistory } from "@/modules/orders/queries/demand-history";
import { hourLabel, NET_SALES_MEASURE } from "@/modules/scheduling/rules/demand-forecast";
import { buildForecastContext } from "@/modules/scheduling/services/forecast-service";
import {
  addDecimals,
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  subtractDecimals,
  toScale,
} from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";

import type { ReportSection } from "../types";
import { rowsOf, type ReportContext } from "./report-context";

// Phase 28 sales forecast (policies 6 and 7), in the Sales area, so only `reports.sales`
// holders see money. The forecast ahead is worked out on read by the Phase 24 method (same
// samples, look-back, minimum and excluded dates) and stored nowhere. "Forecast vs actual"
// reads only the NET_SALES rows stored with a demand forecast that was used, and the CLOSED
// checks of the date; nothing is recomputed from today's settings.

export const SALES_FORECAST_DAYS = 14;

type Peak = { hour: number; value: string } | null;

function higher(peak: Peak, hour: number, value: string): Peak {
  if (compareDecimals(value, "0") <= 0) {
    return peak;
  }

  if (!peak || compareDecimals(value, peak.value) > 0) {
    return { hour, value };
  }

  return peak;
}

const STATUS_LABEL: Record<string, string> = {
  OK: "Forecast",
  NOT_ENOUGH_HISTORY: "Not enough history",
  BOOKINGS_ONLY: "Not enough history",
};

/** The next 14 business dates: daily totals, then the hours with expected sales. */
export async function salesForecastSections(context: ReportContext, now = new Date()): Promise<ReportSection[]> {
  const today = businessDateOf(now, context.settings);
  const forecastContext = await buildForecastContext(
    context.tx,
    { locationId: context.filters.locationId },
    { startDate: today, endDate: addDays(today, SALES_FORECAST_DAYS - 1) },
    now,
  );
  const cutoffHour = Number(context.settings.businessDayCutoff.slice(0, 2));
  const hourOrder = Array.from({ length: 24 }, (_, index) => (cutoffHour + index) % 24);
  const daily = [];
  const hourly = [];

  for (const date of forecastContext.dates.slice(0, SALES_FORECAST_DAYS)) {
    const forecast = forecastContext.forecasts.get(date)!;
    const enough = forecast.status === "OK";
    let total = "0.00";
    let peak: Peak = null;

    for (const hour of hourOrder) {
      const value = forecast.netSales.find((entry) => entry.hour === hour)?.historyValue ?? null;

      if (value === null) {
        continue;
      }

      total = addDecimals(total, value);
      peak = higher(peak, hour, value);

      if (compareDecimals(value, "0") > 0) {
        hourly.push({ businessDate: date, hour: hourLabel(hour), forecast: value });
      }
    }

    daily.push({
      businessDate: date,
      status: STATUS_LABEL[forecast.status] ?? forecast.status,
      samples: forecast.sampleDates.length,
      forecast: enough ? toScale(total, 2) : null,
      busiest: enough && peak ? hourLabel(peak.hour) : null,
    });
  }

  return [
    {
      key: "salesForecast",
      title: "Sales forecast (next 14 days)",
      description:
        "Expected net sales per business date: a weighted average of the same weekday's closed checks over recent weeks (newest highest), with the scheduling forecast settings and excluded dates. Worked out when opened; not affected by the date range above.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "status", label: "Status", kind: "text" },
        { key: "samples", label: "Weeks used", kind: "count" },
        { key: "forecast", label: "Forecast net sales", kind: "money" },
        { key: "busiest", label: "Busiest hour", kind: "text" },
      ],
      rows: daily,
    },
    {
      key: "salesForecastHours",
      title: "Sales forecast by hour",
      description: "The hours of each forecast date with expected net sales, by the local hour checks are opened.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "hour", label: "Hour", kind: "text" },
        { key: "forecast", label: "Forecast net sales", kind: "money" },
      ],
      rows: hourly,
    },
  ];
}

/** Past dates in the range whose used demand forecast carried net sales, against closed checks. */
export async function salesForecastAccuracySection(context: ReportContext, now = new Date()): Promise<ReportSection> {
  const { filters, settings } = context;
  const today = businessDateOf(now, settings);
  const stored = await rowsOf<{ business_date: string; hour: number | null; forecast_value: string | null }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (fd.business_date) fd.business_date, fd.demand_forecast_id
        FROM demand_forecast_dates fd
        JOIN demand_forecasts f ON f.id = fd.demand_forecast_id
        WHERE f.location_id = ${filters.locationId}
          AND fd.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND fd.business_date < ${today}::date
          AND fd.status = 'OK'
          AND (f.method ->> 'netSales') = 'true'
        ORDER BY fd.business_date, f.created_at DESC, f.id DESC
      )
      SELECT l.business_date::text AS business_date, h.hour, h.forecast_value::text AS forecast_value
      FROM latest l
      LEFT JOIN demand_forecast_hours h
        ON h.demand_forecast_id = l.demand_forecast_id AND h.business_date = l.business_date
       AND h.measure = ${NET_SALES_MEASURE}
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
  const rows = dates.map((date) => {
    let forecastTotal = "0.00";
    let forecastPeak: Peak = null;

    for (const row of stored) {
      if (row.business_date === date && row.hour !== null && row.forecast_value !== null) {
        forecastTotal = addDecimals(forecastTotal, row.forecast_value);
        forecastPeak = higher(forecastPeak, row.hour, row.forecast_value);
      }
    }

    let actualTotal = "0.00";
    let actualPeak: Peak = null;

    for (const hour of history.hours) {
      if (hour.businessDate === date) {
        actualTotal = addDecimals(actualTotal, hour.netSales);
        actualPeak = higher(actualPeak, hour.hour, hour.netSales);
      }
    }

    const forecast = toScale(forecastTotal, 2);
    const actual = toScale(actualTotal, 2);
    const difference = toScale(subtractDecimals(actual, forecast), 2);

    return {
      businessDate: date,
      forecast,
      actual,
      difference,
      differencePercent:
        compareDecimals(forecast, "0") > 0 ? divideRoundHalfUp(multiplyExact(difference, "100"), forecast, 1) : null,
      forecastBusiest: forecastPeak ? hourLabel(forecastPeak.hour) : null,
      actualBusiest: actualPeak ? hourLabel(actualPeak.hour) : null,
    };
  });

  return {
    key: "salesForecastAccuracy",
    title: "Sales forecast vs actual",
    description:
      "Past business dates whose demand forecast was used for the schedule (the latest one): the net sales it expected, stored then, against closed checks. A positive difference means more sales than forecast.",
    columns: [
      { key: "businessDate", label: "Business date", kind: "date" },
      { key: "forecast", label: "Forecast net sales", kind: "money" },
      { key: "actual", label: "Actual net sales", kind: "money" },
      { key: "difference", label: "Difference", kind: "money" },
      { key: "differencePercent", label: "Difference %", kind: "percent" },
      { key: "forecastBusiest", label: "Forecast busiest hour", kind: "text" },
      { key: "actualBusiest", label: "Actual busiest hour", kind: "text" },
    ],
    rows,
  };
}
