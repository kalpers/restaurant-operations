import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The codes Phase 31 added: gift cards (policy 13, D13). */
const PHASE_31_CODES: readonly PermissionCode[] = ["gift-cards.view", "gift-cards.sell", "gift-cards.manage"];

/** Upgrades a Phase 30 database with the Phase 31 codes and their system-role grants. */
export const securityGiftCardPermissionsSeed: Seed = {
  key: "security.gift-card-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_31_CODES),
};
