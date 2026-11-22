import { sql } from "drizzle-orm";

import { addDecimals } from "@/shared/decimal/decimal";

import type { JournalDayFacts } from "../rules/sales-journal";
import { rowsOf, type ReportContext } from "./report-context";

// Phase 28 sales journal facts (policy 8), read-only, from the recorded history only:
// CLOSED orders by their business date (the sales rule), their item and share lines by the
// menu category snapshot taken at SEND, applied discounts, the `order_tax_lines` projection,
// RECORDED tenders of their COMPLETED settlements, refunds by the business date recorded, and
// closed drawer sessions by their business date (as the settlements report). Never current
// prices, menus or tax rates. Phase 31: gift card sales by their business date (every sale,
// voided or not), sale voids by the date voided, and cash-outs and adjustments from the card
// ledger, all at this location.

const UNCATEGORIZED = "Uncategorized";

export async function loadJournalFacts(context: ReportContext): Promise<JournalDayFacts[]> {
  const { filters } = context;
  const closed = sql`
    SELECT o.id, o.business_date FROM orders o
    WHERE o.location_id = ${filters.locationId}
      AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      AND o.status = 'CLOSED'
  `;
  const [sales, totals, taxes, tenders, refunds, drawers, cardSales, cardVoids, cardEntries] = await Promise.all([
    rowsOf<{ business_date: string; category: string | null; amount: string }>(
      context,
      sql`
        WITH closed AS (${closed}),
        lines AS (
          SELECT c.business_date, oi.menu_category_name_snapshot AS category, oi.line_total_snapshot AS amount
          FROM order_items oi JOIN closed c ON c.id = oi.order_id
          WHERE oi.status = 'SUBMITTED'
          UNION ALL
          SELECT c.business_date, oi.menu_category_name_snapshot, s.amount
          FROM order_item_shares s
          JOIN closed c ON c.id = s.order_id
          JOIN order_items oi ON oi.id = s.order_item_id
          WHERE s.status = 'ACTIVE'
        )
        SELECT business_date::text AS business_date, category, SUM(amount)::numeric(14,2)::text AS amount
        FROM lines GROUP BY business_date, category ORDER BY business_date, category
      `,
    ),
    rowsOf<{ business_date: string; discounts: string; comps: string; included: string }>(
      context,
      sql`
        WITH closed AS (${closed}),
        comps AS (
          SELECT d.order_id, SUM(d.applied_amount) AS amount
          FROM (
            SELECT od.order_id, od.applied_amount, od.is_comp, od.status
            FROM order_discounts od JOIN closed c ON c.id = od.order_id
            UNION ALL
            SELECT oi.order_id, oid.applied_amount, oid.is_comp, oid.status
            FROM order_item_discounts oid
            JOIN order_items oi ON oi.id = oid.order_item_id
            JOIN closed c ON c.id = oi.order_id
          ) d
          WHERE d.is_comp AND d.status = 'APPLIED'
          GROUP BY d.order_id
        )
        SELECT o.business_date::text AS business_date,
               (SUM(o.discount_total) - COALESCE(SUM(cp.amount), 0))::numeric(14,2)::text AS discounts,
               COALESCE(SUM(cp.amount), 0)::numeric(14,2)::text AS comps,
               SUM(o.included_tax_total)::numeric(14,2)::text AS included
        FROM orders o JOIN closed c ON c.id = o.id
        LEFT JOIN comps cp ON cp.order_id = o.id
        GROUP BY o.business_date
      `,
    ),
    rowsOf<{ business_date: string; code: string; amount: string }>(
      context,
      sql`
        WITH closed AS (${closed})
        SELECT c.business_date::text AS business_date, l.tax_category_code_snapshot AS code,
               SUM(l.tax_amount)::numeric(14,2)::text AS amount
        FROM order_tax_lines l JOIN closed c ON c.id = l.order_id
        GROUP BY c.business_date, l.tax_category_code_snapshot
      `,
    ),
    rowsOf<{ business_date: string; tender_type: string; amount: string; tips: string }>(
      context,
      sql`
        WITH closed AS (${closed})
        SELECT c.business_date::text AS business_date, t.tender_type,
               SUM(t.amount)::numeric(14,2)::text AS amount, SUM(t.tip_amount)::numeric(14,2)::text AS tips
        FROM settlement_tenders t
        JOIN order_settlements s ON s.id = t.settlement_id AND s.status = 'COMPLETED'
        JOIN closed c ON c.id = s.order_id
        WHERE t.status = 'RECORDED'
        GROUP BY c.business_date, t.tender_type
      `,
    ),
    rowsOf<{ business_date: string; tender_type: string; amount: string; tax: string; tips: string }>(
      context,
      sql`
        SELECT r.business_date::text AS business_date, r.tender_type,
               SUM(r.amount)::numeric(14,2)::text AS amount, SUM(r.tax_amount)::numeric(14,2)::text AS tax,
               SUM(r.tip_amount)::numeric(14,2)::text AS tips
        FROM order_refunds r
        WHERE r.location_id = ${filters.locationId}
          AND r.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND r.status = 'RECORDED'
        GROUP BY r.business_date, r.tender_type
      `,
    ),
    rowsOf<{ business_date: string; variance: string }>(
      context,
      sql`
        SELECT s.business_date::text AS business_date, s.variance::text AS variance
        FROM cash_drawer_sessions s
        WHERE s.location_id = ${filters.locationId}
          AND s.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND s.status = 'CLOSED' AND s.variance IS NOT NULL
        ORDER BY s.business_date, s.id
      `,
    ),
    rowsOf<{ business_date: string; tender_type: string; amount: string }>(
      context,
      sql`
        SELECT g.business_date::text AS business_date, g.tender_type, SUM(g.amount)::numeric(14,2)::text AS amount
        FROM gift_card_sales g
        WHERE g.location_id = ${filters.locationId}
          AND g.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        GROUP BY g.business_date, g.tender_type
      `,
    ),
    rowsOf<{ business_date: string; tender_type: string; amount: string }>(
      context,
      sql`
        SELECT g.voided_business_date::text AS business_date, g.tender_type, SUM(g.amount)::numeric(14,2)::text AS amount
        FROM gift_card_sales g
        WHERE g.location_id = ${filters.locationId}
          AND g.status = 'VOIDED'
          AND g.voided_business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        GROUP BY g.voided_business_date, g.tender_type
      `,
    ),
    rowsOf<{ business_date: string; cash_outs: string; adjustments: string; escheated: string }>(
      context,
      sql`
        SELECT e.business_date::text AS business_date,
               COALESCE(-SUM(e.amount) FILTER (WHERE e.kind = 'CASHED_OUT'), 0)::numeric(14,2)::text AS cash_outs,
               COALESCE(SUM(e.amount) FILTER (WHERE e.kind = 'ADJUSTED'), 0)::numeric(14,2)::text AS adjustments,
               COALESCE(-SUM(e.amount) FILTER (WHERE e.kind = 'ESCHEATED'), 0)::numeric(14,2)::text AS escheated
        FROM gift_card_entries e
        WHERE e.location_id = ${filters.locationId}
          AND e.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND e.kind IN ('CASHED_OUT', 'ADJUSTED', 'ESCHEATED')
        GROUP BY e.business_date
      `,
    ),
  ]);
  const dates = [
    ...new Set([
      ...sales.map((row) => row.business_date),
      ...totals.map((row) => row.business_date),
      ...tenders.map((row) => row.business_date),
      ...refunds.map((row) => row.business_date),
      ...drawers.map((row) => row.business_date),
      ...cardSales.map((row) => row.business_date),
      ...cardVoids.map((row) => row.business_date),
      ...cardEntries.map((row) => row.business_date),
    ]),
  ].sort();

  return dates.map((date) => {
    const total = totals.find((row) => row.business_date === date);
    const byCategory = new Map<string, string>();

    for (const row of sales.filter((entry) => entry.business_date === date)) {
      const category = row.category ?? UNCATEGORIZED;

      // Two snapshots may share a name (one null, one literally "Uncategorized"); add them.
      byCategory.set(category, byCategory.has(category) ? addDecimals(byCategory.get(category)!, row.amount) : row.amount);
    }

    return {
      businessDate: date,
      salesByCategory: [...byCategory].map(([category, amount]) => ({ category, amount })),
      discounts: total?.discounts ?? "0.00",
      comps: total?.comps ?? "0.00",
      includedTax: total?.included ?? "0.00",
      taxByCategory: taxes.filter((row) => row.business_date === date).map(({ code, amount }) => ({ code, amount })),
      tenders: tenders
        .filter((row) => row.business_date === date)
        .map((row) => ({ tenderType: row.tender_type, amount: row.amount, tips: row.tips })),
      refunds: refunds
        .filter((row) => row.business_date === date)
        .map((row) => ({ tenderType: row.tender_type, amount: row.amount, tax: row.tax, tips: row.tips })),
      drawerVariances: drawers.filter((row) => row.business_date === date).map((row) => row.variance),
      giftCardSales: cardSales
        .filter((row) => row.business_date === date)
        .map((row) => ({ tenderType: row.tender_type, amount: row.amount })),
      giftCardSaleVoids: cardVoids
        .filter((row) => row.business_date === date)
        .map((row) => ({ tenderType: row.tender_type, amount: row.amount })),
      giftCardCashOuts: cardEntries.find((row) => row.business_date === date)?.cash_outs ?? "0.00",
      giftCardAdjustments: cardEntries.find((row) => row.business_date === date)?.adjustments ?? "0.00",
      giftCardEscheated: cardEntries.find((row) => row.business_date === date)?.escheated ?? "0.00",
    };
  });
}
