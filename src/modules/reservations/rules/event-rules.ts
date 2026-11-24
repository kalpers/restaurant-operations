import { EVENT_BLOCKING_STATUSES, type EventStatus } from "@/db/schema/events";
export type { EventSpaceScope, EventStatus } from "@/db/schema/events";
import { BusinessRuleError } from "@/shared/errors/app-error";

import type { Interval } from "../types";

// Phase 36 part 3 (policy 7): event rules. Pure, so they are unit-tested on their own.

/** Policy 7: the status moves a person may make. COMPLETED comes only from the session ending. */
const TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  INQUIRY: ["TENTATIVE", "CONFIRMED", "CANCELLED"],
  TENTATIVE: ["INQUIRY", "CONFIRMED", "CANCELLED"],
  CONFIRMED: ["TENTATIVE", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertEventTransition(from: EventStatus, to: EventStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new BusinessRuleError("EVENT_STATUS_INVALID", `An event can't go from ${from.toLowerCase()} to ${to.toLowerCase()}.`);
  }
}

/** TENTATIVE and CONFIRMED events hold their space; an inquiry holds nothing. */
export function eventBlocks(status: EventStatus): boolean {
  return (EVENT_BLOCKING_STATUSES as readonly EventStatus[]).includes(status);
}

/** An event can be changed until it is completed or cancelled. */
export function assertEventOpen(status: EventStatus): void {
  if (status === "COMPLETED" || status === "CANCELLED") {
    throw new BusinessRuleError("EVENT_FINISHED", "This event is finished and can't be changed.");
  }
}

/** Policy 7: the half-open interval an event holds its space for. */
export function eventBlockInterval(event: { startsAt: Date; endsAt: Date; setupMinutes: number; teardownMinutes: number }): Interval {
  return {
    start: new Date(event.startsAt.getTime() - event.setupMinutes * 60_000),
    end: new Date(event.endsAt.getTime() + event.teardownMinutes * 60_000),
  };
}

/** An event ends after it starts, within 24 hours, with setup and teardown of 0 to 480 minutes. */
export function assertEventTimes(input: { startsAt: Date; endsAt: Date; setupMinutes: number; teardownMinutes: number }): void {
  const length = input.endsAt.getTime() - input.startsAt.getTime();

  if (length <= 0 || length > 24 * 3_600_000) {
    throw new BusinessRuleError("EVENT_TIMES_INVALID", "An event ends after it starts, and lasts at most 24 hours.");
  }

  for (const minutes of [input.setupMinutes, input.teardownMinutes]) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > 480) {
      throw new BusinessRuleError("EVENT_TIMES_INVALID", "Setup and teardown are 0 to 480 minutes.");
    }
  }
}

/** Policy 7: the human-readable event number. */
export function formatEventNumber(eventNumber: number): string {
  return `EV-${String(eventNumber).padStart(6, "0")}`;
}

/** Policy 7: the deposit is recorded as a whole: amount, date and how, or nothing. */
export function assertDepositRecord(input: {
  depositReceived: string | null;
  depositReceivedOn: string | null;
  depositMethod: string | null;
}): void {
  const given = [input.depositReceived, input.depositReceivedOn, input.depositMethod].filter((value) => value !== null).length;

  if (given !== 0 && given !== 3) {
    throw new BusinessRuleError("DEPOSIT_INCOMPLETE", "A received deposit needs its amount, the date it came in and how it was paid.");
  }
}
