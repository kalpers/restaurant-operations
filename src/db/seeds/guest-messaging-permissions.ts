import type { PermissionCode } from "../../modules/auth/permission-catalog";
import { seedPermissionCodes } from "./permission-grants";
import type { Seed } from "./run-seeds";

/** The codes Phase 22 added: online booking and guest messaging (policy 19, D13). */
const PHASE_22_CODES: readonly PermissionCode[] = ["reservations.online.manage", "messages.view", "messages.resend"];

/** Upgrades a Phase 21 database with the Phase 22 codes and their system-role grants. */
export const securityGuestMessagingPermissionsSeed: Seed = {
  key: "security.guest-messaging-permissions",
  run: (transaction) => seedPermissionCodes(transaction, PHASE_22_CODES),
};
