import { sql } from "drizzle-orm";

import type { ReportSection } from "../types";
import { rowsOf, type ReportContext } from "./report-context";

// Phase 31 (policy 16, amendment 6): the gift card sections of the Settlements area, read from
// the append-only card ledger. Movements are at the selected location by business date; the
// outstanding balance is organization-wide (cards are), as of the range end. Cards appear by
// their public number only, never their code or its last four characters, so the CSV holds
// none either.
//
// Phase 33 (policies 15, 16): organization-wide sections are titled "(all locations)", and
// "Unused gift card balances" lists cards whose last ledger activity is older than the
// program's dormancy period, for unclaimed-property reporting (a list, not a filing).

export async function giftCardSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const byDate = await rowsOf<{
    business_date: string;
    sold: string;
    reloaded: string;
    sale_voids: string;
    redeemed: string;
    redemption_voids: string;
    refunded: string;
    adjusted: string;
    cashed_out: string;
  }>(
    context,
    sql`
      SELECT e.business_date::text AS business_date,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'ISSUED'), 0)::numeric(14,2)::text AS sold,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'RELOADED'), 0)::numeric(14,2)::text AS reloaded,
             COALESCE(-SUM(e.amount) FILTER (WHERE e.kind = 'SALE_VOIDED'), 0)::numeric(14,2)::text AS sale_voids,
             COALESCE(-SUM(e.amount) FILTER (WHERE e.kind = 'REDEEMED'), 0)::numeric(14,2)::text AS redeemed,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'REDEMPTION_VOIDED'), 0)::numeric(14,2)::text AS redemption_voids,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind IN ('REFUNDED', 'REFUND_VOIDED')), 0)::numeric(14,2)::text AS refunded,
             COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'ADJUSTED'), 0)::numeric(14,2)::text AS adjusted,
             COALESCE(-SUM(e.amount) FILTER (WHERE e.kind = 'CASHED_OUT'), 0)::numeric(14,2)::text AS cashed_out
      FROM gift_card_entries e
      WHERE e.location_id = ${filters.locationId}
        AND e.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      GROUP BY e.business_date
      ORDER BY e.business_date
    `,
  );
  const [outstanding] = await rowsOf<{ cards: number; balance: string }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (e.gift_card_id) e.gift_card_id, e.balance_after
        FROM gift_card_entries e
        WHERE e.organization_id = (SELECT l.organization_id FROM locations l WHERE l.id = ${filters.locationId})
          AND e.business_date <= ${filters.to}::date
        ORDER BY e.gift_card_id, e.sequence DESC
      )
      SELECT COUNT(*) FILTER (WHERE balance_after > 0)::int AS cards,
             COALESCE(SUM(balance_after), 0)::numeric(14,2)::text AS balance
      FROM latest
    `,
  );
  const cards = await rowsOf<{ card_number: number; balance: string; last_activity: string }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (e.gift_card_id) e.gift_card_id, e.balance_after, e.business_date
        FROM gift_card_entries e
        WHERE e.organization_id = (SELECT l.organization_id FROM locations l WHERE l.id = ${filters.locationId})
          AND e.business_date <= ${filters.to}::date
        ORDER BY e.gift_card_id, e.sequence DESC
      )
      SELECT c.card_number, latest.balance_after::text AS balance, latest.business_date::text AS last_activity
      FROM latest JOIN gift_cards c ON c.id = latest.gift_card_id
      WHERE latest.balance_after > 0
      ORDER BY c.card_number
      LIMIT 500
    `,
  );

  return [
    {
      key: "giftCardMovements",
      title: "Gift card movements",
      description:
        "Value put on and taken off the restaurant's own gift cards at this location, by business date, from the card ledger. Selling a card is not a sale: it carries no tax or tip and is not in the sales figures.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "sold", label: "Sold", kind: "money" },
        { key: "reloaded", label: "Reloaded", kind: "money" },
        { key: "saleVoids", label: "Sales voided", kind: "money" },
        { key: "redeemed", label: "Spent on checks", kind: "money" },
        { key: "redemptionVoids", label: "Tenders voided", kind: "money" },
        { key: "refunded", label: "Refunded to cards (net)", kind: "money" },
        { key: "adjusted", label: "Adjusted (net)", kind: "money" },
        { key: "cashedOut", label: "Cashed out", kind: "money" },
      ],
      rows: byDate.map((row) => ({
        businessDate: row.business_date,
        sold: row.sold,
        reloaded: row.reloaded,
        saleVoids: row.sale_voids,
        redeemed: row.redeemed,
        redemptionVoids: row.redemption_voids,
        refunded: row.refunded,
        adjusted: row.adjusted,
        cashedOut: row.cashed_out,
      })),
    },
    {
      key: "giftCardOutstanding",
      title: "Outstanding gift card balances (all locations)",
      description:
        "What the restaurant owes on its gift cards at the end of the range, across all locations (cards are organization-wide), so every location shows the same figure: don't add locations together.",
      columns: [
        { key: "cards", label: "Cards with a balance", kind: "count" },
        { key: "balance", label: "Outstanding", kind: "money" },
      ],
      rows: [{ cards: outstanding?.cards ?? 0, balance: outstanding?.balance ?? "0.00" }],
    },
    {
      key: "giftCardBalances",
      title: "Cards holding a balance (all locations)",
      description:
        "Each card with value left at the end of the range and the business date of its last activity, by card number. Up to 500 cards.",
      columns: [
        { key: "cardNumber", label: "Card", kind: "text" },
        { key: "balance", label: "Balance", kind: "money" },
        { key: "lastActivity", label: "Last activity", kind: "date" },
      ],
      rows: cards.map((row) => ({
        cardNumber: `GC-${String(row.card_number).padStart(6, "0")}`,
        balance: row.balance,
        lastActivity: row.last_activity,
      })),
    },
    await unusedBalancesSection(context),
  ];
}

