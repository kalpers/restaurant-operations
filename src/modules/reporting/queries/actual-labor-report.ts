import { sql } from "drizzle-orm";

import { findWorkedEntries, type WorkedEntry } from "@/modules/scheduling/queries/worked-time";
import { DEFAULT_RULE_ROW, weekStartOf } from "@/modules/scheduling/rules/schedule-rules";
import { allocateOvertime, entryFlags, hoursToSeconds } from "@/modules/scheduling/rules/time-clock";
import { addDecimals, divideRoundHalfUp, multiplyExact } from "@/shared/decimal/decimal";
import { businessDateOf } from "@/shared/time/business-date-service";
import { addDays } from "@/shared/time/zoned-time";

import { percentOf, secondsToHours } from "../rules/labor-cost";
import type { ReportColumn, ReportRow, ReportSection } from "../types";

import { compensationAt } from "./compensation-at";
import { rowsOf, type ReportContext } from "./report-context";
import { netSalesTotal } from "./sales-report";

// Phase 18 actual labor (approved policies B13-B16, C18-C20). From CLOSED time entries by
// business date: worked time minus unpaid breaks, weekly overtime allocated over whole weeks
// (so a date's figures don't depend on the range), each entry costed at the HOURLY rate in
// effect on its business date for the Employee and the Position worked. Every cost figure needs
// `hr.compensation.view` (Phase 12 wage privacy). Reporting is read-only.

type Totals = {
  entries: number;
  workedSeconds: number;
  regularSeconds: number;
  overtimeSeconds: number;
  regularCost: string;
  overtimeCost: string;
  salariedSeconds: number;
  noRateSeconds: number;
};

const empty = (): Totals => ({
  entries: 0,
  workedSeconds: 0,
  regularSeconds: 0,
  overtimeSeconds: 0,
  regularCost: "0.00",
  overtimeCost: "0.00",
  salariedSeconds: 0,
  noRateSeconds: 0,
});

type Costed = {
  entry: WorkedEntry;
  regularSeconds: number;
  overtimeSeconds: number;
  basis: "HOURLY" | "SALARIED" | "NO_RATE";
  regularCost: string;
  overtimeCost: string;
};

function add(totals: Totals, costed: Costed): Totals {
  return {
    entries: totals.entries + 1,
    workedSeconds: totals.workedSeconds + costed.entry.workedSeconds,
    regularSeconds: totals.regularSeconds + costed.regularSeconds,
    overtimeSeconds: totals.overtimeSeconds + costed.overtimeSeconds,
    regularCost: addDecimals(totals.regularCost, costed.regularCost),
    overtimeCost: addDecimals(totals.overtimeCost, costed.overtimeCost),
    salariedSeconds: totals.salariedSeconds + (costed.basis === "SALARIED" ? costed.entry.workedSeconds : 0),
    noRateSeconds: totals.noRateSeconds + (costed.basis === "NO_RATE" ? costed.entry.workedSeconds : 0),
  };
}

function totalColumns(canViewCost: boolean): ReportColumn[] {
  return [
    { key: "entries", label: "Time entries", kind: "count" },
    { key: "workedHours", label: "Worked hours", kind: "hours" },
    { key: "regularHours", label: "Regular hours", kind: "hours" },
    { key: "overtimeHours", label: "Overtime hours", kind: "hours" },
    ...(canViewCost
      ? ([
          { key: "regularCost", label: "Regular cost", kind: "money" },
          { key: "overtimeCost", label: "Overtime cost", kind: "money" },
          { key: "totalCost", label: "Actual labor cost", kind: "money" },
        ] as ReportColumn[])
      : []),
    { key: "salariedHours", label: "Salaried hours (not costed)", kind: "hours" },
    { key: "noRateHours", label: "Hours with no rate", kind: "hours" },
  ];
}

