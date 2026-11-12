import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The code Phase 20 added: mark a check tax exempt (decision D15, policy 24). */
const PHASE_20_CODES: readonly PermissionCode[] = ["tax.exempt"];

/** Upgrades a Phase 19 database with the Phase 20 code and its system-role grants. */
export const securityServicePolishPermissionsSeed: Seed = {
  key: "security.service-polish-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_20_CODES),
};
