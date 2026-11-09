import type { PermissionCode } from "@/modules/auth/permission-catalog";

export const KITCHEN_ITEM_STATUSES = ["NEW", "PREPARING", "READY", "COMPLETED", "CANCELLED"] as const;
export type KitchenItemStatus = (typeof KITCHEN_ITEM_STATUSES)[number];

export const FULFILLMENT_ACTIONS = ["start", "ready", "complete"] as const;
export type FulfillmentAction = (typeof FULFILLMENT_ACTIONS)[number];

/** Station types that receive work. EXPO is a view only. */
export const WORK_STATION_TYPES = ["KITCHEN", "BAR"] as const;
export type StationType = (typeof WORK_STATION_TYPES)[number];

export const REMAKE_SCOPE = "kitchen.remake";

export const ACTION_PERMISSION: Record<FulfillmentAction | "remake", PermissionCode> = {
  start: "fulfillment.start",
  ready: "fulfillment.ready",
  complete: "fulfillment.complete",
  remake: "fulfillment.remake",
};

/** Viewing and working a station needs the permission for its type. */
export const STATION_SCOPE: Record<StationType, { view: PermissionCode; manage: PermissionCode }> = {
  KITCHEN: { view: "kitchen.view", manage: "kitchen.manage" },
  BAR: { view: "bar.view", manage: "bar.manage" },
};

export type ModifierSnapshot = {
  groupName: string;
  code: string;
  name: string;
  preparationInstruction: string | null;
};
