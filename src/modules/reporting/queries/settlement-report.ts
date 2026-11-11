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
 * the settled order amounts (net sales plus tax, Phase 17). Voided and failed tenders are listed by the tender's own
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
             -- so it reconciles exactly to net sales plus tax. Cash received stays blank without cash.
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

  // Phase 17: refunds by the business date they were recorded on, and drawer sessions.
  const refunds = await rowsOf<{ tender_type: string | null; refunds: number; amount: string; tax: string; voided: number }>(
    context,
    sql`
      SELECT r.tender_type,
             (COUNT(*) FILTER (WHERE r.status = 'RECORDED'))::int AS refunds,
             COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'RECORDED'), 0)::numeric(14,2)::text AS amount,
             COALESCE(SUM(r.tax_amount) FILTER (WHERE r.status = 'RECORDED'), 0)::numeric(14,2)::text AS tax,
             (COUNT(*) FILTER (WHERE r.status = 'VOIDED'))::int AS voided
      FROM order_refunds r
      WHERE r.location_id = ${filters.locationId}
        AND r.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        ${filters.tenderType ? sql`AND r.tender_type = ${filters.tenderType}` : sql``}
      GROUP BY GROUPING SETS ((r.tender_type), ())
      ORDER BY r.tender_type NULLS LAST
    `,
  );

  const drawers = await rowsOf<{
    drawer: string;
    session_number: number;
    business_date: string;
    status: string;
    opening_float: string;
    cash_in: string;
    paid_in: string;
    paid_out: string;
    cash_refunds: string;
    expected: string;
    counted: string | null;
    variance: string | null;
  }>(
    context,
    sql`
      SELECT d.code AS drawer, s.session_number, s.business_date::text AS business_date, s.status,
             s.opening_float::text AS opening_float,
             COALESCE(t.cash_in, 0)::numeric(14,2)::text AS cash_in,
             COALESCE(m.paid_in, 0)::numeric(14,2)::text AS paid_in,
             COALESCE(m.paid_out, 0)::numeric(14,2)::text AS paid_out,
             COALESCE(r.cash_refunds, 0)::numeric(14,2)::text AS cash_refunds,
             -- Closed sessions show their snapshot; open ones the running figure.
             COALESCE(s.expected_amount, s.opening_float + COALESCE(t.cash_in, 0) + COALESCE(m.paid_in, 0)
               - COALESCE(m.paid_out, 0) - COALESCE(r.cash_refunds, 0))::numeric(14,2)::text AS expected,
             s.counted_amount::text AS counted, s.variance::text AS variance
      FROM cash_drawer_sessions s
      JOIN cash_drawers d ON d.id = s.drawer_id
      LEFT JOIN (
        SELECT cash_drawer_session_id AS id, SUM(amount + tip_amount) AS cash_in
        FROM settlement_tenders WHERE status = 'RECORDED' AND cash_drawer_session_id IS NOT NULL
        GROUP BY cash_drawer_session_id
      ) t ON t.id = s.id
      LEFT JOIN (
        SELECT session_id AS id,
               SUM(amount) FILTER (WHERE movement_type = 'PAID_IN') AS paid_in,
               SUM(amount) FILTER (WHERE movement_type = 'PAID_OUT') AS paid_out
        FROM cash_drawer_movements GROUP BY session_id
      ) m ON m.id = s.id
      LEFT JOIN (
        SELECT cash_drawer_session_id AS id, SUM(amount) AS cash_refunds
        FROM order_refunds WHERE status = 'RECORDED' AND cash_drawer_session_id IS NOT NULL
        GROUP BY cash_drawer_session_id
      ) r ON r.id = s.id
      WHERE s.location_id = ${filters.locationId}
        AND s.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      ORDER BY s.business_date, d.code, s.session_number
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
    {
      key: "refunds",
      title: "Refunds by type",
      description: "Refunds recorded on closed checks, by the business date they were given. Record only.",
      columns: [
        { key: "tenderType", label: "Refunded as", kind: "text" },
        { key: "refunds", label: "Refunds", kind: "count" },
        { key: "amount", label: "Refunded", kind: "money" },
        { key: "tax", label: "Of which tax", kind: "money" },
        { key: "voided", label: "Voided refunds", kind: "count" },
      ],
      rows: refunds.map((row) => ({
        tenderType: row.tender_type ? (TENDER_LABEL[row.tender_type] ?? row.tender_type) : "All",
        refunds: row.refunds,
        amount: row.amount,
        tax: row.tax,
        voided: row.voided,
      })),
    },
    {
      key: "drawers",
      title: "Cash drawers",
      description:
        "Expected cash is the float plus cash taken (with tips) and paid in, less paid out and cash refunds. Variance is counted less expected.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "drawer", label: "Drawer", kind: "text" },
        { key: "session", label: "Session", kind: "count" },
        { key: "status", label: "Status", kind: "text" },
        { key: "openingFloat", label: "Float", kind: "money" },
        { key: "cashIn", label: "Cash taken", kind: "money" },
        { key: "paidIn", label: "Paid in", kind: "money" },
        { key: "paidOut", label: "Paid out", kind: "money" },
        { key: "cashRefunds", label: "Cash refunds", kind: "money" },
        { key: "expected", label: "Expected", kind: "money" },
        { key: "counted", label: "Counted", kind: "money" },
        { key: "variance", label: "Variance", kind: "money" },
      ],
      rows: drawers.map((row) => ({
        businessDate: row.business_date,
        drawer: row.drawer,
        session: row.session_number,
        status: row.status,
        openingFloat: row.opening_float,
        cashIn: row.cash_in,
        paidIn: row.paid_in,
        paidOut: row.paid_out,
        cashRefunds: row.cash_refunds,
        expected: row.expected,
        counted: row.counted,
        variance: row.variance,
      })),
    },
  ];
}
