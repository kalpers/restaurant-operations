import { addDecimals, divideRoundHalfUp } from "@/shared/decimal/decimal";
import { addDays } from "@/shared/time/zoned-time";

// Phase 28 payroll hours file (policy 9, amendments 3 and 4). Pure. One row per employee,
// position and overtime week, with hours to two places, from the same per-entry overtime split
// the actual labor report uses. Never a rate, wage or pay amount: payroll stays out of scope.

export const MAXIMUM_PAYROLL_WEEKS = 6;

/** Amendment 4: the range must be whole overtime weeks, 1 to 6 of them. */
export function wholeWeeks(from: string, to: string, weekStartOf: (date: string) => string): number | null {
  if (weekStartOf(from) !== from || to < from) {
    return null;
  }

  for (let weeks = 1; weeks <= MAXIMUM_PAYROLL_WEEKS; weeks += 1) {
    if (addDays(from, weeks * 7 - 1) === to) {
      return weeks;
    }
  }

  return null;
}

export type PayrollEntry = {
  employeeId: string;
  positionId: string;
  businessDate: string;
  regularSeconds: number;
  overtimeSeconds: number;
};

export type PayrollTipShare = { employeeId: string; positionId: string; businessDate: string; share: string };

export type PayrollDeclaration = { employeeId: string; businessDate: string; amount: string };

export type PayrollRow = {
  weekStart: string;
  employeeNumber: string;
  employee: string;
  positionCode: string;
  regularHours: string;
  overtimeHours: string;
  totalHours: string;
  tipShare?: string;
  declaredTips?: string;
  tipsFinalized?: "YES" | "NO";
};

export type PayrollInput = {
  entries: readonly PayrollEntry[];
  weekStartOf: (date: string) => string;
  employees: ReadonlyMap<string, { number: string; name: string }>;
  positions: ReadonlyMap<string, string>;
  /** Present only for holders of `reports.tips` or `tips.manage`. */
  tips: {
    shares: readonly PayrollTipShare[];
    declarations: readonly PayrollDeclaration[];
    finalizedDates: ReadonlySet<string>;
  } | null;
};

const hours = (seconds: number) => divideRoundHalfUp(String(seconds), "3600", 2);

type Accumulator = {
  employeeId: string;
  positionId: string | null;
  weekStart: string;
  regularSeconds: number;
  overtimeSeconds: number;
  tipShare: string;
  declared: string;
  dates: Set<string>;
};

export function buildPayrollRows(input: PayrollInput): PayrollRow[] {
  const rows = new Map<string, Accumulator>();
  const rowFor = (employeeId: string, positionId: string | null, weekStart: string) => {
    const key = `${employeeId}\u0000${positionId ?? ""}\u0000${weekStart}`;
    const row = rows.get(key) ?? {
      employeeId,
      positionId,
      weekStart,
      regularSeconds: 0,
      overtimeSeconds: 0,
      tipShare: "0.00",
      declared: "0.00",
      dates: new Set<string>(),
    };

    rows.set(key, row);

    return row;
  };

  for (const entry of input.entries) {
    const row = rowFor(entry.employeeId, entry.positionId, input.weekStartOf(entry.businessDate));

    row.regularSeconds += entry.regularSeconds;
    row.overtimeSeconds += entry.overtimeSeconds;
    row.dates.add(entry.businessDate);
  }

  if (input.tips) {
    for (const share of input.tips.shares) {
      const row = rowFor(share.employeeId, share.positionId, input.weekStartOf(share.businessDate));

      row.tipShare = addDecimals(row.tipShare, share.share);
    }

    // Amendment 3: declared tips have no position, so they go on the employee's row with the
    // most hours that week (ties: position code).
    for (const declaration of input.tips.declarations) {
      const weekStart = input.weekStartOf(declaration.businessDate);
      const candidates = [...rows.values()]
        .filter((row) => row.employeeId === declaration.employeeId && row.weekStart === weekStart && row.positionId !== null)
        .sort(
          (left, right) =>
            right.regularSeconds + right.overtimeSeconds - (left.regularSeconds + left.overtimeSeconds) ||
            (input.positions.get(left.positionId!) ?? "").localeCompare(input.positions.get(right.positionId!) ?? ""),
        );
      const row = candidates[0] ?? rowFor(declaration.employeeId, null, weekStart);

      row.declared = addDecimals(row.declared, declaration.amount);
      row.dates.add(declaration.businessDate);
    }
  }

  return [...rows.values()]
    .map((row) => {
      const regularHours = hours(row.regularSeconds);
      const overtimeHours = hours(row.overtimeSeconds);
      const person = input.employees.get(row.employeeId) ?? { number: "", name: "" };

      return {
        weekStart: row.weekStart,
        employeeNumber: person.number,
        employee: person.name,
        positionCode: row.positionId ? (input.positions.get(row.positionId) ?? "") : "",
        regularHours,
        overtimeHours,
        totalHours: addDecimals(regularHours, overtimeHours),
        ...(input.tips
          ? {
              tipShare: addDecimals(row.tipShare, "0.00"),
              declaredTips: addDecimals(row.declared, "0.00"),
              tipsFinalized: [...row.dates].every((date) => input.tips!.finalizedDates.has(date))
                ? ("YES" as const)
                : ("NO" as const),
            }
          : {}),
      };
    })
    .sort(
      (left, right) =>
        left.weekStart.localeCompare(right.weekStart) ||
        left.employeeNumber.localeCompare(right.employeeNumber) ||
        left.positionCode.localeCompare(right.positionCode),
    );
}
