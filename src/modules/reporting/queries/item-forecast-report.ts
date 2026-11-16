import { sql } from "drizzle-orm";

import { getItemSalesHistory } from "@/modules/orders/queries/item-sales-history";
import {
  compareDecimals,
  divideRoundHalfUp,
  multiplyExact,
  subtractDecimals,
  toScale,
} from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";

import type { ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

// Phase 25 policy 15 (D8): item forecast vs actual. For each past business date covered by a
// stored purchasing forecast (the latest one that covered it), the forecast portions per menu
// item against the portions sold on closed checks (the item-mix rule). Reads the snapshot;
// nothing is recomputed from current recipes, menus or settings. Counts only.

export async function itemForecastAccuracySection(context: ReportContext, now = new Date()): Promise<ReportSection> {
  const { filters, settings } = context;
  const today = businessDateOf(now, settings);
  const stored = await rowsOf<{ business_date: string; menu_item_id: string; name: string; portions: string }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (fi.business_date) fi.business_date, fi.purchasing_forecast_id
        FROM purchasing_forecast_items fi
        JOIN purchasing_forecasts f ON f.id = fi.purchasing_forecast_id
        WHERE f.location_id = ${filters.locationId}
          AND fi.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND fi.business_date < ${today}::date
          AND fi.status = 'OK'
        ORDER BY fi.business_date, f.created_at DESC, f.id DESC
      )
      SELECT l.business_date::text AS business_date, fi.menu_item_id, mi.name, fi.portions::text AS portions
      FROM latest l
      JOIN purchasing_forecast_items fi
        ON fi.purchasing_forecast_id = l.purchasing_forecast_id AND fi.business_date = l.business_date
      JOIN menu_items mi ON mi.id = fi.menu_item_id
      ORDER BY l.business_date, mi.name, fi.menu_item_id
    `,
  );
  const dates = [...new Set(stored.map((row) => row.business_date))];
  const history =
    dates.length > 0
      ? await getItemSalesHistory(context.tx, {
          locationId: filters.locationId,
          fromDate: dates[0]!,
          toDate: dates[dates.length - 1]!,
        })
      : { items: [] };
  const sold = new Map(history.items.map((row) => [`${row.businessDate}|${row.menuItemId}`, row.portions]));
  const rows = [];

  for (const row of stored) {
    const forecast = toScale(row.portions, 2);
    const actual = toScale(String(sold.get(`${row.business_date}|${row.menu_item_id}`) ?? 0), 2);

    if (compareDecimals(forecast, "0") === 0 && compareDecimals(actual, "0") === 0) {
      continue;
    }

    const difference = toScale(subtractDecimals(actual, forecast), 2);

    rows.push({
      businessDate: row.business_date,
      item: row.name,
      forecast,
      actual,
      difference,
      differencePercent:
        compareDecimals(forecast, "0") > 0 ? divideRoundHalfUp(multiplyExact(difference, "100"), forecast, 1) : null,
    });
  }

  return {
    key: "itemForecastAccuracy",
    title: "Item forecast vs actual",
    description:
      "For past business dates covered by a purchasing forecast that drafts were made from (the latest one): forecast and sold portions per item on closed checks. A positive difference means more sold than forecast.",
    columns: [
      { key: "businessDate", label: "Business date", kind: "date" },
      { key: "item", label: "Item", kind: "text" },
      { key: "forecast", label: "Forecast portions", kind: "quantity" },
      { key: "actual", label: "Sold portions", kind: "quantity" },
      { key: "difference", label: "Difference", kind: "quantity" },
      { key: "differencePercent", label: "Difference %", kind: "percent" },
    ],
    rows,
  };
}