function totalsRow(totals: Totals, canViewCost: boolean): ReportRow {
  return {
    entries: totals.entries,
    workedHours: secondsToHours(totals.workedSeconds),
    regularHours: secondsToHours(totals.regularSeconds),
    overtimeHours: secondsToHours(totals.overtimeSeconds),
    ...(canViewCost
      ? {
          regularCost: totals.regularCost,
          overtimeCost: totals.overtimeCost,
          totalCost: addDecimals(totals.regularCost, totals.overtimeCost),
        }
      : {}),
    salariedHours: secondsToHours(totals.salariedSeconds),
    noRateHours: secondsToHours(totals.noRateSeconds),
  };
}

export async function actualLaborSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const [rules] = await rowsOf<{
    threshold: string;
    daily: string | null;
    week_start_day: number;
    multiplier: string;
    grace: number;
  }>(
    context,
    sql`SELECT weekly_overtime_threshold::text AS threshold, daily_overtime_threshold::text AS daily, week_start_day,
               overtime_multiplier::text AS multiplier, late_clock_in_grace_minutes AS grace
        FROM scheduling_rules WHERE location_id = ${filters.locationId}`,
  );
  // Phase 20 (policy 19): optional daily overtime, counted before the weekly line.
  const dailySeconds = rules?.daily ? hoursToSeconds(rules.daily) : null;
  const threshold = rules?.threshold ?? DEFAULT_RULE_ROW.weeklyOvertimeThreshold;
  const weekStartDay = rules?.week_start_day ?? DEFAULT_RULE_ROW.weekStartDay;
  const multiplier = rules?.multiplier ?? DEFAULT_RULE_ROW.overtimeMultiplier;
  const grace = rules?.grace ?? DEFAULT_RULE_ROW.lateClockInGraceMinutes;
  const thresholdSeconds = hoursToSeconds(threshold);
  const weekFrom = weekStartOf(filters.from, weekStartDay);
  const weekTo = addDays(weekStartOf(filters.to, weekStartDay), 6);
  const employeeIds = filters.employeeId ? [filters.employeeId] : undefined;
  const all = await findWorkedEntries(context.tx, {
    locationId: filters.locationId,
    from: weekFrom,
    to: weekTo,
    employeeIds,
  });
  const inRange = (date: string) => date >= filters.from && date <= filters.to;

  // Policy B15/B16: overtime per employee and work week, over the whole week.
  const weeks = new Map<string, WorkedEntry[]>();

  for (const entry of all.filter((row) => row.status === "CLOSED")) {
    const weekKey = `${entry.employeeId}\u0000${weekStartOf(entry.businessDate, weekStartDay)}`;

    weeks.set(weekKey, [...(weeks.get(weekKey) ?? []), entry]);
  }

  const split = new Map<string, { regularSeconds: number; overtimeSeconds: number }>();

  for (const entries of weeks.values()) {
    for (const [id, value] of allocateOvertime(entries, thresholdSeconds, dailySeconds)) {
      split.set(id, value);
    }
  }

  const rates = new Map(
    (
      await rowsOf<{ id: string; compensation_type: "HOURLY" | "SALARY" | null; hourly_rate: string | null }>(
        context,
        sql`SELECT te.id, c.compensation_type, c.hourly_rate::text AS hourly_rate
            FROM time_entries te
            ${compensationAt(sql`te.employee_id`, sql`te.position_id`, sql`te.business_date`)}
            WHERE te.location_id = ${filters.locationId}
              AND te.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
              AND te.status = 'CLOSED'`,
      )
    ).map((row) => [row.id, row]),
  );
  const costed: Costed[] = all
    .filter((entry) => entry.status === "CLOSED" && inRange(entry.businessDate))
    .map((entry) => {
      const { regularSeconds, overtimeSeconds } = split.get(entry.id)!;
      const rate = rates.get(entry.id);

      if (rate?.compensation_type === "HOURLY" && rate.hourly_rate !== null) {
        return {
          entry,
          regularSeconds,
          overtimeSeconds,
          basis: "HOURLY" as const,
          regularCost: divideRoundHalfUp(multiplyExact(String(regularSeconds), rate.hourly_rate), "3600", 2),
          overtimeCost: divideRoundHalfUp(
            multiplyExact(multiplyExact(String(overtimeSeconds), rate.hourly_rate), multiplier),
            "3600",
            2,
          ),
        };
      }

      return {
        entry,
        regularSeconds,
        overtimeSeconds,
        basis: rate?.compensation_type === "SALARY" ? ("SALARIED" as const) : ("NO_RATE" as const),
        regularCost: "0.00",
        overtimeCost: "0.00",
      };
    });

  // Scheduled assignments in range, for scheduled vs. actual and no-shows.
  const assignments = await rowsOf<{
    id: string;
    employee_id: string;
    shift_date: string;
    start_at: Date;
    end_at: Date;
    seconds: number;
  }>(
    context,
    sql`SELECT a.id, a.employee_id, sh.shift_date::text AS shift_date, sh.start_at, sh.end_at,
               EXTRACT(EPOCH FROM sh.end_at - sh.start_at)::int AS seconds
        FROM shifts sh
        JOIN schedule_periods sp ON sp.id = sh.schedule_period_id
        JOIN shift_assignments a ON a.shift_id = sh.id AND a.status = 'ACTIVE'
        WHERE sh.location_id = ${filters.locationId}
          AND sh.shift_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          AND sh.cancelled_at IS NULL
          AND sp.status IN ('PUBLISHED', 'ARCHIVED')
          ${filters.employeeId ? sql`AND a.employee_id = ${filters.employeeId}` : sql``}`,
  );
  const shiftOf = new Map(
    assignments.map((row) => [row.id, { startAt: new Date(row.start_at), endAt: new Date(row.end_at) }]),
  );
  const linked = new Set(all.map((entry) => entry.shiftAssignmentId).filter((id): id is string => id !== null));
  const now = Date.now();
  const today = businessDateOf(new Date(), context.settings);

  // Exceptions: missed clock-outs, adjustments and voids in range.
  const adjustments = await rowsOf<{ business_date: string; employee_id: string; reason: string }>(
    context,
    sql`SELECT te.business_date::text AS business_date, te.employee_id, a.reason
        FROM time_entry_adjustments a
        JOIN time_entries te ON te.id = a.time_entry_id
        WHERE te.location_id = ${filters.locationId}
          AND te.business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          ${filters.employeeId ? sql`AND te.employee_id = ${filters.employeeId}` : sql``}
        ORDER BY a.adjusted_at`,
  );
  const voided = await rowsOf<{ business_date: string; employee_id: string; reason: string }>(
    context,
    sql`SELECT business_date::text AS business_date, employee_id, void_reason AS reason
        FROM time_entries
        WHERE location_id = ${filters.locationId} AND status = 'VOIDED'
          AND business_date BETWEEN ${filters.from}::date AND ${filters.to}::date
          ${filters.employeeId ? sql`AND employee_id = ${filters.employeeId}` : sql``}
        ORDER BY voided_at`,
  );
  const missed = all.filter((entry) => entry.status === "OPEN" && inRange(entry.businessDate) && entry.businessDate < today);

  const ids = [
    ...new Set([
      ...all.map((entry) => entry.employeeId),
      ...assignments.map((row) => row.employee_id),
      ...adjustments.map((row) => row.employee_id),
      ...voided.map((row) => row.employee_id),
    ]),
  ];
  const people = new Map(
    (ids.length === 0
      ? []
      : await rowsOf<{ id: string; employee_number: string; name: string }>(
          context,
          sql`SELECT id, employee_number, COALESCE(preferred_name, first_name) || ' ' || last_name AS name
              FROM employees WHERE id IN (${sql.join(
                ids.map((id) => sql`${id}::uuid`),
                sql`, `,
              )})`,
        )
    ).map((row) => [row.id, row]),
  );
  const numberOf = (id: string) => people.get(id)?.employee_number ?? "";
  const nameOf = (id: string) => people.get(id)?.name ?? "";

  // ---------------------------------------------------------------- totals
  const canViewCost = context.canViewCompensation;
  const showLaborPercent = context.canViewSales && canViewCost;
  let total = empty();
  const byEmployee = new Map<string, Totals>();

  for (const row of costed) {
    total = add(total, row);
    byEmployee.set(row.entry.employeeId, add(byEmployee.get(row.entry.employeeId) ?? empty(), row));
  }

  const summaryRow: ReportRow = totalsRow(total, canViewCost);

  if (showLaborPercent) {
    summaryRow.laborPercent = percentOf(addDecimals(total.regularCost, total.overtimeCost), await netSalesTotal(context));
  }

  // ---------------------------------------------------------------- scheduled vs actual
  type Comparison = {
    scheduledSeconds: number;
    workedSeconds: number;
    late: number;
    earlyOut: number;
    unscheduled: number;
    noShow: number;
    long: number;
  };
  const comparisons = new Map<string, Comparison>();
  const comparison = (date: string, employeeId: string) => {
    const comparisonKey = `${date}\u0000${employeeId}`;
    const value = comparisons.get(comparisonKey) ?? {
      scheduledSeconds: 0,
      workedSeconds: 0,
      late: 0,
      earlyOut: 0,
      unscheduled: 0,
      noShow: 0,
      long: 0,
    };

    comparisons.set(comparisonKey, value);

    return value;
  };

  for (const row of assignments) {
    const value = comparison(row.shift_date, row.employee_id);

    value.scheduledSeconds += row.seconds;

    if (!linked.has(row.id) && new Date(row.end_at).getTime() < now) {
      value.noShow += 1;
    }
  }

  for (const row of costed) {
    const value = comparison(row.entry.businessDate, row.entry.employeeId);
    const shift = row.entry.shiftAssignmentId ? (shiftOf.get(row.entry.shiftAssignmentId) ?? null) : null;
    const flags = entryFlags(row.entry, row.entry.shiftAssignmentId ? shift : null, grace);

    value.workedSeconds += row.entry.workedSeconds;
    value.late += flags.late ? 1 : 0;
    value.earlyOut += flags.earlyOut ? 1 : 0;
    value.unscheduled += row.entry.shiftAssignmentId === null ? 1 : 0;
    value.long += flags.long ? 1 : 0;
  }

  // ---------------------------------------------------------------- overtime by week
  const overtimeRows: ReportRow[] = [...weeks.entries()]
    .map(([weekKey, entries]) => {
      const [employeeId, weekStart] = weekKey.split("\u0000") as [string, string];
      const worked = entries.reduce((sum, entry) => sum + entry.workedSeconds, 0);

      return {
        employeeNumber: numberOf(employeeId),
        employee: nameOf(employeeId),
        weekStart,
        workedHours: secondsToHours(worked),
        thresholdHours: secondsToHours(thresholdSeconds),
        // Phase 20: daily and weekly overtime together, as allocated (each hour once).
        overtimeHours: secondsToHours(entries.reduce((sum, entry) => sum + (split.get(entry.id)?.overtimeSeconds ?? 0), 0)),
      };
    })
    .sort(
      (left, right) =>
        String(left.weekStart).localeCompare(String(right.weekStart)) ||
        String(left.employeeNumber).localeCompare(String(right.employeeNumber)),
    );

  const exceptionRows: ReportRow[] = [
    ...missed.map((entry) => ({
      businessDate: entry.businessDate,
      employeeNumber: numberOf(entry.employeeId),
      employee: nameOf(entry.employeeId),
      kind: "Missed clock-out",
      detail: "Still open: counts zero hours until a manager closes it.",
    })),
    ...adjustments.map((row) => ({
      businessDate: row.business_date,
      employeeNumber: numberOf(row.employee_id),
      employee: nameOf(row.employee_id),
      kind: "Adjusted",
      detail: row.reason,
    })),
    ...voided.map((row) => ({
      businessDate: row.business_date,
      employeeNumber: numberOf(row.employee_id),
      employee: nameOf(row.employee_id),
      kind: "Voided",
      detail: row.reason,
    })),
  ].sort(
    (left, right) =>
      left.businessDate.localeCompare(right.businessDate) || left.employeeNumber.localeCompare(right.employeeNumber),
  );

  const costNote = canViewCost
    ? `Overtime is hours past ${threshold} in a work week, costed at ${multiplier}× the hourly rate. These are your own settings, not a labor-law calculation.`
    : "Labor cost needs the compensation-view permission.";

  return [
    {
      key: "actual",
      title: "Actual labor",
      description: `From closed time entries: clocked hours minus unpaid breaks. ${costNote}`,
      columns: [
        ...totalColumns(canViewCost),
        ...(showLaborPercent ? ([{ key: "laborPercent", label: "Labor % of net sales", kind: "percent" }] as ReportColumn[]) : []),
      ],
      rows: [summaryRow],
    },
    {
      key: "actualEmployees",
      title: "Actual labor by employee",
      columns: [
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Employee", kind: "text" },
        ...totalColumns(canViewCost),
      ],
      rows: [...byEmployee.entries()]
        .map(([employeeId, totals]) => ({
          employeeNumber: numberOf(employeeId),
          employee: nameOf(employeeId),
          ...totalsRow(totals, canViewCost),
        }))
        .sort((left, right) => String(left.employeeNumber).localeCompare(String(right.employeeNumber))),
    },
    {
      key: "scheduledVsActual",
      title: "Scheduled vs. actual",
      description: `Late and early-out use a ${grace}-minute grace. A no-show is a past assignment with no time entry.`,
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Employee", kind: "text" },
        { key: "scheduledHours", label: "Scheduled hours", kind: "hours" },
        { key: "workedHours", label: "Worked hours", kind: "hours" },
        { key: "varianceHours", label: "Variance (hours)", kind: "hours" },
        { key: "late", label: "Late", kind: "count" },
        { key: "earlyOut", label: "Early out", kind: "count" },
        { key: "unscheduled", label: "Unscheduled", kind: "count" },
        { key: "noShow", label: "No-show", kind: "count" },
        { key: "long", label: "Over 16 h", kind: "count" },
      ],
      rows: [...comparisons.entries()]
        .map(([comparisonKey, value]) => {
          const [businessDate, employeeId] = comparisonKey.split("\u0000") as [string, string];

          return {
            businessDate,
            employeeNumber: numberOf(employeeId),
            employee: nameOf(employeeId),
            scheduledHours: secondsToHours(value.scheduledSeconds),
            workedHours: secondsToHours(value.workedSeconds),
            varianceHours: secondsToHours(value.workedSeconds - value.scheduledSeconds),
            late: value.late,
            earlyOut: value.earlyOut,
            unscheduled: value.unscheduled,
            noShow: value.noShow,
            long: value.long,
          };
        })
        .sort(
          (left, right) =>
            left.businessDate.localeCompare(right.businessDate) || left.employeeNumber.localeCompare(right.employeeNumber),
        ),
    },
    {
      key: "overtime",
      title: "Overtime by work week",
      description: "Whole work weeks touching the range, so a week's figures are the same whatever range is chosen.",
      columns: [
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Employee", kind: "text" },
        { key: "weekStart", label: "Week starting", kind: "date" },
        { key: "workedHours", label: "Worked hours", kind: "hours" },
        { key: "thresholdHours", label: "Threshold", kind: "hours" },
        { key: "overtimeHours", label: "Overtime hours", kind: "hours" },
      ],
      rows: overtimeRows,
    },
    {
      key: "exceptions",
      title: "Time clock exceptions",
      columns: [
        { key: "businessDate", label: "Business date", kind: "date" },
        { key: "employeeNumber", label: "Employee number", kind: "text" },
        { key: "employee", label: "Employee", kind: "text" },
        { key: "kind", label: "Exception", kind: "text" },
        { key: "detail", label: "Detail", kind: "text" },
      ],
      rows: exceptionRows,
    },
  ];
}
