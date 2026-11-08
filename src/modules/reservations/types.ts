export const RESERVATION_STATUSES = [
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "SEATED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const WAITLIST_STATUSES = [
  "WAITING",
  "NOTIFIED",
  "TABLE_ASSIGNED",
  "SEATED",
  "CANCELLED",
  "LEFT",
] as const;
export type WaitlistStatus = (typeof WAITLIST_STATUSES)[number];

export const GUEST_PARTY_STATUSES = [
  "EXPECTED",
  "WAITING",
  "CHECKED_IN",
  "SEATED",
  "COMPLETED",
  "CANCELLED",
  "NO_SHOW",
] as const;
export type GuestPartyStatus = (typeof GUEST_PARTY_STATUSES)[number];

export const RESERVATION_SOURCES = [
  "PHONE",
  "IN_PERSON",
  "INTERNAL",
  "WALK_IN_FUTURE",
] as const;
export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

/** A reservation can be created as `PENDING` (unconfirmed) or `CONFIRMED`. */
export const CREATABLE_RESERVATION_STATUSES = ["PENDING", "CONFIRMED"] as const;

/** At most three physical tables, all in one Restaurant Area. */
export const MAX_COMBINED_TABLES = 3;

/** The location settings that define holds. Both are in minutes. */
export type HoldSettings = {
  preHoldMinutes: number;
  postGraceMinutes: number;
};

/** Half-open: `start` is inside, `end` is not. */
export type Interval = { start: Date; end: Date };
