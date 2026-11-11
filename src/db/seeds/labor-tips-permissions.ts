import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** Codes Phase 18 added: the time clock, tip pools and the Tips report (policy D26). */
const PHASE_18_CODES: readonly PermissionCode[] = [
  "timeclock.punch",
  "timeclock.view",
  "timeclock.manage",
  "tips.manage",
  "reports.tips",
];

/** Upgrades a Phase 17 database with the Phase 18 codes and their system-role grants. */
export const securityLaborTipsPermissionsSeed: Seed = {
  key: "security.labor-tips-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_18_CODES),
};
