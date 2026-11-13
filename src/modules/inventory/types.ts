export const INVENTORY_TRANSACTION_TYPES = [
  "RECEIVE",
  "CONSUME",
  "WASTE",
  "ADJUST_INCREASE",
  "ADJUST_DECREASE",
  "COUNT_INCREASE",
  "COUNT_DECREASE",
  "TRANSFER_OUT",
  "TRANSFER_IN",
  "SALE_REVERSAL",
] as const;
export type InventoryTransactionType = (typeof INVENTORY_TRANSACTION_TYPES)[number];

/** Which way each type moves stock. The ledger stores the signed base quantity. */
export const TRANSACTION_DIRECTION: Record<InventoryTransactionType, 1 | -1> = {
  RECEIVE: 1,
  CONSUME: -1,
  WASTE: -1,
  ADJUST_INCREASE: 1,
  ADJUST_DECREASE: -1,
  COUNT_INCREASE: 1,
  COUNT_DECREASE: -1,
  TRANSFER_OUT: -1,
  TRANSFER_IN: 1,
  SALE_REVERSAL: 1,
};

export const WASTE_REASONS = ["SPOILAGE", "BREAKAGE", "PREP_WASTE", "EXPIRED", "OTHER"] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

export const ADJUSTMENT_REASONS = [
  "RECEIVING_CORRECTION",
  "FOUND_STOCK",
  "THEFT_OR_LOSS",
  "DATA_CORRECTION",
  "OTHER",
] as const;
/**
 * Phase 23 (policy 12): written only by the system when a transfer arrives short, never
 * chosen in the adjustment form.
 */
export const SYSTEM_ADJUSTMENT_REASONS = ["TRANSFER_SHORTAGE"] as const;
export type AdjustmentReason =
  | (typeof ADJUSTMENT_REASONS)[number]
  | (typeof SYSTEM_ADJUSTMENT_REASONS)[number];

/** Phase 23 (policy 10): a transfer between two locations of one organization. */
export const TRANSFER_STATUSES = ["DRAFT", "SENT", "RECEIVED", "CANCELLED"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

export const COUNT_STATUSES = ["DRAFT", "SUBMITTED", "APPROVED", "CANCELLED"] as const;
export type CountStatus = (typeof COUNT_STATUSES)[number];

/** Quantities and costs: `NUMERIC(14,4)`. Conversion factors: `NUMERIC(14,6)`. */
export const QUANTITY_SCALE = 4;
export const COST_SCALE = 4;
export const FACTOR_SCALE = 6;
