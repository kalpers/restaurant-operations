import { BusinessRuleError, ConflictError } from "@/shared/errors/app-error";

import type { TableAvailability, TableCondition } from "../types";

export type AvailabilityInput = {
  tableActive: boolean;
  areaActive: boolean;
  condition: TableCondition;
  occupied: boolean;
};

/**
 * Whether a table can be seated, derived from configuration, condition and occupancy.
 * Occupancy outranks condition, because a seated table is the fact a host needs first.
 */
export function deriveTableAvailability(
  input: AvailabilityInput,
): TableAvailability {
  if (!input.tableActive || !input.areaActive) {
    return "INACTIVE";
  }

  if (input.occupied) {
    return "OCCUPIED";
  }

  if (input.condition === "OUT_OF_SERVICE") {
    return "OUT_OF_SERVICE";
  }

  return input.condition === "DIRTY" ? "DIRTY" : "AVAILABLE";
}

/** Refuses anything but an available table, with a code the UI and API can use. */
export function assertTableSeatable(
  availability: TableAvailability,
  tableNumber: string,
): void {
  switch (availability) {
    case "AVAILABLE":
      return;
    case "OCCUPIED":
      throw new ConflictError(
        "TABLE_ALREADY_OCCUPIED",
        `Table ${tableNumber} currently has an active session.`,
      );
    case "DIRTY":
      throw new BusinessRuleError(
        "TABLE_DIRTY",
        `Table ${tableNumber} needs cleaning before it can be seated.`,
      );
    case "OUT_OF_SERVICE":
      throw new BusinessRuleError(
        "TABLE_OUT_OF_SERVICE",
        `Table ${tableNumber} is out of service.`,
      );
    case "INACTIVE":
      throw new BusinessRuleError(
        "TABLE_INACTIVE",
        `Table ${tableNumber} isn't in use.`,
      );
  }
}
