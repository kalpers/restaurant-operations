import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** Codes Phase 17 added: tax, split checks, hold/fire, refunds and cash drawers. */
const PHASE_17_CODES: readonly PermissionCode[] = [
  "tax.view",
  "tax.manage",
  "orders.move-items",
  "orders.fire",
  "settlements.refund",
  "settlements.refund-void",
  "drawers.view",
  "drawers.operate",
  "drawers.manage",
];

/** Upgrades a Phase 16 database with the Phase 17 codes and their system-role grants. */
export const securityChecksCloseoutPermissionsSeed: Seed = {
  key: "security.checks-closeout-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_17_CODES),
};
