import { sql } from "drizzle-orm";

import {
  addLabor,
  emptyLaborTotals,
  percentOf,
  shiftLabor,
  type EffectiveCompensation,
  type LaborTotals,
} from "../rules/labor-cost";
import type { ReportColumn, ReportRow, ReportSection } from "../types";

import { rowsOf, type ReportContext } from "./report-context";
import { netSalesTotal } from "./sales-report";

type AssignmentRow = {
  shift_date: string;
  position_code: string;
  position_name: string;
  employee_id: string;
  employee_number: string;
  employee_name: string;
  seconds: number;
  compensation_type: "HOURLY" | "SALARY" | null;
  hourly_rate: string | null;
};

function compensationOf(row: AssignmentRow): EffectiveCompensation {
  if (row.compensation_type === "HOURLY" && row.hourly_rate !== null) {
    return { compensationType: "HOURLY", hourlyRate: row.hourly_rate };
  }

  return row.compensation_type === "SALARY" ? { compensationType: "SALARY" } : null;
}

function accumulate<Key>(map: Map<Key, LaborTotals>, key: Key, row: AssignmentRow): void {
  map.set(key, addLabor(map.get(key) ?? emptyLaborTotals(), shiftLabor(row.seconds, compensationOf(row))));
}

const TOTAL_COLUMNS: ReportColumn[] = [
  { key: "shifts", label: "Assigned shifts", kind: "count" },
  { key: "hours", label: "Scheduled hours", kind: "hours" },
  { key: "cost", label: "Hourly labor cost", kind: "money" },
  { key: "salariedHours", label: "Salaried hours (not costed)", kind: "hours" },
  { key: "noRateHours", label: "Hours with no rate", kind: "hours" },
];

function totalsRow(totals: LaborTotals): ReportRow {
  return { ...totals };
}

/**
 * Scheduled labor (approved Phase 12 policy). Assignments come from PUBLISHED schedules
 * (and ARCHIVED ones, which were published), ACTIVE assignments only, non-cancelled shifts,
 * by `shift_date`. Each is costed at the HOURLY rate in effect on the shift date for that
 * Employee and the Position worked (`employee_position_compensation`, effective dates
 * inclusive). Salaried work and work with no rate are hours only. There is no time clock,
 * so this is scheduled labor, not actual hours worked.
 */
