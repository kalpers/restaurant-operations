import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** Codes Phase 6 added. `reservations.view` and `.manage` are older and unchanged. */
const PHASE_6_CODES: readonly PermissionCode[] = [
  "reservations.override-hold",
  "waitlist.view",
  "waitlist.manage",
  "waitlist.notify",
  "waitlist.seat",
];

/**
 * Upgrades a Phase 5 database, and on a fresh one finds the grants already in place.
 * Only Phase 6 codes are granted, on system roles, so a grant an administrator removed
 * from any other permission stays removed. The hold windows are location settings
 * columns whose defaults (15 and 15) the migration applies, so there is nothing to seed.
 */
export const securityReservationsPermissionsSeed: Seed = {
  key: "security.reservations-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) =>
          PHASE_6_CODES.includes(permission.code),
        ).map((permission) => ({ ...permission })),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_6_CODES]));
    const permissionIds = new Map(
      permissionRows.map((row) => [row.code, row.id]),
    );

    for (const definition of ROLE_CATALOG) {
      const grants = definition.permissions.flatMap((code) => {
        const permissionId = permissionIds.get(code);

        return permissionId ? [permissionId] : [];
      });

      if (grants.length === 0) {
        continue;
      }

      const roleRows = await transaction
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.code, definition.code), eq(roles.systemRole, true)));

      for (const role of roleRows) {
        await transaction
          .insert(rolePermissions)
          .values(
            grants.map((permissionId) => ({ roleId: role.id, permissionId })),
          )
          .onConflictDoNothing();
      }
    }
  },
};
