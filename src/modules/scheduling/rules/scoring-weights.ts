/**
 * The initial scoring adjustments (README section 33). Every number that influences a
 * candidate's score lives here, and a generation run records them in its snapshot.
 */
export const SCORING_WEIGHTS = {
  belowTargetHours: 20,
  atOrAboveTargetHours: -10,
  crossesOvertimeThreshold: -50,
  preferredTimeMatch: 12,
  preferredTimeMismatch: -6,
  fairnessPerShift: 8,
  shortRest: -18,
  pendingTimeOffOverlap: -24,
  softWeeklyDayExcessPerDay: -12,
  softConsecutiveDayExcessPerDay: -15,
} as const;
