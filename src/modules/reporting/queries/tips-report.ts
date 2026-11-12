import { sql } from "drizzle-orm";

import { subtractDecimals, toScale } from "@/shared/decimal/decimal";

import type { ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

// Phase 18 Tips report (approved policy D28). Tips are RECORDED tender tips on COMPLETED
// settlements of CLOSED orders, by the order's business date. Shares come only from FINALIZED
// distribution snapshots. Read-only.

export async function tipsSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const tipScope = sql`
    o.location_id = ${filters.locationId}
    AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
    AND o.status = 'CLOSED'
    AND s.status = 'COMPLETED'
    AND t.status = 'RECORDED'
    AND t.tip_amount > 0
  `;
  const byDate = await rowsOf<{
    business_date: string;
    cash: string;
    card: string;
    total: string;
    refunded: string;
    distributed: string | null;
  }>(
    context,
    sql`
      WITH tips AS (
        SELECT o.business_date,
               SUM(t.tip_amount) FILTER (WHERE t.tender_type = 'CASH') AS cash,
               SUM(t.tip_amount) FILTER (WHERE t.tender_type = 'EXTERNAL_CARD') AS card,
               SUM(t.tip_amount) AS total
        FROM settlement_tenders t
        JOIN order_settlements s ON s.id = t.settlement_id
        JOIN orders o ON o.id = s.order_id
        WHERE ${tipScope}
        GROUP BY o.business_date
      ), refunded AS (
        -- Phase 20 (policy 18): tips handed back, by the order's business date.
        SELECT o.business_date, SUM(r.tip_amount) AS refunded
        FROM order_refunds r
        JOIN orders o ON o.id = r.order_id
        WHERE o.location_id = ${filters.locationId}
          AND o.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND r.status = 'RECORDED' AND r.tip_amount > 0
        GROUP BY o.business_date
      ), finalized AS (
        SELECT business_date, pool_total
        FROM tip_distributions
        WHERE location_id = ${filters.locationId} AND status = 'FINALIZED'
          AND business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
      )
      SELECT COALESCE(tips.business_date, finalized.business_date)::text AS business_date,
             COALESCE(tips.cash, 0)::numeric(12,2)::text AS cash,
             COALESCE(tips.card, 0)::numeric(12,2)::text AS card,
             COALESCE(tips.total, 0)::numeric(12,2)::text AS total,
             COALESCE(refunded.refunded, 0)::numeric(12,2)::text AS refunded,
             finalized.pool_total::text AS distributed
      FROM tips
      FULL JOIN finalized ON finalized.business_date = tips.business_date
      LEFT JOIN refunded ON refunded.business_date = COALESCE(tips.business_date, finalized.business_date)
      ORDER BY 1
    `,
  );
  const byServer = await rowsOf<{ employee_number: string | null; name: string | null; checks: number; tips: string }>(
    context,
    sql`
      SELECT e.employee_number,
             COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name AS name,
             COUNT(DISTINCT o.id)::int AS checks,
             SUM(t.tip_amount)::numeric(12,2)::text AS tips
      FROM settlement_tenders t
      JOIN order_settlements s ON s.id = t.settlement_id
      JOIN orders o ON o.id = s.order_id
      LEFT JOIN employees e ON e.id = o.assigned_server_employee_id
      WHERE ${tipScope}
        ${filters.employeeId ? sql`AND o.assigned_server_employee_id = ${filters.employeeId}` : sql``}
      GROUP BY e.id, e.employee_number, e.preferred_name, e.first_name, e.last_name
      ORDER BY e.employee_number NULLS LAST
    `,
  );
  // Phase 20 (policy 20): what employees declared they kept in cash. Never in the pool.
  const declared = await rowsOf<{
    business_date: string;
    employee_number: string;
    name: string;
    amount: string;
    note: string | null;
  }>(
    context,
    sql`
      SELECT d.business_date::text AS business_date, e.employee_number,
             COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name AS name,
             d.amount::text AS amount, d.note
      FROM tip_declarations d
      JOIN employees e ON e.id = d.employee_id
      WHERE d.location_id = ${filters.locationId}
        AND d.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        ${filters.employeeId ? sql`AND d.employee_id = ${filters.employeeId}` : sql``}
      ORDER BY d.business_date, e.employee_number
    `,
  );
  const shares = await rowsOf<{
    business_date: string;
    employee_number: string;
    name: string;
    position_code: string;
    worked_hours: string;
    points: string;
    share: string;
  }>(
    context,
    sql`
      SELECT d.business_date::text AS business_date, e.employee_number,
             COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name AS name,
             l.position_code_snapshot AS position_code, l.worked_hours::text AS worked_hours,
             l.points::text AS points, l.share::text AS share
      FROM tip_distribution_lines l
      JOIN tip_distributions d ON d.id = l.distribution_id
      JOIN employees e ON e.id = l.employee_id
      WHERE d.location_id = ${filters.locationId} AND d.status = 'FINALIZED'
        AND d.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
        ${filters.employeeId ? sql`AND l.employee_id = ${filters.employeeId}` : sql``}
      ORDER BY d.business_date, e.employee_number, l.position_code_snapshot
    `,
  );

  return [
    {
      key: "byDate",
      title: "Tips by business date",
      description:
        "Distributed is the finalized pool. A date marked as changed had tips recorded after it was finalized: void and finalize it again.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "cashTips", label: "Cash tips", kind: "money" },
        { key: "cardTips", label: "Card tips", kind: "money" },
        { key: "tips", label: "Total tips", kind: "money" },
        { key: "refunded", label: "Tips refunded", kind: "money" },
        { key: "pool", label: "Pool (after refunds)", kind: "money" },
        { key: "distributed", label: "Distributed", kind: "money" },
        { key: "status", label: "Status", kind: "text" },
      ],
      rows: byDate.map((row) => ({
        businessDate: row.business_date,
        cashTips: row.cash,
        cardTips: row.card,
        tips: row.total,
        refunded: row.refunded,
        pool: toScale(subtractDecimals(row.total, row.refunded), 2),
        distributed: row.distributed,
        status:
          row.distributed === null
            ? "Not distributed"
            : row.distributed === toScale(subtractDecimals(row.total, row.refunded), 2)
              ? "Finalized"
              : "Changed after finalizing",
      })),
    },
    {
      key: "byServer",
      title: "Direct tips by server",
      description: "The server assigned to each closed check. These are the tips as recorded, before pooling.",
      columns: [
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Server", kind: "text" },
        { key: "checks", label: "Checks with tips", kind: "count" },
        { key: "tips", label: "Tips", kind: "money" },
      ],
      rows: byServer.map((row) => ({
        employeeNumber: row.employee_number,
        employee: row.name ?? "No server",
        checks: row.checks,
        tips: row.tips,
      })),
    },
    {
      key: "shares",
      title: "Finalized tip shares",
      description: "From finalized distributions: hours × position points. Record only; nothing is paid out.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Employee", kind: "text" },
        { key: "position", label: "Position", kind: "text" },
        { key: "workedHours", label: "Worked hours", kind: "hours" },
        { key: "points", label: "Points", kind: "text" },
        { key: "share", label: "Share", kind: "money" },
      ],
      rows: shares.map((row) => ({
        businessDate: row.business_date,
        employeeNumber: row.employee_number,
        employee: row.name,
        position: row.position_code,
        workedHours: row.worked_hours,
        points: row.points,
        share: row.share,
      })),
    },
    {
      key: "declared",
      title: "Declared cash tips",
      description:
        "Cash tips employees say they kept, by business date. Record only: never part of the pool and never paid out.",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Employee", kind: "text" },
        { key: "amount", label: "Declared", kind: "money" },
        { key: "note", label: "Note", kind: "text" },
      ],
      rows: declared.map((row) => ({
        businessDate: row.business_date,
        employeeNumber: row.employee_number,
        employee: row.name,
        amount: row.amount,
        note: row.note,
      })),
    },
  ];
}
