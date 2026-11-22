import { sql } from "drizzle-orm";

import { rowsOf, type ReportContext } from "./report-context";

// Phase 34 (policy 5, amendment 2): the holder report, the material for an unclaimed-property
// filing. The same cards as "Unused gift card balances" (Phase 33 policy 15), organization-
// wide, as of the range end, with the selling location's address and the purchaser's details
// where they were given. Read only; never a code or its last four.

export type HolderReportRow = {
  cardNumber: number;
  firstSold: string | null;
  lastActivity: string;
  balance: string;
  soldAtCode: string;
  soldAtName: string;
  soldAtAddress: { line1: string | null; line2: string | null; city: string | null; state: string | null; postalCode: string | null; country: string | null };
  purchaser: {
    name: string | null;
    email: string | null;
    phone: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postalCode: string | null;
    country: string | null;
  };
};

export async function loadHolderReport(context: ReportContext): Promise<{ dormancyMonths: number; rows: HolderReportRow[] }> {
  const { filters } = context;
  const organization = sql`(SELECT l.organization_id FROM locations l WHERE l.id = ${filters.locationId})`;
  const [program] = await rowsOf<{ dormancy_months: number }>(
    context,
    sql`SELECT COALESCE((SELECT p.dormancy_months FROM gift_card_programs p WHERE p.organization_id = ${organization}), 36)::int AS dormancy_months`,
  );
  const months = program?.dormancy_months ?? 36;
  const rows = await rowsOf<{
    card_number: number;
    first_sold: string | null;
    last_activity: string;
    balance: string;
    location_code: string;
    location_name: string;
    location_line1: string | null;
    location_line2: string | null;
    location_city: string | null;
    location_state: string | null;
    location_postal: string | null;
    location_country: string | null;
    name: string | null;
    email: string | null;
    phone: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    region: string | null;
    postal_code: string | null;
    country: string | null;
  }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (e.gift_card_id) e.gift_card_id, e.balance_after, e.business_date
        FROM gift_card_entries e
        WHERE e.organization_id = ${organization}
          AND e.business_date <= ${filters.to}::date
        ORDER BY e.gift_card_id, e.sequence DESC
      ),
      first_sale AS (
        SELECT e.gift_card_id, MIN(e.business_date) AS business_date
        FROM gift_card_entries e
        WHERE e.kind = 'ISSUED'
        GROUP BY e.gift_card_id
      )
      SELECT c.card_number,
             first_sale.business_date::text AS first_sold,
             latest.business_date::text AS last_activity,
             latest.balance_after::text AS balance,
             l.location_code, l.name AS location_name,
             l.address_line1 AS location_line1, l.address_line2 AS location_line2, l.city AS location_city,
             l.state AS location_state, l.postal_code AS location_postal, l.country AS location_country,
             p.name, p.email, p.phone, p.address_line1 AS line1, p.address_line2 AS line2,
             p.city, p.region, p.postal_code, p.country
      FROM latest
      JOIN gift_cards c ON c.id = latest.gift_card_id
      JOIN locations l ON l.id = c.issued_location_id
      LEFT JOIN first_sale ON first_sale.gift_card_id = c.id
      LEFT JOIN gift_card_purchasers p ON p.gift_card_id = c.id
      WHERE latest.balance_after > 0
        AND latest.business_date <= (${filters.to}::date - make_interval(months => ${months}))::date
      ORDER BY latest.business_date, c.card_number
    `,
  );

  return {
    dormancyMonths: months,
    rows: rows.map((row) => ({
      cardNumber: row.card_number,
      firstSold: row.first_sold,
      lastActivity: row.last_activity,
      balance: row.balance,
      soldAtCode: row.location_code,
      soldAtName: row.location_name,
      soldAtAddress: {
        line1: row.location_line1,
        line2: row.location_line2,
        city: row.location_city,
        state: row.location_state,
        postalCode: row.location_postal,
        country: row.location_country,
      },
      purchaser: {
        name: row.name,
        email: row.email,
        phone: row.phone,
        line1: row.line1,
        line2: row.line2,
        city: row.city,
        region: row.region,
        postalCode: row.postal_code,
        country: row.country,
      },
    })),
  };
}
