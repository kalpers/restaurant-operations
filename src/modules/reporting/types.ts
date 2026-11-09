import type { PermissionCode } from "@/modules/auth/permission-catalog";

/** The eight reporting areas (Phase 12). Menu performance shares `reports.sales`. */
export const REPORT_AREAS = [
  "sales",
  "menu",
  "settlements",
  "orders",
  "inventory",
  "fulfillment",
  "labor",
  "seating",
] as const;

export type ReportArea = (typeof REPORT_AREAS)[number];

export const REPORT_AREA_PERMISSION: Record<ReportArea, PermissionCode> = {
  sales: "reports.sales",
  menu: "reports.sales",
  settlements: "reports.settlements",
  orders: "reports.orders",
  inventory: "reports.inventory",
  fulfillment: "reports.fulfillment",
  labor: "reports.labor",
  seating: "reports.seating",
};

export const REPORT_AREA_TITLE: Record<ReportArea, string> = {
  sales: "Sales",
  menu: "Menu performance",
  settlements: "Settlements",
  orders: "Orders",
  inventory: "Inventory",
  fulfillment: "Kitchen & bar fulfillment",
  labor: "Labor",
  seating: "Seating",
};

export const ORDER_TYPES = ["DINE_IN", "BAR", "TAKEOUT"] as const;
export const TENDER_TYPES = [
  "CASH",
  "EXTERNAL_CARD",
  "GIFT_CARD",
  "HOUSE_ACCOUNT",
  "OTHER",
] as const;

export type OrderTypeFilter = (typeof ORDER_TYPES)[number];
export type TenderTypeFilter = (typeof TENDER_TYPES)[number];

/** Every report is for one Location and an inclusive business-date range. */
export type ReportFilters = {
  locationId: string;
  from: string;
  to: string;
  employeeId?: string;
  orderType?: OrderTypeFilter;
  tenderType?: TenderTypeFilter;
};

/**
 * How a column's values are formatted. Money, cost, quantity, hours and percent values are
 * decimal strings; counts and minutes are numbers.
 */
export type ColumnKind =
  | "text"
  | "date"
  | "count"
  | "money"
  | "cost"
  | "quantity"
  | "minutes"
  | "hours"
  | "percent";

export type ReportColumn = { key: string; label: string; kind: ColumnKind };

export type ReportCell = string | number | null;

export type ReportRow = Record<string, ReportCell>;

export type ReportSection = {
  key: string;
  title: string;
  /** Shown under the title, e.g. what the figures are based on. */
  description?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
};

export type ReportResult = {
  area: ReportArea;
  title: string;
  location: { id: string; code: string; name: string };
  filters: ReportFilters;
  /** Notes about the basis of the figures and about columns withheld for permission. */
  notes: string[];
  sections: ReportSection[];
};
