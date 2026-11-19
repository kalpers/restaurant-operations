import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The codes Phase 32 added: the manager log and pre-shift notes (policy 11). */
const PHASE_32_CODES: readonly PermissionCode[] = [
  "manager-log.view",
  "manager-log.write",
  "manager-log.redact",
  "pre-shift.view",
  "pre-shift.manage",
];

/** Upgrades a Phase 31 database with the Phase 32 codes and their system-role grants. */
export const securityManagerLogPermissionsSeed: Seed = {
  key: "security.manager-log-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_32_CODES),
};
