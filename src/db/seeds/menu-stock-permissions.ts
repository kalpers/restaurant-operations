import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The code Phase 19 added: 86 and restore items at a location (decision D5, policy 25). */
const PHASE_19_CODES: readonly PermissionCode[] = ["menu.availability.manage"];

/** Upgrades a Phase 18 database with the Phase 19 code and its system-role grants. */
export const securityMenuStockPermissionsSeed: Seed = {
  key: "security.menu-stock-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_19_CODES),
};
