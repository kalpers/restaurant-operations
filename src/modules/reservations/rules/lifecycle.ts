import { BusinessRuleError } from "@/shared/errors/app-error";

import type {
  GuestPartyStatus,
  HoldSettings,
  ReservationStatus,
  WaitlistStatus,
} from "../types";

const RESERVATION_TRANSITIONS: Record<
  ReservationStatus,
  readonly ReservationStatus[]
> = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["CHECKED_IN", "SEATED", "CANCELLED", "NO_SHOW"],
  CHECKED_IN: ["SEATED", "CANCELLED"],
  // Back to CHECKED_IN only when the seating itself was cancelled as a mistake.
  SEATED: ["COMPLETED", "CHECKED_IN"],
  COMPLETED: [],
  CANCELLED: [],
  NO_SHOW: [],
};

const WAITLIST_TRANSITIONS: Record<WaitlistStatus, readonly WaitlistStatus[]> = {
  WAITING: ["NOTIFIED", "TABLE_ASSIGNED", "SEATED", "CANCELLED", "LEFT"],
  NOTIFIED: ["TABLE_ASSIGNED", "SEATED", "CANCELLED", "LEFT"],
  // The selection can be ended, which returns the entry to where it was.
  TABLE_ASSIGNED: ["WAITING", "NOTIFIED", "SEATED", "CANCELLED", "LEFT"],
  // Back to waiting only when the seating itself was cancelled as a mistake.
  SEATED: ["WAITING", "NOTIFIED"],
  CANCELLED: [],
  LEFT: [],
};

export function canTransitionReservation(
  from: ReservationStatus,
  to: ReservationStatus,
): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

export function assertReservationTransition(
  from: ReservationStatus,
  to: ReservationStatus,
): void {
  if (!canTransitionReservation(from, to)) {
    throw new BusinessRuleError(
      "INVALID_RESERVATION_TRANSITION",
      `A ${from.toLowerCase().replace("_", " ")} reservation can't become ${to
        .toLowerCase()
        .replace("_", " ")}.`,
    );
  }
}

export function assertWaitlistTransition(
  from: WaitlistStatus,
  to: WaitlistStatus,
): void {
  if (!WAITLIST_TRANSITIONS[from].includes(to)) {
    throw new BusinessRuleError(
      "INVALID_WAITLIST_TRANSITION",
      `A ${from.toLowerCase().replace("_", " ")} waitlist entry can't become ${to
        .toLowerCase()
        .replace("_", " ")}.`,
    );
  }
}

export function isTerminalReservation(status: ReservationStatus): boolean {
  return (
    status === "COMPLETED" || status === "CANCELLED" || status === "NO_SHOW"
  );
}

export function isOpenWaitlistStatus(status: WaitlistStatus): boolean {
  return (
    status === "WAITING" || status === "NOTIFIED" || status === "TABLE_ASSIGNED"
  );
}

/** The Guest Party status that goes with a reservation status. */
export function partyStatusForReservation(
  status: ReservationStatus,
): GuestPartyStatus {
  switch (status) {
    case "PENDING":
    case "CONFIRMED":
      return "EXPECTED";
    default:
      return status;
  }
}

/**
 * A no-show is a manual decision for a confirmed reservation, at or after the end of the
 * post-grace window. Nothing automatic ever calls this.
 */
export function assertNoShowAllowed(
  reservation: { status: ReservationStatus; reservationAt: Date },
  now: Date,
  settings: HoldSettings,
): void {
  if (reservation.status !== "CONFIRMED") {
    throw new BusinessRuleError(
      "NO_SHOW_REQUIRES_CONFIRMED",
      "Only a confirmed reservation can be marked as a no-show.",
    );
  }

  const earliest =
    reservation.reservationAt.getTime() + settings.postGraceMinutes * 60 * 1000;

  if (now.getTime() < earliest) {
    throw new BusinessRuleError(
      "NO_SHOW_TOO_EARLY",
      "The grace period hasn't passed yet, so this reservation can't be marked as a no-show.",
    );
  }
}
