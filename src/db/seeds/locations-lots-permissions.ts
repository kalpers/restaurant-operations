import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The code Phase 23 added: creating, deactivating and reactivating locations (policy 6). */
const PHASE_23_CODES: readonly PermissionCode[] = ["locations.lifecycle"];

/** Upgrades a Phase 22 database with the Phase 23 code and its system-role grants. */
export const securityLocationsLotsPermissionsSeed: Seed = {
  key: "security.locations-lots-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_23_CODES),
};
