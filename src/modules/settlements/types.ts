import type { PermissionCode } from "@/modules/auth/permission-catalog";

export const SETTLEMENT_STATUSES = ["OPEN", "COMPLETED", "CANCELLED"] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

/** Recorded classifications only. None of them is processed by this application. */
export const TENDER_TYPES = ["CASH", "EXTERNAL_CARD", "GIFT_CARD", "HOUSE_ACCOUNT", "OTHER"] as const;
export type TenderType = (typeof TENDER_TYPES)[number];

export const TENDER_STATUSES = ["RECORDED", "VOIDED", "FAILED"] as const;
export type TenderStatus = (typeof TENDER_STATUSES)[number];

/** Tips are allowed only on these tender types. */
export const TIPPABLE_TENDER_TYPES: readonly TenderType[] = ["CASH", "EXTERNAL_CARD"];

/** Each tender type has its own recording permission. */
export const TENDER_PERMISSIONS: Record<TenderType, PermissionCode> = {
  CASH: "settlements.tender.cash",
  EXTERNAL_CARD: "settlements.tender.external-card",
  GIFT_CARD: "settlements.tender.gift-card",
  HOUSE_ACCOUNT: "settlements.tender.house-account",
  OTHER: "settlements.tender.other",
};

/** Idempotency scopes of the retryable settlement commands. */
export const TENDER_SCOPE = "settlements.tender";
export const COMPLETE_SCOPE = "settlements.complete";
