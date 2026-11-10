import type { Tone } from "@/components/ui/badge";

/**
 * Display labels and badge tones for lifecycle statuses. Display only: nothing here
 * decides behavior. An unknown value falls back to a humanized form of the raw string,
 * so a new status never breaks a page.
 */
export type StatusDomain =
  | "order"
  | "orderItem"
  | "fulfillment"
  | "settlement"
  | "tender"
  | "tableAvailability"
  | "tableSession"
  | "reservation"
  | "waitlist"
  | "schedulePeriod"
  | "generationRun"
  | "timeOff"
  | "swap"
  | "purchaseOrder"
  | "inventoryCount"
  | "employee"
  | "recipeRevision";

type Entry = readonly [label: string, tone: Tone];

const STATUS: Record<StatusDomain, Record<string, Entry>> = {
  order: { OPEN: ["Open", "info"], CLOSED: ["Closed", "success"], VOIDED: ["Voided", "danger"] },
  orderItem: { DRAFT: ["Not sent", "warning"], SUBMITTED: ["Sent", "info"], VOIDED: ["Voided", "danger"] },
  fulfillment: {
    NEW: ["New", "info"],
    PREPARING: ["Preparing", "warning"],
    READY: ["Ready", "success"],
    COMPLETED: ["Completed", "neutral"],
    CANCELLED: ["Cancelled", "danger"],
  },
  settlement: { OPEN: ["Open", "info"], COMPLETED: ["Completed", "success"], CANCELLED: ["Cancelled", "danger"] },
  tender: { RECORDED: ["Recorded", "success"], VOIDED: ["Voided", "danger"], FAILED: ["Failed", "danger"] },
  tableAvailability: {
    AVAILABLE: ["Available", "success"],
    OCCUPIED: ["Occupied", "info"],
    DIRTY: ["Dirty", "warning"],
    OUT_OF_SERVICE: ["Out of service", "danger"],
    INACTIVE: ["Inactive", "neutral"],
  },
  tableSession: { ACTIVE: ["Seated", "info"], COMPLETED: ["Completed", "neutral"], CANCELLED: ["Cancelled", "danger"] },
  reservation: {
    PENDING: ["Pending", "warning"],
    CONFIRMED: ["Confirmed", "info"],
    CHECKED_IN: ["Checked in", "brand"],
    SEATED: ["Seated", "success"],
    COMPLETED: ["Completed", "neutral"],
    CANCELLED: ["Cancelled", "danger"],
    NO_SHOW: ["No-show", "danger"],
  },
  waitlist: {
    WAITING: ["Waiting", "warning"],
    NOTIFIED: ["Notified", "info"],
    TABLE_ASSIGNED: ["Table chosen", "brand"],
    SEATED: ["Seated", "success"],
    CANCELLED: ["Cancelled", "danger"],
    LEFT: ["Left", "neutral"],
  },
  schedulePeriod: { DRAFT: ["Draft", "warning"], PUBLISHED: ["Published", "success"], ARCHIVED: ["Archived", "neutral"] },
  generationRun: {
    STARTED: ["Started", "info"],
    COMPLETED: ["Completed", "success"],
    FAILED: ["Failed", "danger"],
  },
  timeOff: {
    PENDING: ["Pending", "warning"],
    APPROVED: ["Approved", "success"],
    DENIED: ["Denied", "danger"],
    CANCELLED: ["Cancelled", "neutral"],
  },
  swap: {
    PENDING: ["Pending", "warning"],
    ACCEPTED: ["Accepted", "info"],
    COMPLETED: ["Completed", "success"],
    DENIED: ["Denied", "danger"],
    CANCELLED: ["Cancelled", "neutral"],
  },
  purchaseOrder: {
    DRAFT: ["Draft", "warning"],
    SUBMITTED: ["Submitted", "info"],
    PARTIALLY_RECEIVED: ["Partially received", "brand"],
    RECEIVED: ["Received", "success"],
    CANCELLED: ["Cancelled", "danger"],
  },
  inventoryCount: {
    DRAFT: ["Draft", "warning"],
    SUBMITTED: ["Submitted", "info"],
    APPROVED: ["Approved", "success"],
    CANCELLED: ["Cancelled", "danger"],
  },
  employee: {
    ACTIVE: ["Active", "success"],
    ON_LEAVE: ["On leave", "warning"],
    SUSPENDED: ["Suspended", "danger"],
    TERMINATED: ["Terminated", "neutral"],
  },
  recipeRevision: {
    DRAFT: ["Draft", "warning"],
    PUBLISHED: ["Published", "success"],
    RETIRED: ["Retired", "neutral"],
  },
};

/** "FULL_TIME" becomes "Full time". */
export function humanizeCode(value: string): string {
  const words = value.replaceAll("_", " ").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function statusLabel(domain: StatusDomain, value: string): string {
  return STATUS[domain][value]?.[0] ?? humanizeCode(value);
}

export function statusTone(domain: StatusDomain, value: string): Tone {
  return STATUS[domain][value]?.[1] ?? "neutral";
}

/** Every status a domain knows about, for tests and filters. */
export function knownStatuses(domain: StatusDomain): string[] {
  return Object.keys(STATUS[domain]);
}
