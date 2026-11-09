import { sql } from "drizzle-orm";

import { percentOf } from "../rules/labor-cost";
import type { ReportSection } from "../types";

import { minutes, rowsOf, type ReportContext } from "./report-context";

/**
 * Seating analytics from Table Session, reservation and waitlist history, windowed by the
 * instants of the business-date range. Turns count sessions per table actually used, so
 * the figure never depends on today's table configuration.
 */
export async function seatingSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;

  const areas = await rowsOf<{
    area: string | null;
    sessions: number;
    completed: number;
    cancelled: number;
    covers: number;
    tables_used: number;
    average_duration: string | null;
    turns: string | null;
  }>(
    context,
    sql`
      WITH sessions AS (
        SELECT ts.id, ts.status, ts.party_size, ts.seated_at, ts.completed_at,
               (SELECT ra.name FROM table_session_tables tst
                  JOIN restaurant_tables rt ON rt.id = tst.restaurant_table_id
                  JOIN restaurant_areas ra ON ra.id = rt.restaurant_area_id
                 WHERE tst.table_session_id = ts.id
                 ORDER BY tst.joined_at, tst.id LIMIT 1) AS area
        FROM table_sessions ts
        WHERE ts.location_id = ${filters.locationId}
          AND ts.seated_at >= ${context.start}::timestamptz AND ts.seated_at < ${context.end}::timestamptz
      ),
      seated_tables AS (
        SELECT s.area, GROUPING(s.area) AS g, COUNT(DISTINCT tst.restaurant_table_id) AS tables_used
        FROM sessions s JOIN table_session_tables tst ON tst.table_session_id = s.id
        WHERE s.status <> 'CANCELLED'
        GROUP BY GROUPING SETS ((s.area), ())
      ),
      grouped AS (
        SELECT area, GROUPING(area) AS g,
               (COUNT(*) FILTER (WHERE status <> 'CANCELLED'))::int AS sessions,
               (COUNT(*) FILTER (WHERE status = 'COMPLETED'))::int AS completed,
               (COUNT(*) FILTER (WHERE status = 'CANCELLED'))::int AS cancelled,
               (COALESCE(SUM(party_size) FILTER (WHERE status <> 'CANCELLED'), 0))::int AS covers,
               (AVG(EXTRACT(EPOCH FROM completed_at - seated_at) / 60) FILTER (WHERE status = 'COMPLETED'))::text AS average_duration
        FROM sessions
        GROUP BY GROUPING SETS ((area), ())
      )
      SELECT CASE WHEN g.g = 1 THEN NULL ELSE COALESCE(g.area, 'No area') END AS area,
             g.sessions, g.completed, g.cancelled, g.covers,
             COALESCE(t.tables_used, 0)::int AS tables_used, g.average_duration,
             ROUND(g.sessions::numeric / NULLIF(t.tables_used, 0), 2)::text AS turns
      FROM grouped g
      LEFT JOIN seated_tables t ON t.g = g.g AND (g.g = 1 OR t.area IS NOT DISTINCT FROM g.area)
      ORDER BY g.g, g.area
    `,
  );

  const reservations = await rowsOf<{ status: string; reservations: number; covers: number }>(
    context,
    sql`
      SELECT r.status, COUNT(*)::int AS reservations, SUM(gp.party_size)::int AS covers
      FROM reservations r JOIN guest_parties gp ON gp.id = r.guest_party_id
      WHERE r.location_id = ${filters.locationId}
        AND r.reservation_at >= ${context.start}::timestamptz AND r.reservation_at < ${context.end}::timestamptz
      GROUP BY r.status
      ORDER BY r.status
    `,
  );

  const waitlist = await rowsOf<{
    status: string;
    entries: number;
    covers: number;
    quoted: string | null;
    waited: string | null;
  }>(
    context,
    sql`
      SELECT w.status, COUNT(*)::int AS entries, SUM(gp.party_size)::int AS covers,
             AVG(w.quoted_wait_minutes)::text AS quoted,
             AVG(EXTRACT(EPOCH FROM w.seated_at - w.added_at) / 60)::text AS waited
      FROM waitlist_entries w JOIN guest_parties gp ON gp.id = w.guest_party_id
      WHERE w.location_id = ${filters.locationId}
        AND w.added_at >= ${context.start}::timestamptz AND w.added_at < ${context.end}::timestamptz
      GROUP BY w.status
      ORDER BY w.status
    `,
  );

  const totalReservations = reservations.reduce((sum, row) => sum + row.reservations, 0);
  const cancelledReservations = reservations.find((row) => row.status === "CANCELLED")?.reservations ?? 0;
  const noShows = reservations.find((row) => row.status === "NO_SHOW")?.reservations ?? 0;
  const noShowRate = percentOf(String(noShows), String(totalReservations - cancelledReservations));

  return [
    {
      key: "sessions",
      title: "Table sessions by area",
      description:
        "Sessions seated in the range. Turns are sessions per table used; duration is seated to completed.",
      columns: [
        { key: "area", label: "Area", kind: "text" },
        { key: "sessions", label: "Sessions", kind: "count" },
        { key: "covers", label: "Covers", kind: "count" },
        { key: "completed", label: "Completed", kind: "count" },
        { key: "cancelled", label: "Cancelled", kind: "count" },
        { key: "tablesUsed", label: "Tables used", kind: "count" },
        { key: "turns", label: "Turns per table", kind: "quantity" },
        { key: "averageDuration", label: "Average minutes seated", kind: "minutes" },
      ],
      rows: areas.map((row) => ({
        area: row.area ?? "All areas",
        sessions: row.sessions,
        covers: row.covers,
        completed: row.completed,
        cancelled: row.cancelled,
        tablesUsed: row.tables_used,
        turns: row.turns,
        averageDuration: minutes(row.average_duration),
      })),
    },
    {
      key: "reservations",
      title: "Reservations",
      description: `No-show rate (no-shows over reservations not cancelled): ${noShowRate === null ? "n/a" : `${noShowRate}%`}.`,
      columns: [
        { key: "status", label: "Status", kind: "text" },
        { key: "reservations", label: "Reservations", kind: "count" },
        { key: "covers", label: "Covers", kind: "count" },
      ],
      rows: reservations.map((row) => ({
        status: row.status,
        reservations: row.reservations,
        covers: row.covers,
      })),
    },
    {
      key: "waitlist",
      title: "Waitlist",
      description: "Entries added in the range. Actual wait is added to seated.",
      columns: [
        { key: "status", label: "Status", kind: "text" },
        { key: "entries", label: "Entries", kind: "count" },
        { key: "covers", label: "Covers", kind: "count" },
        { key: "quoted", label: "Average quoted minutes", kind: "minutes" },
        { key: "waited", label: "Average actual wait", kind: "minutes" },
      ],
      rows: waitlist.map((row) => ({
        status: row.status,
        entries: row.entries,
        covers: row.covers,
        quoted: minutes(row.quoted),
        waited: minutes(row.waited),
      })),
    },
  ];
}
