import { sql } from "drizzle-orm";

import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export type BookedCoversHour = {
  businessDate: string;
  /** Local hour (0-23) of `reservation_at` in the location's time zone. */
  hour: number;
  covers: number;
};

/**
 * Phase 24 policy 2 (D3): covers already booked, from PENDING and CONFIRMED reservations (and,
 * since Phase 36, TENTATIVE and CONFIRMED events), by
 * the reservation's business date and local hour. Party size comes from the guest party.
 * Read-only; no guest details leave this query.
 */
export async function getBookedCovers(
  executor: DatabaseExecutor,
  input: { locationId: string; timeZone: string; fromDate: string; toDate: string },
): Promise<BookedCoversHour[]> {
  if (input.fromDate > input.toDate) {
    return [];
  }

  // Phase 36 (policy 7): TENTATIVE and CONFIRMED events count too, in the hour they start.
  const rows = (await executor.execute(sql`
    SELECT booked.business_date::text AS business_date, booked.hour, SUM(booked.party_size)::int AS covers
    FROM (
      SELECT r.business_date,
             EXTRACT(HOUR FROM r.reservation_at AT TIME ZONE ${input.timeZone})::int AS hour,
             gp.party_size
      FROM reservations r
      JOIN guest_parties gp ON gp.id = r.guest_party_id
      WHERE r.location_id = ${input.locationId}
        AND r.business_date BETWEEN ${input.fromDate}::date AND ${input.toDate}::date
        AND r.status IN ('PENDING', 'CONFIRMED')
      UNION ALL
      SELECT e.business_date,
             EXTRACT(HOUR FROM e.starts_at AT TIME ZONE ${input.timeZone})::int AS hour,
             gp.party_size
      FROM event_bookings e
      JOIN guest_parties gp ON gp.id = e.guest_party_id
      WHERE e.location_id = ${input.locationId}
        AND e.business_date BETWEEN ${input.fromDate}::date AND ${input.toDate}::date
        AND e.status IN ('TENTATIVE', 'CONFIRMED')
    ) booked
    GROUP BY booked.business_date, booked.hour
    ORDER BY booked.business_date, booked.hour
  `)) as unknown as { business_date: string; hour: number; covers: number }[];

  return [...rows].map((row) => ({ businessDate: row.business_date, hour: row.hour, covers: row.covers }));
}
