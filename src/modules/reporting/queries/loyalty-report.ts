import { sql } from "drizzle-orm";

import type { ReportSection } from "../types";
import { rowsOf, type ReportContext } from "./report-context";

// Phase 30 (policy 16, amendment 1): the loyalty sections of the Sales area, read from the
// append-only points ledger and the discount amounts frozen on the checks. No guest names or
// contact details, so the CSV export holds none either (Phase 21 policy 23).

export async function loyaltySections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const byDate = await rowsOf<{
    business_date: string;
    earned: number;
    redeemed: number;
    adjusted: number;
    other: number;
    guests: number;
  }>(
    context,
    sql`
      SELECT e.business_date::text AS business_date,
             COALESCE(SUM(e.points) FILTER (WHERE e.kind = 'EARNED'), 0)::int AS earned,
             COALESCE(-SUM(e.points) FILTER (WHERE e.kind = 'REDEEMED'), 0)::int AS redeemed,
             COALESCE(SUM(e.points) FILTER (WHERE e.kind = 'ADJUSTED'), 0)::int AS adjusted,
             COALESCE(SUM(e.points) FILTER (WHERE e.kind IN ('MERGED_OUT', 'MERGED_IN', 'ERASED')), 0)::int AS other,
             COUNT(DISTINCT e.guest_profile_id) FILTER (WHERE e.kind = 'EARNED')::int AS guests
      FROM guest_loyalty_entries e
      WHERE e.location_id = ${filters.locationId}
        AND e.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      GROUP BY e.business_date
      ORDER BY e.business_date
    `,
  );
  const rewards = await rowsOf<{ business_date: string; reward: string; redeemed: number; points: number; discount: string }>(
    context,
    sql`
      SELECT e.business_date::text AS business_date, r.reward_name_snapshot AS reward,
             COUNT(*)::int AS redeemed, (-SUM(e.points))::int AS points,
             SUM(COALESCE(od.applied_amount, oid.applied_amount))::numeric(14,2)::text AS discount
      FROM guest_loyalty_entries e
      JOIN guest_loyalty_redemptions r ON r.id = e.redemption_id
      LEFT JOIN order_discounts od ON od.id = r.order_discount_id
      LEFT JOIN order_item_discounts oid ON oid.id = r.order_item_discount_id
      WHERE e.kind = 'REDEEMED'
        AND e.location_id = ${filters.locationId}
        AND e.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      GROUP BY e.business_date, r.reward_name_snapshot
      ORDER BY e.business_date, r.reward_name_snapshot
    `,
  );
  const [outstanding] = await rowsOf<{ profiles: number; points: number }>(
    context,
    sql`
      SELECT COUNT(*) FILTER (WHERE b.balance > 0)::int AS profiles, COALESCE(SUM(b.balance), 0)::int AS points
      FROM guest_loyalty_balances b
      WHERE b.organization_id = (SELECT l.organization_id FROM locations l WHERE l.id = ${filters.locationId})
    `,
  );

  return [
    {
      key: "loyaltyPoints",
      title: "Loyalty points",
      description:
        "Points posted at this location by business date, from the loyalty ledger. Earned when a linked visit's session ends; redeemed when a check with a reward closes. Other is merges and erasures.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "guests", label: "Guests who earned", kind: "count" },
        { key: "earned", label: "Earned", kind: "count" },
        { key: "redeemed", label: "Redeemed", kind: "count" },
        { key: "adjusted", label: "Adjusted (net)", kind: "count" },
        { key: "other", label: "Other (net)", kind: "count" },
      ],
      rows: byDate.map((row) => ({
        businessDate: row.business_date,
        guests: row.guests,
        earned: row.earned,
        redeemed: row.redeemed,
        adjusted: row.adjusted,
        other: row.other,
      })),
    },
    {
      key: "loyaltyRewards",
      title: "Loyalty rewards redeemed",
      description:
        "Rewards on checks that closed at this location, with the points they cost and the discount frozen on the check.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "reward", label: "Reward", kind: "text" },
        { key: "redeemed", label: "Redeemed", kind: "count" },
        { key: "points", label: "Points", kind: "count" },
        { key: "discount", label: "Discount", kind: "money" },
      ],
      rows: rewards.map((row) => ({
        businessDate: row.business_date,
        reward: row.reward,
        redeemed: row.redeemed,
        points: row.points,
        discount: row.discount,
      })),
    },
    {
      key: "loyaltyOutstanding",
      title: "Outstanding loyalty points",
      description:
        "Points guests hold now, across all locations (profiles are organization-wide). Not valued in money and not in the sales journal.",
      columns: [
        { key: "profiles", label: "Guests with points", kind: "count" },
        { key: "points", label: "Points outstanding", kind: "count" },
      ],
      rows: [{ profiles: outstanding?.profiles ?? 0, points: outstanding?.points ?? 0 }],
    },
  ];
}
