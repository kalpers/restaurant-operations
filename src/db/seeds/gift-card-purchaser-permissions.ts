import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The code Phase 34 added: reading gift card purchaser details (policy 4). */
const PHASE_34_CODES: readonly PermissionCode[] = ["gift-cards.purchaser.view"];

/** Upgrades a Phase 33 database with the Phase 34 code and its system-role grants. */
export const securityGiftCardPurchaserPermissionsSeed: Seed = {
  key: "security.gift-card-purchaser-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_34_CODES),
};
