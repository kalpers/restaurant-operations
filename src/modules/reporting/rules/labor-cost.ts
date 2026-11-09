import { addDecimals, divideRoundHalfUp, multiplyExact } from "@/shared/decimal/decimal";

/** The compensation in effect for an Employee and Position on a shift date. */
export type EffectiveCompensation =
  | { compensationType: "HOURLY"; hourlyRate: string }
  | { compensationType: "SALARY" }
  | null;

export type LaborCostBasis = "HOURLY" | "SALARIED" | "NO_RATE";

export type ShiftLabor = {
  /** Scheduled hours to 4 places. */
  hours: string;
  basis: LaborCostBasis;
  /** Exact seconds × hourly rate ÷ 3600, half-up to cents; null unless HOURLY. */
  cost: string | null;
};

/** Hours to 4 places from whole seconds, half-up. */
export function secondsToHours(seconds: number): string {
  return divideRoundHalfUp(String(seconds), "3600", 4);
}

/**
 * Scheduled labor for one assignment (approved Phase 12 policy): an hourly rate is costed;
 * salaried work and work with no rate in effect show hours only.
 */
export function shiftLabor(seconds: number, compensation: EffectiveCompensation): ShiftLabor {
  const hours = secondsToHours(seconds);

  if (!compensation) {
    return { hours, basis: "NO_RATE", cost: null };
  }

  if (compensation.compensationType === "SALARY") {
    return { hours, basis: "SALARIED", cost: null };
  }

  return {
    hours,
    basis: "HOURLY",
    cost: divideRoundHalfUp(multiplyExact(String(seconds), compensation.hourlyRate), "3600", 2),
  };
}

export type LaborTotals = {
  shifts: number;
  hours: string;
  cost: string;
  salariedHours: string;
  noRateHours: string;
};

export function emptyLaborTotals(): LaborTotals {
  return { shifts: 0, hours: "0.0000", cost: "0.00", salariedHours: "0.0000", noRateHours: "0.0000" };
}

export function addLabor(totals: LaborTotals, shift: ShiftLabor): LaborTotals {
  return {
    shifts: totals.shifts + 1,
    hours: addDecimals(totals.hours, shift.hours),
    cost: shift.cost ? addDecimals(totals.cost, shift.cost) : totals.cost,
    salariedHours:
      shift.basis === "SALARIED" ? addDecimals(totals.salariedHours, shift.hours) : totals.salariedHours,
    noRateHours:
      shift.basis === "NO_RATE" ? addDecimals(totals.noRateHours, shift.hours) : totals.noRateHours,
  };
}

/** `part ÷ whole × 100` to 2 places, half-up, or null when the whole is zero. */
export function percentOf(part: string, whole: string): string | null {
  if (/^-?0*(\.0*)?$/.test(whole)) {
    return null;
  }

  return divideRoundHalfUp(multiplyExact(part, "100"), whole, 2);
}
