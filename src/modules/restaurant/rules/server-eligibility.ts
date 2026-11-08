import type { AreaType } from "../types";
import { serverPositionCodesFor } from "./server-area-policy";

/** Only the HR facts this decision needs. There's no input for security roles or pay. */
export type ServerFacts = {
  employmentStatus: string;
  locations: {
    locationId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
  positions: {
    positionCode: string;
    locationId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
};

function isEffective(
  period: { effectiveFrom: string; effectiveTo: string | null },
  date: string,
): boolean {
  return (
    period.effectiveFrom <= date &&
    (period.effectiveTo === null || date <= period.effectiveTo)
  );
}

/** Position codes this person effectively holds here today. */
function heldPositionCodes(
  facts: ServerFacts,
  locationId: string,
  localDate: string,
): Set<string> {
  return new Set(
    facts.positions
      .filter(
        (position) =>
          position.locationId === locationId && isEffective(position, localDate),
      )
      .map((position) => position.positionCode),
  );
}

/**
 * The hard rule: active, eligible here, and holding a position allowed in every area
 * involved. No override reaches this.
 */
export function isServerQualified(input: {
  facts: ServerFacts;
  locationId: string;
  localDate: string;
  areaTypes: readonly AreaType[];
}): boolean {
  const { facts, locationId, localDate, areaTypes } = input;

  if (facts.employmentStatus !== "ACTIVE" || areaTypes.length === 0) {
    return false;
  }

  const atLocation = facts.locations.some(
    (location) =>
      location.locationId === locationId && isEffective(location, localDate),
  );

  if (!atLocation) {
    return false;
  }

  const held = heldPositionCodes(facts, locationId, localDate);

  return areaTypes.every((areaType) =>
    serverPositionCodesFor(areaType).some((code) => held.has(code)),
  );
}

/**
 * Whether a published shift running right now covers this work: the shift's position must
 * be one the person holds and one allowed in each area. `activeShiftPositionCodes` comes
 * from ACTIVE assignments in PUBLISHED periods with `start_at <= now < end_at`.
 */
export function isServerOnMatchingShift(input: {
  facts: ServerFacts;
  locationId: string;
  localDate: string;
  areaTypes: readonly AreaType[];
  activeShiftPositionCodes: readonly string[];
}): boolean {
  const held = heldPositionCodes(input.facts, input.locationId, input.localDate);
  const working = input.activeShiftPositionCodes.filter((code) => held.has(code));

  return (
    input.areaTypes.length > 0 &&
    input.areaTypes.every((areaType) =>
      serverPositionCodesFor(areaType).some((code) => working.includes(code)),
    )
  );
}

export type ServerDecision =
  | { outcome: "NOT_QUALIFIED" }
  | { outcome: "ON_SHIFT" }
  | { outcome: "OVERRIDDEN"; reason: string }
  | { outcome: "OVERRIDE_DENIED" }
  | { outcome: "REASON_REQUIRED" };

/**
 * HR qualification first, then the schedule. The manager override applies only to the
 * schedule match, so it can never make an unqualified person a server.
 */
export function evaluateServerAssignment(input: {
  facts: ServerFacts;
  locationId: string;
  localDate: string;
  areaTypes: readonly AreaType[];
  activeShiftPositionCodes: readonly string[];
  canOverrideSchedule: boolean;
  overrideReason?: string | null;
}): ServerDecision {
  if (!isServerQualified(input)) {
    return { outcome: "NOT_QUALIFIED" };
  }

  if (isServerOnMatchingShift(input)) {
    return { outcome: "ON_SHIFT" };
  }

  if (!input.canOverrideSchedule) {
    return { outcome: "OVERRIDE_DENIED" };
  }

  const reason = input.overrideReason?.trim();

  return reason ? { outcome: "OVERRIDDEN", reason } : { outcome: "REASON_REQUIRED" };
}
