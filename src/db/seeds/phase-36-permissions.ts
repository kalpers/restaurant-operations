import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The codes Phase 36 added (policy 2). */
const PHASE_36_CODES: readonly PermissionCode[] = [
  "checklists.view",
  "checklists.complete",
  "checklists.manage",
  "food-safety.view",
  "food-safety.record",
  "food-safety.manage",
  "events.view",
  "events.manage",
  "purchasing.invoices.record",
  "purchasing.invoices.approve",
];

/** Upgrades a Phase 35 database with the Phase 36 codes and their system-role grants. */
export const securityPhase36PermissionsSeed: Seed = {
  key: "security.phase-36-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_36_CODES),
};
