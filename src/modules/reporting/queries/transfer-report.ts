import { sql } from "drizzle-orm";

import type { ReportColumn, ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";

// Phase 23 (policy 14, amendment 3): stock sent from this location that hadn't been received
// at the end of the range. It has left this location's ledger and not yet entered the other,
// so it is shown here at the cost frozen when it was sent. Read from transfer history.

export async function inTransitSection(context: ReportContext): Promise<ReportSection> {
  const zone = context.settings.timeZone;
  const rows = await rowsOf<{
    transfer_number: string;
    to_location: string;
    sent: string;
    lines: number;
    value: string | null;
  }>(
    context,
    sql`
      SELECT t.transfer_number, l.name AS to_location,
             to_char(t.sent_at AT TIME ZONE ${zone}, 'YYYY-MM-DD HH24:MI') AS sent,
             count(tl.id)::int AS lines,
             CASE WHEN bool_and(tl.unit_cost_sent IS NOT NULL)
                  THEN sum(round(tl.base_quantity * tl.unit_cost_sent, 4))::numeric(14,4)::text END AS value
      FROM inventory_transfers t
      JOIN locations l ON l.id = t.to_location_id
      JOIN inventory_transfer_lines tl ON tl.transfer_id = t.id
      WHERE t.from_location_id = ${context.filters.locationId}
        AND t.sent_at < ${context.end}::timestamptz
        AND (t.received_at IS NULL OR t.received_at >= ${context.end}::timestamptz)
      GROUP BY t.id, l.name
      ORDER BY t.sent_at, t.transfer_number
    `,
  );
  const columns: ReportColumn[] = [
    { key: "transferNumber", label: "Transfer", kind: "text" },
    { key: "toLocation", label: "To", kind: "text" },
    { key: "sent", label: "Sent", kind: "text" },
    { key: "lines", label: "Items", kind: "count" },
    ...(context.canViewCost ? [{ key: "value", label: "Value in transit", kind: "cost" } as ReportColumn] : []),
  ];

  return {
    key: "in-transit",
    title: "In transit",
    description: "Transfers sent from here and not yet received at the end of the range, valued at the cost when sent.",
    columns,
    rows: rows.map((row) => ({
      transferNumber: row.transfer_number,
      toLocation: row.to_location,
      sent: row.sent,
      lines: row.lines,
      ...(context.canViewCost ? { value: row.value } : {}),
    })),
  };
}