export async function laborSections(context: ReportContext): Promise<ReportSection[]> {
  const { filters } = context;
  const scope = sql`
    sh.location_id = ${filters.locationId}
    AND sh.shift_date BETWEEN ${filters.from}::date AND ${filters.to}::date
    AND sh.cancelled_at IS NULL
    AND sp.status IN ('PUBLISHED', 'ARCHIVED')
  `;

  const assignments = await rowsOf<AssignmentRow>(
    context,
    sql`
      SELECT sh.shift_date::text AS shift_date, p.code AS position_code, p.name AS position_name,
             e.id AS employee_id, e.employee_number,
             COALESCE(e.preferred_name, e.first_name) || ' ' || e.last_name AS employee_name,
             EXTRACT(EPOCH FROM sh.end_at - sh.start_at)::int AS seconds,
             c.compensation_type, c.hourly_rate::text AS hourly_rate
      FROM shifts sh
      JOIN schedule_periods sp ON sp.id = sh.schedule_period_id
      JOIN shift_assignments a ON a.shift_id = sh.id AND a.status = 'ACTIVE'
      JOIN employees e ON e.id = a.employee_id
      JOIN positions p ON p.id = sh.position_id
      LEFT JOIN LATERAL (
        SELECT epc.compensation_type, epc.hourly_rate
        FROM employee_position_compensation epc
        WHERE epc.employee_id = a.employee_id
          AND epc.position_id = sh.position_id
          AND epc.effective_from <= sh.shift_date
          AND (epc.effective_to IS NULL OR epc.effective_to >= sh.shift_date)
        ORDER BY epc.effective_from DESC
        LIMIT 1
      ) c ON true
      WHERE ${scope}
        ${filters.employeeId ? sql`AND a.employee_id = ${filters.employeeId}` : sql``}
      ORDER BY sh.shift_date, p.name, e.employee_number
    `,
  );

  const coverage = await rowsOf<{
    shift_date: string;
    position_name: string;
    shifts: number;
    required: number;
    assigned: number;
    unfilled: number;
  }>(
    context,
    sql`
      WITH per_shift AS (
        SELECT sh.shift_date, p.name AS position_name, COALESCE(sh.required_employee_count, 0) AS required,
               (SELECT COUNT(*) FROM shift_assignments a WHERE a.shift_id = sh.id AND a.status = 'ACTIVE') AS assigned
        FROM shifts sh
        JOIN schedule_periods sp ON sp.id = sh.schedule_period_id
        JOIN positions p ON p.id = sh.position_id
        WHERE ${scope}
      )
      SELECT shift_date::text AS shift_date, position_name, COUNT(*)::int AS shifts,
             SUM(required)::int AS required, SUM(assigned)::int AS assigned,
             SUM(GREATEST(required - assigned, 0))::int AS unfilled
      FROM per_shift
      GROUP BY shift_date, position_name
      ORDER BY shift_date, position_name
    `,
  );

  const byDatePosition = new Map<string, LaborTotals>();
  const byPosition = new Map<string, LaborTotals>();
  const byEmployee = new Map<string, LaborTotals>();
  const employees = new Map<string, { number: string; name: string }>();
  let total = emptyLaborTotals();

  for (const row of assignments) {
    accumulate(byDatePosition, `${row.shift_date}\u0000${row.position_name}`, row);
    accumulate(byPosition, row.position_name, row);
    accumulate(byEmployee, row.employee_id, row);
    employees.set(row.employee_id, { number: row.employee_number, name: row.employee_name });
    total = addLabor(total, shiftLabor(row.seconds, compensationOf(row)));
  }

  const notes: string[] = [];
  let laborPercent: string | null = null;

  if (context.canViewSales) {
    const netSales = await netSalesTotal(context);

    laborPercent = percentOf(total.cost, netSales);
    notes.push(`Net sales ${netSales}; hourly labor cost ${total.cost}.`);
  }

  const employeeColumns: ReportColumn[] = [
    { key: "employeeNumber", label: "Employee number", kind: "text" },
    { key: "employee", label: "Employee", kind: "text" },
    { key: "shifts", label: "Assigned shifts", kind: "count" },
    { key: "hours", label: "Scheduled hours", kind: "hours" },
    ...(context.canViewCompensation
      ? ([{ key: "cost", label: "Hourly labor cost", kind: "money" }] as ReportColumn[])
      : []),
    { key: "salariedHours", label: "Salaried hours (not costed)", kind: "hours" },
    { key: "noRateHours", label: "Hours with no rate", kind: "hours" },
  ];

  return [
    {
      key: "summary",
      title: "Scheduled labor",
      description: [
        "From published schedules: scheduled hours, not clocked time. Cost uses each employee's hourly rate for the position worked, in effect on the shift date.",
        ...notes,
      ].join(" "),
      columns: [
        ...TOTAL_COLUMNS,
        ...(context.canViewSales
          ? ([{ key: "laborPercent", label: "Labor % of net sales", kind: "percent" }] as ReportColumn[])
          : []),
      ],
      rows: [
        {
          ...totalsRow(total),
          ...(context.canViewSales ? { laborPercent } : {}),
        },
      ],
    },
    {
      key: "positions",
      title: "By position",
      columns: [{ key: "position", label: "Position", kind: "text" }, ...TOTAL_COLUMNS],
      rows: [...byPosition.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([position, totals]) => ({ position, ...totalsRow(totals) })),
    },
    {
      key: "daily",
      title: "By business date and position",
      columns: [
        { key: "businessDate", label: "Shift date", kind: "date" },
        { key: "position", label: "Position", kind: "text" },
        ...TOTAL_COLUMNS,
      ],
      rows: [...byDatePosition.entries()].map(([key, totals]) => {
        const [businessDate, position] = key.split("\u0000");

        return { businessDate: businessDate!, position: position!, ...totalsRow(totals) };
      }),
    },
    {
      key: "employees",
      title: "By employee",
      description: context.canViewCompensation
        ? undefined
        : "Per-employee cost needs the compensation-view permission.",
      columns: employeeColumns,
      rows: [...byEmployee.entries()]
        .map(([employeeId, totals]) => {
          const employee = employees.get(employeeId)!;
          const row: ReportRow = {
            employeeNumber: employee.number,
            employee: employee.name,
            shifts: totals.shifts,
            hours: totals.hours,
            salariedHours: totals.salariedHours,
            noRateHours: totals.noRateHours,
          };

          return context.canViewCompensation ? { ...row, cost: totals.cost } : row;
        })
        .sort((left, right) => String(left.employeeNumber).localeCompare(String(right.employeeNumber))),
    },
    {
      key: "coverage",
      title: "Schedule coverage",
      description: "Employees required by each shift against ACTIVE assignments.",
      columns: [
        { key: "businessDate", label: "Shift date", kind: "date" },
        { key: "position", label: "Position", kind: "text" },
        { key: "shifts", label: "Shifts", kind: "count" },
        { key: "required", label: "Required", kind: "count" },
        { key: "assigned", label: "Assigned", kind: "count" },
        { key: "unfilled", label: "Unfilled", kind: "count" },
      ],
      rows: coverage.map((row) => ({
        businessDate: row.shift_date,
        position: row.position_name,
        shifts: row.shifts,
        required: row.required,
        assigned: row.assigned,
        unfilled: row.unfilled,
      })),
    },
  ];
}
