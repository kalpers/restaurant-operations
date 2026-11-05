import { msToHours } from "../types";

export type CoverageShift = {
  id: string;
  shiftDate: string;
  positionId: string;
  positionName: string;
  restaurantAreaId: string | null;
  restaurantAreaName: string | null;
  requiredEmployeeCount: number;
  assignedCount: number;
};

export type CoverageLine = {
  key: string;
  label: string;
  required: number;
  filled: number;
  open: number;
};

export type EmployeeWeekHours = {
  employeeId: string;
  displayName: string;
  weekStart: string;
  scheduledMs: number;
  targetMs: number | null;
  minimumMs: number | null;
  maximumMs: number | null;
};

export type CoverageWarning = {
  code: string;
  employeeId?: string;
  shiftId?: string;
  message: string;
};

function addLine(
  lines: Map<string, CoverageLine>,
  key: string,
  label: string,
  shift: CoverageShift,
) {
  const filled = Math.min(shift.assignedCount, shift.requiredEmployeeCount);
  const line = lines.get(key) ?? { key, label, required: 0, filled: 0, open: 0 };

  line.required += shift.requiredEmployeeCount;
  line.filled += filled;
  line.open += shift.requiredEmployeeCount - filled;
  lines.set(key, line);
}

function sorted(lines: Map<string, CoverageLine>): CoverageLine[] {
  return [...lines.values()].sort((left, right) =>
    left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
  );
}

/**
 * Coverage of a period, independent of how it's displayed: slots required, filled and
 * open, by day, position and area, plus employees over their configured targets.
 */
export function analyzeCoverage(input: {
  shifts: readonly CoverageShift[];
  employeeWeeks: readonly EmployeeWeekHours[];
  overtimeThresholdMs: number | null;
}) {
  const byDay = new Map<string, CoverageLine>();
  const byPosition = new Map<string, CoverageLine>();
  const byArea = new Map<string, CoverageLine>();
  let required = 0;
  let filled = 0;

  for (const shift of input.shifts) {
    required += shift.requiredEmployeeCount;
    filled += Math.min(shift.assignedCount, shift.requiredEmployeeCount);
    addLine(byDay, shift.shiftDate, shift.shiftDate, shift);
    addLine(byPosition, shift.positionId, shift.positionName, shift);

    if (shift.restaurantAreaId && shift.restaurantAreaName) {
      addLine(byArea, shift.restaurantAreaId, shift.restaurantAreaName, shift);
    }
  }

  const warnings: CoverageWarning[] = [];

  for (const week of input.employeeWeeks) {
    const hoursText = `${week.displayName} has ${msToHours(week.scheduledMs)} hours in the week of ${week.weekStart}`;

    if (
      input.overtimeThresholdMs !== null &&
      week.scheduledMs > input.overtimeThresholdMs
    ) {
      warnings.push({
        code: "PROJECTED_OVERTIME",
        employeeId: week.employeeId,
        message: `${hoursText}, past the overtime threshold.`,
      });
    }

    if (week.targetMs !== null && week.scheduledMs > week.targetMs) {
      warnings.push({
        code: "OVER_TARGET_HOURS",
        employeeId: week.employeeId,
        message: `${hoursText}, past their target of ${msToHours(week.targetMs)}.`,
      });
    }

    if (week.maximumMs !== null && week.scheduledMs > week.maximumMs) {
      warnings.push({
        code: "OVER_PREFERRED_MAXIMUM",
        employeeId: week.employeeId,
        message: `${hoursText}, past their preferred maximum of ${msToHours(week.maximumMs)}.`,
      });
    }

    if (week.minimumMs !== null && week.scheduledMs < week.minimumMs) {
      warnings.push({
        code: "UNDER_PREFERRED_MINIMUM",
        employeeId: week.employeeId,
        message: `${hoursText}, under their preferred minimum of ${msToHours(week.minimumMs)}.`,
      });
    }
  }

  return {
    required,
    filled,
    open: required - filled,
    byDay: sorted(byDay),
    byPosition: sorted(byPosition),
    byArea: sorted(byArea),
    openShiftIds: input.shifts
      .filter((shift) => shift.assignedCount < shift.requiredEmployeeCount)
      .map((shift) => shift.id),
    warnings,
  };
}

export type Coverage = ReturnType<typeof analyzeCoverage>;
