export const ORDER_TYPES = ["DINE_IN", "BAR", "TAKEOUT"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const ORDER_STATUSES = ["OPEN", "CLOSED", "VOIDED"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_ITEM_STATUSES = ["DRAFT", "SUBMITTED", "VOIDED"] as const;
export type OrderItemStatus = (typeof ORDER_ITEM_STATUSES)[number];

export const VOID_DISPOSITIONS = ["UNPREPARED", "PREPARED_OR_DISCARDED"] as const;
export type VoidDisposition = (typeof VOID_DISPOSITIONS)[number];

export const DISCOUNT_SCOPES = ["ITEM", "ORDER"] as const;
export type DiscountScope = (typeof DISCOUNT_SCOPES)[number];

export const DISCOUNT_TYPES = ["FIXED_AMOUNT", "PERCENTAGE"] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

/** Which Restaurant Area type a seated order type requires. TAKEOUT has no session. */
export const AREA_TYPE_FOR_ORDER: Record<Exclude<OrderType, "TAKEOUT">, "DINING" | "BAR"> = {
  DINE_IN: "DINING",
  BAR: "BAR",
};

/** Idempotency scope of the SEND command. */
export const SEND_SCOPE = "orders.send";
