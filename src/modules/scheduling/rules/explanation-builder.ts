import type { ScoreReason } from "./candidate-scorer";
import type { HardCheck, HardConstraintCode } from "./eligibility";

/** Stored with a generated assignment. Built from actual results, never free prose. */
export type AssignmentRationale = {
  checks: HardCheck[];
  score: number;
  reasons: ScoreReason[];
};

export type UnfilledReason = {
  code: HardConstraintCode;
  employeeCount: number;
  summary: string;
};

/** Stored with a run. Counts by reason, with no employee identity or HR detail. */
export type UnfilledShiftDetail = {
  shiftId: string;
  openSlots: number;
  candidatesConsidered: number;
  reasons: UnfilledReason[];
  summary: string;
};

const UNFILLED_SUMMARIES: Record<HardConstraintCode, string> = {
  EMPLOYEE_NOT_SCHEDULABLE: "can't currently be scheduled",
  LOCATION_NOT_ELIGIBLE: "aren't eligible at this location",
  POSITION_NOT_HELD: "don't hold this position",
  APPROVED_TIME_OFF: "have approved time off",
  AVAILABILITY_UNAVAILABLE: "are marked unavailable",
  AVAILABILITY_NOT_COVERED: "have availability that doesn't cover the shift",
  AVAILABILITY_NOT_CONFIGURED: "have no availability set up",
  SHIFT_OVERLAP: "are already assigned to an overlapping shift",
  HARD_WEEKLY_HOURS: "would pass the maximum weekly hours",
  HARD_WEEKLY_DAYS: "would pass the maximum days per week",
  HARD_CONSECUTIVE_DAYS: "would pass the maximum consecutive days",
  HARD_MINIMUM_REST: "wouldn't get the minimum rest",
};

/**
 * Why a slot stayed open. A candidate can fail several constraints and is counted under
 * each, so no single reason is claimed when several eliminated people.
 */
export function buildUnfilledDetail(input: {
  shiftId: string;
  openSlots: number;
  rejections: readonly (readonly HardConstraintCode[])[];
}): UnfilledShiftDetail {
  const counts = new Map<HardConstraintCode, number>();

  for (const violations of input.rejections) {
    for (const code of violations) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  const reasons = [...counts.entries()]
    .sort(
      ([leftCode, left], [rightCode, right]) =>
        right - left || (leftCode < rightCode ? -1 : 1),
    )
    .map(([code, employeeCount]) => ({
      code,
      employeeCount,
      summary: `${employeeCount} ${UNFILLED_SUMMARIES[code]}`,
    }));

  return {
    shiftId: input.shiftId,
    openSlots: input.openSlots,
    candidatesConsidered: input.rejections.length,
    reasons,
    summary:
      reasons.length === 0
        ? "No other employees are assigned to this location."
        : reasons.map((reason) => reason.summary).join("; "),
  };
}
