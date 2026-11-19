import { sql } from "drizzle-orm";

import { findWorkedEntries, type WorkedEntry } from "@/modules/scheduling/queries/worked-time";
import { DEFAULT_RULE_ROW, weekStartOf } from "@/modules/scheduling/rules/schedule-rules";
import { allocateOvertime, hoursToSeconds } from "@/modules/scheduling/rules/time-clock";

import type { PayrollDeclaration, PayrollEntry, PayrollTipShare } from "../rules/payroll-hours";
import { rowsOf, type ReportContext } from "./report-context";

// Phase 28 payroll hours facts (policy 9), read-only. Hours come from the time clock through
// the same Phase 18/20 overtime split as the actual labor report (daily first, then weekly,
// over whole weeks). Tips are finalized pool shares and declared cash tips, never wages.

export type PayrollFacts = {
  weekStartDay: number;
  entries: PayrollEntry[];
  /** OPEN entries in the range: the export is refused while any exist (policy 9). */
  openEntries: { employeeNumber: string; businessDate: string }[];
  employees: Map<string, { number: string; name: string }>;
  positions: Map<string, string>;
  tips: { shares: PayrollTipShare[]; declarations: PayrollDeclaration[]; finalizedDates: Set<string> };
};

export async function loadWeekStartDay(context: ReportContext): Promise<number> {
  const [rules] = await rowsOf<{ week_start_day: number }>(
    context,
    sql`SELECT week_start_day FROM scheduling_rules WHERE location_id = ${context.filters.locationId}`,
  );

  return rules?.week_start_day ?? DEFAULT_RULE_ROW.weekStartDay;
}

export async function loadPayrollFacts(context: ReportContext): Promise<PayrollFacts> {
  const { filters } = context;
  const [rules] = await rowsOf<{ threshold: string; daily: string | null; week_start_day: number }>(
    context,
    sql`SELECT weekly_overtime_threshold::text AS threshold, daily_overtime_threshold::text AS daily, week_start_day
        FROM scheduling_rules WHERE location_id = ${filters.locationId}`,
  );
  const weekStartDay = rules?.week_start_day ?? DEFAULT_RULE_ROW.weekStartDay;
  const thresholdSeconds = hoursToSeconds(rules?.threshold ?? DEFAULT_RULE_ROW.weeklyOvertimeThreshold);
  const dailySeconds = rules?.daily ? hoursToSeconds(rules.daily) : null;
  // The range is whole weeks (amendment 4), so every week's overtime is complete here.
  const all = await findWorkedEntries(context.tx, { locationId: filters.locationId, from: filters.from, to: filters.to });
  const weeks = new Map<string, WorkedEntry[]>();

  for (const entry of all.filter((row) => row.status === "CLOSED")) {
    const key = `${entry.employeeId}\u0000${weekStartOf(entry.businessDate, weekStartDay)}`;

    weeks.set(key, [...(weeks.get(key) ?? []), entry]);
  }

  const split = new Map<string, { regularSeconds: number; overtimeSeconds: number }>();

  for (const entries of weeks.values()) {
    for (const [id, value] of allocateOvertime(entries, thresholdSeconds, dailySeconds)) {
      split.set(id, value);
    }
  }

  const [shares, declarations, finalized] = await Promise.all([
    rowsOf<{ employee_id: string; position_id: string; business_date: string; share: string }>(
      context,
      sql`SELECT l.employee_id, l.position_id, d.business_date::text AS business_date, l.share::text AS share
          FROM tip_distribution_lines l
          JOIN tip_distributions d ON d.id = l.distribution_id AND d.status = 'FINALIZED'
          WHERE d.location_id = ${filters.locationId}
            AND d.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date`,
    ),
    rowsOf<{ employee_id: string; business_date: string; amount: string }>(
      context,
      sql`SELECT employee_id, business_date::text AS business_date, amount::text AS amount
          FROM tip_declarations
          WHERE location_id = ${filters.locationId}
            AND business_date BETWEEN ${filters.from}::date AND ${filters.to}::date`,
    ),
    rowsOf<{ business_date: string }>(
      context,
      sql`SELECT business_date::text AS business_date FROM tip_distributions
          WHERE location_id = ${filters.locationId} AND status = 'FINALIZED'
            AND business_date BETWEEN ${filters.from}::date AND ${filters.to}::date`,
    ),
  ]);
  const employeeIds = [
    ...new Set([...all.map((entry) => entry.employeeId), ...shares.map((row) => row.employee_id), ...declarations.map((row) => row.employee_id)]),
  ];
  const positionIds = [...new Set([...all.map((entry) => entry.positionId), ...shares.map((row) => row.position_id)])];
  const people =
    employeeIds.length === 0
      ? []
      : await rowsOf<{ id: string; employee_number: string; name: string }>(
          context,
          sql`SELECT id, employee_number, COALESCE(preferred_name, first_name) || ' ' || last_name AS name
              FROM employees WHERE id IN (${sql.join(employeeIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
        );
  const positionRows =
    positionIds.length === 0
      ? []
      : await rowsOf<{ id: string; code: string }>(
          context,
          sql`SELECT id, code FROM positions WHERE id IN (${sql.join(positionIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
        );
  const employees = new Map(people.map((row) => [row.id, { number: row.employee_number, name: row.name }]));

  return {
    weekStartDay,
    entries: all
      .filter((entry) => entry.status === "CLOSED")
      .map((entry) => ({
        employeeId: entry.employeeId,
        positionId: entry.positionId,
        businessDate: entry.businessDate,
        ...split.get(entry.id)!,
      })),
    openEntries: all
      .filter((entry) => entry.status === "OPEN")
      .map((entry) => ({ employeeNumber: employees.get(entry.employeeId)?.number ?? "", businessDate: entry.businessDate }))
      .sort((left, right) => left.businessDate.localeCompare(right.businessDate) || left.employeeNumber.localeCompare(right.employeeNumber)),
    employees,
    positions: new Map(positionRows.map((row) => [row.id, row.code])),
    tips: {
      shares: shares.map((row) => ({
        employeeId: row.employee_id,
        positionId: row.position_id,
        businessDate: row.business_date,
        share: row.share,
      })),
      declarations: declarations.map((row) => ({
        employeeId: row.employee_id,
        businessDate: row.business_date,
        amount: row.amount,
      })),
      finalizedDates: new Set(finalized.map((row) => row.business_date)),
    },
  };
}
