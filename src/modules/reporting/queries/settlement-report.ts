import { sql } from "drizzle-orm";

import type { ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

const TENDER_LABEL: Record<string, string> = {
  CASH: "Cash",
  EXTERNAL_CARD: "Card (external)",
  GIFT_CARD: "Gift card",
  HOUSE_ACCOUNT: "House account",
  OTHER: "Other",
};

/**
 * Settlement and tender history (Phase 11). Completed settlements and their RECORDED
 * tenders are counted by `completed_business_date`, so tender amounts reconcile exactly to
 * the settled order amounts. Voided and failed tenders are listed by the tender's own
 * business date. Card metadata is never read.
 */
export async function settlementSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const tenderFilter = filters.tenderType ? sql`AND t.tender_type = ${filters.tenderType}` : sql``;

  const daily = await rowsOf<{
    business_date: string;
    completed: number;
    zero_amount: number;
    amount: string;
    tips: string;
  }>(
    context,
    sql`
      SELECT s.completed_business_date::text AS business_date,
             COUNT(*)::int AS completed,
             (COUNT(*) FILTER (WHERE s.order_amount_snapshot = 0))::int AS zero_amount,
             SUM(s.order_amount_snapshot)::numeric(14,2)::text AS amount,
             SUM(s.tip_amount)::numeric(14,2)::text AS tips
      FROM order_settlements s
      WHERE s.location_id = ${filters.locationId}
        AND s.status = 'COMPLETED'
        AND s.completed_business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      GROUP BY s.completed_business_date
      ORDER BY s.completed_business_date
    `,
  );

  const tenders = await rowsOf<{
    tender_type: string | null;
    tenders: number;
    amount: string;
    tips: string;
    received: string | null;
    change: string;
  }>(
    context,
    sql`
      SELECT t.tender_type,
             COUNT(*)::int AS tenders,
             -- The grand-total row exists even with no tenders; it must read 0.00, not blank,
             -- so it reconciles exactly to net sales. Cash received stays blank without cash.
             COALESCE(SUM(t.amount), 0)::numeric(14,2)::text AS amount,
             COALESCE(SUM(t.tip_amount), 0)::numeric(14,2)::text AS tips,
             SUM(t.received_amount)::numeric(14,2)::text AS received,
             COALESCE(SUM(t.change_amount), 0)::numeric(14,2)::text AS change
      FROM settlement_tenders t
      JOIN order_settlements s ON s.id = t.settlement_id
      WHERE s.location_id = ${filters.locationId}
        AND s.status = 'COMPLETED'
        AND s.completed_business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        AND t.status = 'RECORDED'
        ${tenderFilter}
      GROUP BY GROUPING SETS ((t.tender_type), ())
      ORDER BY t.tender_type NULLS LAST
    `,
  );

  const exceptions = await rowsOf<{ tender_type: string; status: string; tenders: number; amount: string }>(
    context,
    sql`
      SELECT t.tender_type, t.status, COUNT(*)::int AS tenders,
             SUM(t.amount)::numeric(14,2)::text AS amount
      FROM settlement_tenders t
      JOIN order_settlements s ON s.id = t.settlement_id
      WHERE s.location_id = ${filters.locationId}
        AND t.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        AND t.status IN ('VOIDED', 'FAILED')
        ${tenderFilter}
      GROUP BY t.tender_type, t.status
      ORDER BY t.tender_type, t.status
    `,
  );

  const [cancelled] = await rowsOf<{ cancelled: number }>(
    context,
    sql`
      SELECT COUNT(*)::int AS cancelled
      FROM order_settlements s
      WHERE s.location_id = ${filters.locationId}
        AND s.status = 'CANCELLED'
        AND s.cancelled_at >= ${context.start}::timestamptz AND s.cancelled_at < ${context.end}::timestamptz
    `,
  );

  return [
    {
      key: "tenders",
      title: "Tenders by type",
      description:
        "RECORDED tenders on settlements completed in the range. Tips and change are separate from the amount applied.",
      columns: [
        { key: "tenderType", label: "Tender type", kind: "text" },
        { key: "tenders", label: "Tenders", kind: "count" },
        { key: "amount", label: "Amount applied", kind: "money" },
        { key: "tips", label: "Tips", kind: "money" },
        { key: "received", label: "Cash received", kind: "money" },
        { key: "change", label: "Change given", kind: "money" },
      ],
      rows: tenders.map((row) => ({
        tenderType: row.tender_type ? (TENDER_LABEL[row.tender_type] ?? row.tender_type) : "All",
        tenders: row.tenders,
        amount: row.amount,
        tips: row.tips,
        received: row.received,
        change: row.change,
      })),
    },
    {
      key: "daily",
      title: "Completed settlements by business date",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "completed", label: "Settlements", kind: "count" },
        { key: "zeroAmount", label: "Zero-amount closures", kind: "count" },
        { key: "amount", label: "Amount settled", kind: "money" },
        { key: "tips", label: "Tips", kind: "money" },
      ],
      rows: daily.map((row) => ({
        businessDate: row.business_date,
        completed: row.completed,
        zeroAmount: row.zero_amount,
        amount: row.amount,
        tips: row.tips,
      })),
    },
    {
      key: "exceptions",
      title: "Voided and failed tenders",
      description: `Settlements cancelled in the range: ${cancelled?.cancelled ?? 0}.`,
      columns: [
        { key: "tenderType", label: "Tender type", kind: "text" },
        { key: "status", label: "Status", kind: "text" },
        { key: "tenders", label: "Tenders", kind: "count" },
        { key: "amount", label: "Amount", kind: "money" },
      ],
      rows: exceptions.map((row) => ({
        tenderType: TENDER_LABEL[row.tender_type] ?? row.tender_type,
        status: row.status,
        tenders: row.tenders,
        amount: row.amount,
      })),
    },
  ];
}
