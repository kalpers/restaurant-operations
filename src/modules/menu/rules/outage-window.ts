import { BusinessRuleError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";
import {
  businessDateOf,
  businessDateStart,
  type BusinessDateSettings,
} from "@/shared/time/business-date-service";

// Phase 20 scheduled 86 (policy 4): when an 86 starts and ends. Pure: callers pass `now`.

/** A start this far in the past is taken as "now" (a form posted a few seconds late). */
const START_TOLERANCE_MS = 60 * 1000;

export type OutageWindowInput = {
  startsAt?: Date | null;
  endsAt?: Date | null;
  /** Ends at the next business-date cutoff after the start, from BusinessDateService. */
  untilClose?: boolean;
};

export function resolveOutageWindow(
  input: OutageWindowInput,
  now: Date,
  settings: BusinessDateSettings,
): { startsAt: Date; endsAt: Date | null } {
  const requested = input.startsAt ?? now;

  if (requested.getTime() < now.getTime() - START_TOLERANCE_MS) {
    throw new BusinessRuleError("INVALID_SCHEDULE", "An 86 can't start in the past.");
  }

  const startsAt = requested.getTime() < now.getTime() ? now : requested;

  if (input.untilClose && input.endsAt) {
    throw new BusinessRuleError("INVALID_SCHEDULE", "Choose an end time or \"until close\", not both.");
  }

  const endsAt = input.untilClose
    ? businessDateStart(addDays(businessDateOf(startsAt, settings), 1), settings)
    : (input.endsAt ?? null);

  if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
    throw new BusinessRuleError("INVALID_SCHEDULE", "An 86 must end after it starts.");
  }

  return { startsAt, endsAt };
}

/** Where an ACTIVE outage stands at `at`. */
export function outagePhase(
  outage: { startsAt: Date; endsAt: Date | null },
  at: Date,
): "SCHEDULED" | "IN_EFFECT" | "ENDED" {
  if (outage.startsAt.getTime() > at.getTime()) {
    return "SCHEDULED";
  }

  return outage.endsAt && outage.endsAt.getTime() <= at.getTime() ? "ENDED" : "IN_EFFECT";
}
