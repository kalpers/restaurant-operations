import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The codes Phase 30 added: guest loyalty (policy 13, D13). */
const PHASE_30_CODES: readonly PermissionCode[] = ["loyalty.redeem", "loyalty.adjust", "loyalty.manage"];

/** Upgrades a Phase 29 database with the Phase 30 codes and their system-role grants. */
export const securityLoyaltyPermissionsSeed: Seed = {
  key: "security.loyalty-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_30_CODES),
};
