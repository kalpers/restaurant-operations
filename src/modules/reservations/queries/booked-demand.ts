import { sql } from "drizzle-orm";

import type { DatabaseExecutor } from "@/db/transactions/transaction-context";

export type BookedCoversHour = {
  businessDate: string;
  /** Local hour (0-23) of `reservation_at` in the location's time zone. */
  hour: number;
  covers: number;
};

/**
 * Phase 24 policy 2 (D3): covers already booked, from PENDING and CONFIRMED reservations, by
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

  const rows = (await executor.execute(sql`
    SELECT r.business_date::text AS business_date,
           EXTRACT(HOUR FROM r.reservation_at AT TIME ZONE ${input.timeZone})::int AS hour,
           SUM(gp.party_size)::int AS covers
    FROM reservations r
    JOIN guest_parties gp ON gp.id = r.guest_party_id
    WHERE r.location_id = ${input.locationId}
      AND r.business_date BETWEEN ${input.fromDate}::date AND ${input.toDate}::date
      AND r.status IN ('PENDING', 'CONFIRMED')
    GROUP BY r.business_date, hour
    ORDER BY r.business_date, hour
  `)) as unknown as { business_date: string; hour: number; covers: number }[];

  return [...rows].map((row) => ({ businessDate: row.business_date, hour: row.hour, covers: row.covers }));
}
