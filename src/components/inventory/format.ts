export const TRANSACTION_LABELS: Record<string, string> = {
  RECEIVE: "Received",
  CONSUME: "Consumed",
  WASTE: "Waste",
  ADJUST_INCREASE: "Adjusted up",
  ADJUST_DECREASE: "Adjusted down",
  COUNT_INCREASE: "Count increase",
  COUNT_DECREASE: "Count decrease",
  TRANSFER_OUT: "Transferred out",
  TRANSFER_IN: "Transferred in",
};

export const WASTE_REASON_OPTIONS = [
  { value: "SPOILAGE", label: "Spoilage" },
  { value: "BREAKAGE", label: "Breakage" },
  { value: "PREP_WASTE", label: "Prep waste" },
  { value: "EXPIRED", label: "Expired" },
  { value: "OTHER", label: "Other" },
];

export const ADJUSTMENT_REASON_OPTIONS = [
  { value: "RECEIVING_CORRECTION", label: "Receiving correction" },
  { value: "FOUND_STOCK", label: "Found stock" },
  { value: "THEFT_OR_LOSS", label: "Theft or loss" },
  { value: "DATA_CORRECTION", label: "Data correction" },
  { value: "OTHER", label: "Other" },
];

export const MEASUREMENT_TYPE_OPTIONS = [
  { value: "COUNT", label: "Count" },
  { value: "WEIGHT", label: "Weight" },
  { value: "VOLUME", label: "Volume" },
];

/** Phase 37 (policy 2): why an item's costing method changed. */
export const COSTING_REASON_OPTIONS = [
  { value: "SUPPLIER_PRICES_VARY", label: "Supplier prices change often" },
  { value: "OWNER_OR_ACCOUNTANT_REQUEST", label: "Owner or accountant asked" },
  { value: "CORRECTION", label: "Correcting an earlier change" },
  { value: "OTHER", label: "Other" },
];

export const COSTING_METHOD_LABELS: Record<string, string> = {
  WEIGHTED_AVERAGE: "Weighted average",
  LOT: "By lot",
};

/** Quantities stay strings. Trailing zeros are trimmed for reading, never for storing. */
export function formatQuantity(value: string | null): string {
  if (value === null) {
    return "—";
  }

  return value.includes(".") ? value.replace(/\.?0+$/, "") || "0" : value;
}

export function formatCost(value: string | null): string {
  return value === null ? "—" : `$${value}`;
}
