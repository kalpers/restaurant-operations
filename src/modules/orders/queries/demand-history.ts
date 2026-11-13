import { sql } from "drizzle-orm";

import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

/** One business date and local hour of closed-check demand (Phase 24 policy 1). */
export type DemandHistoryHour = {
  businessDate: string;
  /** Local hour (0-23) the checks were opened, in the location's time zone. */
  hour: number;
  /** Guests seated at tables, counted once per table session on its first closed check. */
  diningCovers: number;
  barChecks: number;
  takeoutChecks: number;
  allChecks: number;
};

export type DemandHistory = {
  hours: DemandHistoryHour[];
  /** Business dates in the range with at least one closed check. */
  openDates: string[];
};

/**
 * Phase 24 policy 1 (D1, D9): closed-check demand by business date and the local hour each
 * check was opened. The same rule as the Phase 19 sales-by-hour report, so a date's numbers
 * here equal that report's for the date. Counts only; no money. Read-only.
 */
export async function getDemandHistory(
  executor: DatabaseExecutor,
  input: { locationId: string; timeZone: string; fromDate: string; toDate: string },
): Promise<DemandHistory> {
  if (input.fromDate > input.toDate) {
    return { hours: [], openDates: [] };
  }

  const rows = (await executor.execute(sql`
    WITH closed AS (
      SELECT o.id, o.order_type, o.business_date, o.table_session_id, o.opened_at,
             EXTRACT(HOUR FROM o.opened_at AT TIME ZONE ${input.timeZone})::int AS hour
      FROM orders o
      WHERE o.location_id = ${input.locationId}
        AND o.business_date BETWEEN ${input.fromDate}::date AND ${input.toDate}::date
        AND o.status = 'CLOSED'
    ),
    covers AS (
      SELECT c.id,
             CASE WHEN ROW_NUMBER() OVER (PARTITION BY c.table_session_id ORDER BY c.opened_at, c.id) = 1
                  THEN ts.party_size ELSE 0 END AS covers
      FROM closed c JOIN table_sessions ts ON ts.id = c.table_session_id
    )
    SELECT c.business_date::text AS business_date, c.hour,
           COALESCE(SUM(cv.covers), 0)::int AS dining_covers,
           (COUNT(*) FILTER (WHERE c.order_type = 'BAR'))::int AS bar_checks,
           (COUNT(*) FILTER (WHERE c.order_type = 'TAKEOUT'))::int AS takeout_checks,
           COUNT(*)::int AS all_checks
    FROM closed c LEFT JOIN covers cv ON cv.id = c.id
    GROUP BY c.business_date, c.hour
    ORDER BY c.business_date, c.hour
  `)) as unknown as {
    business_date: string;
    hour: number;
    dining_covers: number;
    bar_checks: number;
    takeout_checks: number;
    all_checks: number;
  }[];

  const hours = [...rows].map((row) => ({
    businessDate: row.business_date,
    hour: row.hour,
    diningCovers: row.dining_covers,
    barChecks: row.bar_checks,
    takeoutChecks: row.takeout_checks,
    allChecks: row.all_checks,
  }));

  return { hours, openDates: [...new Set(hours.map((row) => row.businessDate))] };
}
