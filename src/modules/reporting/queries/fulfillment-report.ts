import { sql } from "drizzle-orm";

import type { ReportSection } from "../types";

import { minutes, rowsOf, type ReportContext } from "./report-context";

/** The Phase 10 "late" band: an item ready more than 20 minutes after it was sent. */
export const LATE_MINUTES = 20;

/**
 * Kitchen and bar performance from fulfillment history: the instants each station item was
 * sent, started, made ready and completed, windowed by the business-date range's instants.
 */
export async function fulfillmentSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;

  const stations = await rowsOf<{
    station: string | null;
    station_type: string | null;
    items: number;
    completed: number;
    cancelled: number;
    ready_avg: string | null;
    ready_median: string | null;
    ready_p90: string | null;
    handoff_avg: string | null;
    late: number;
  }>(
    context,
    sql`
      WITH work AS (
        SELECT k.station_name_snapshot AS station, k.station_type_snapshot AS station_type, i.status,
               -- Phase 17: from when the course was fired, so held time isn't kitchen time.
               EXTRACT(EPOCH FROM i.ready_at - COALESCE(k.fired_at, i.submitted_at)) / 60 AS ready_minutes,
               EXTRACT(EPOCH FROM i.completed_at - i.ready_at) / 60 AS handoff_minutes
        FROM kitchen_ticket_items i
        JOIN kitchen_tickets k ON k.id = i.ticket_id
        WHERE i.location_id = ${filters.locationId}
          AND i.submitted_at >= ${context.start}::timestamptz AND i.submitted_at < ${context.end}::timestamptz
          ${filters.orderType ? sql`AND k.order_type_snapshot = ${filters.orderType}` : sql``}
      )
      SELECT station, station_type,
             (COUNT(*) FILTER (WHERE status <> 'CANCELLED'))::int AS items,
             (COUNT(*) FILTER (WHERE status = 'COMPLETED'))::int AS completed,
             (COUNT(*) FILTER (WHERE status = 'CANCELLED'))::int AS cancelled,
             AVG(ready_minutes)::text AS ready_avg,
             (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY ready_minutes))::text AS ready_median,
             (PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY ready_minutes))::text AS ready_p90,
             AVG(handoff_minutes)::text AS handoff_avg,
             (COUNT(*) FILTER (WHERE ready_minutes > ${LATE_MINUTES}))::int AS late
      FROM work
      GROUP BY GROUPING SETS ((station_type, station), ())
      ORDER BY station_type NULLS LAST, station NULLS LAST
    `,
  );

  const remakes = await rowsOf<{ reason: string; remakes: number }>(
    context,
    sql`
      SELECT r.reason, COUNT(*)::int AS remakes
      FROM kitchen_remakes r
      ${filters.orderType ? sql`JOIN orders o ON o.id = r.order_id` : sql``}
      WHERE r.location_id = ${filters.locationId}
        AND r.requested_at >= ${context.start}::timestamptz AND r.requested_at < ${context.end}::timestamptz
        ${filters.orderType ? sql`AND o.order_type = ${filters.orderType}` : sql``}
      GROUP BY r.reason
      ORDER BY remakes DESC, r.reason
    `,
  );

  return [
    {
      key: "stations",
      title: "Station performance",
      description: `Minutes from send to ready, and from ready to completed. Late means ready after more than ${LATE_MINUTES} minutes.`,
      columns: [
        { key: "stationType", label: "Type", kind: "text" },
        { key: "station", label: "Station", kind: "text" },
        { key: "items", label: "Items", kind: "count" },
        { key: "completed", label: "Completed", kind: "count" },
        { key: "cancelled", label: "Cancelled", kind: "count" },
        { key: "readyAverage", label: "Average to ready", kind: "minutes" },
        { key: "readyMedian", label: "Median to ready", kind: "minutes" },
        { key: "readyP90", label: "90th percentile to ready", kind: "minutes" },
        { key: "handoffAverage", label: "Average ready to completed", kind: "minutes" },
        { key: "late", label: "Late", kind: "count" },
      ],
      rows: stations.map((row) => ({
        stationType: row.station_type ?? "All",
        station: row.station ?? "All stations",
        items: row.items,
        completed: row.completed,
        cancelled: row.cancelled,
        readyAverage: minutes(row.ready_avg),
        readyMedian: minutes(row.ready_median),
        readyP90: minutes(row.ready_p90),
        handoffAverage: minutes(row.handoff_avg),
        late: row.late,
      })),
    },
    {
      key: "remakes",
      title: "Remakes by reason",
      columns: [
        { key: "reason", label: "Reason", kind: "text" },
        { key: "remakes", label: "Remakes", kind: "count" },
      ],
      rows: remakes.map((row) => ({ reason: row.reason, remakes: row.remakes })),
    },
  ];
}