/**
 * Phase 33 (policy 15): cards with value left at the end of the range whose last ledger
 * activity is on or before the range end less the program's dormancy period. Organization-
 * wide, every card, no limit. Only ledger entries count as activity.
 */
async function unusedBalancesSection(context: ReportContext): Promise<ReportSection> {
  const { filters } = context;
  const [program] = await rowsOf<{ dormancy_months: number }>(
    context,
    sql`
      SELECT COALESCE(
        (SELECT p.dormancy_months FROM gift_card_programs p
         WHERE p.organization_id = (SELECT l.organization_id FROM locations l WHERE l.id = ${filters.locationId})),
        36)::int AS dormancy_months
    `,
  );
  const months = program?.dormancy_months ?? 36;
  const rows = await rowsOf<{
    card_number: number;
    first_sold: string | null;
    sold_at: string;
    balance: string;
    last_activity: string;
    months_inactive: number;
  }>(
    context,
    sql`
      WITH latest AS (
        SELECT DISTINCT ON (e.gift_card_id) e.gift_card_id, e.balance_after, e.business_date
        FROM gift_card_entries e
        WHERE e.organization_id = (SELECT l.organization_id FROM locations l WHERE l.id = ${filters.locationId})
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
             l.name AS sold_at,
             latest.balance_after::text AS balance,
             latest.business_date::text AS last_activity,
             ((EXTRACT(YEAR FROM age(${filters.to}::date, latest.business_date)) * 12
               + EXTRACT(MONTH FROM age(${filters.to}::date, latest.business_date))))::int AS months_inactive
      FROM latest
      JOIN gift_cards c ON c.id = latest.gift_card_id
      JOIN locations l ON l.id = c.issued_location_id
      LEFT JOIN first_sale ON first_sale.gift_card_id = c.id
      WHERE latest.balance_after > 0
        AND latest.business_date <= (${filters.to}::date - make_interval(months => ${months}))::date
      ORDER BY latest.business_date, c.card_number
    `,
  );

  return {
    key: "giftCardUnused",
    title: "Unused gift card balances (all locations)",
    description: `Cards with value left at the end of the range and no card activity for at least ${months} months (the gift card settings' period), across all locations. For unclaimed-property reporting: the app keeps no purchaser names or addresses, so this list supports a filing but isn't one.`,
    columns: [
      { key: "cardNumber", label: "Card", kind: "text" },
      { key: "firstSold", label: "First sold", kind: "date" },
      { key: "soldAt", label: "Sold at", kind: "text" },
      { key: "balance", label: "Balance", kind: "money" },
      { key: "lastActivity", label: "Last activity", kind: "date" },
      { key: "monthsInactive", label: "Months without activity", kind: "count" },
    ],
    rows: rows.map((row) => ({
      cardNumber: `GC-${String(row.card_number).padStart(6, "0")}`,
      firstSold: row.first_sold,
      soldAt: row.sold_at,
      balance: row.balance,
      lastActivity: row.last_activity,
      monthsInactive: row.months_inactive,
    })),
  };
}
