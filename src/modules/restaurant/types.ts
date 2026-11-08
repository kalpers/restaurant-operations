export const TABLE_CONDITIONS = ["CLEAN", "DIRTY", "OUT_OF_SERVICE"] as const;
export type TableCondition = (typeof TABLE_CONDITIONS)[number];

export type SessionStatus = "ACTIVE" | "COMPLETED" | "CANCELLED";

/** A label for screens and workflows. It's derived and never stored. */
export type TableAvailability =
  | "AVAILABLE"
  | "DIRTY"
  | "OUT_OF_SERVICE"
  | "OCCUPIED"
  | "INACTIVE";

export type AreaType = "DINING" | "BAR" | "TAKEOUT";
