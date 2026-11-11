import { compareDecimals } from "@/shared/decimal/decimal";

// Phase 19 policy 12: an alert opens when a posting takes stock from above the reorder level
// to at or below it, and resolves when a posting takes it back above. Anything else changes
// nothing, so an item already low gets one alert, not one per sale.

export type AlertCrossing = "OPEN" | "RESOLVE" | "NONE";

export function alertCrossing(quantityBefore: string, quantityAfter: string, reorderLevel: string | null): AlertCrossing {
  if (reorderLevel === null) {
    return "NONE";
  }

  const wasLow = compareDecimals(quantityBefore, reorderLevel) <= 0;
  const isLow = compareDecimals(quantityAfter, reorderLevel) <= 0;

  if (!wasLow && isLow) {
    return "OPEN";
  }

  if (wasLow && !isLow) {
    return "RESOLVE";
  }

  return "NONE";
}
