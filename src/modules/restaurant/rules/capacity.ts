export function combinedCapacity(
  tables: readonly { capacity: number }[],
): number {
  return tables.reduce((sum, table) => sum + table.capacity, 0);
}

export type CapacityDecision =
  | { outcome: "WITHIN_CAPACITY" }
  | { outcome: "OVERRIDDEN"; reason: string }
  | { outcome: "DENIED" }
  | { outcome: "REASON_REQUIRED" };

/**
 * Capacity is a seating rule, not authorization. Going over it needs both the permission
 * and a stated reason, so it can never pass silently.
 */
export function evaluateCapacity(input: {
  partySize: number;
  capacity: number;
  canOverride: boolean;
  overrideReason?: string | null;
}): CapacityDecision {
  if (input.partySize <= input.capacity) {
    return { outcome: "WITHIN_CAPACITY" };
  }

  if (!input.canOverride) {
    return { outcome: "DENIED" };
  }

  const reason = input.overrideReason?.trim();

  return reason ? { outcome: "OVERRIDDEN", reason } : { outcome: "REASON_REQUIRED" };
}
