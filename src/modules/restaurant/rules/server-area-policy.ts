import type { AreaType } from "../types";

/**
 * The approved Position-to-area policy, in one replaceable place. It's static in Phase 5.
 * Takeout has no table sessions, so nobody qualifies. Security Roles have no part in it.
 */
const SERVER_POSITIONS_BY_AREA: Readonly<Record<AreaType, readonly string[]>> = {
  DINING: ["SERVER", "WAIT_STAFF"],
  BAR: ["BARTENDER", "SERVER", "WAIT_STAFF"],
  TAKEOUT: [],
};

export function serverPositionCodesFor(areaType: AreaType): readonly string[] {
  return SERVER_POSITIONS_BY_AREA[areaType];
}
