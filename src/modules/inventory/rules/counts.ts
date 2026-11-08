import { compareDecimals, negateDecimal, subtractDecimals } from "@/shared/decimal/decimal";
import { BusinessRuleError } from "@/shared/errors/app-error";

import type { CountStatus } from "../types";

// Approved count policy: inventory stays mutable while a count is open. Each line snapshots
// expected QOH. Variance = counted - expected snapshot. Approval posts that variance against
// current QOH (never sets QOH to the count). Ledger activity after a line's snapshot needs an
// explicit acknowledgement, whose actor and time are recorded.

export function variance(counted: string, expected: string): string {
  return subtractDecimals(counted, expected);
}

/** The ledger posting a line's variance makes, or null when there is none. */
export function variancePosting(
  varianceQuantity: string,
): { type: "COUNT_INCREASE" | "COUNT_DECREASE"; magnitude: string } | null {
  const sign = compareDecimals(varianceQuantity, "0");

  if (sign === 0) {
    return null;
  }

  return sign > 0
    ? { type: "COUNT_INCREASE", magnitude: varianceQuantity }
    : { type: "COUNT_DECREASE", magnitude: negateDecimal(varianceQuantity) };
}

export function assertApprovable(input: {
  status: CountStatus;
  uncountedLines: number;
  linesWithActivity: number;
  acknowledgeActivity: boolean;
}): void {
  if (input.status !== "SUBMITTED") {
    throw new BusinessRuleError(
      "COUNT_NOT_SUBMITTED",
      input.status === "APPROVED"
        ? "This count has already been approved."
        : "Only a submitted count can be approved.",
    );
  }

  if (input.uncountedLines > 0) {
    throw new BusinessRuleError("COUNT_INCOMPLETE", "Every line needs a counted quantity.");
  }

  if (input.linesWithActivity > 0 && !input.acknowledgeActivity) {
    throw new BusinessRuleError(
      "COUNT_ACTIVITY_UNACKNOWLEDGED",
      "Stock moved after this count started. Review and acknowledge that activity to approve.",
    );
  }
}

const TRANSITIONS: Record<CountStatus, readonly CountStatus[]> = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["DRAFT", "APPROVED", "CANCELLED"],
  APPROVED: [],
  CANCELLED: [],
};

export function assertCountTransition(from: CountStatus, to: CountStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new BusinessRuleError(
      "INVALID_COUNT_TRANSITION",
      `A ${from.toLowerCase()} count can't become ${to.toLowerCase()}.`,
    );
  }
}
