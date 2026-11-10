import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** Codes Phase 16 added: the System health page and dead-letter retry. */
const PHASE_16_CODES: readonly PermissionCode[] = ["admin.system.view", "admin.system.manage"];

/**
 * Upgrades a Phase 15 database, and on a fresh one finds the grants already in place. Only
 * the Phase 16 codes are granted, and only on system roles whose catalog entry holds them
 * (Owner and General Manager), so a grant an administrator removed stays removed.
 */
export const securitySystemPermissionsSeed: Seed = {
  key: "security.system-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) => PHASE_16_CODES.includes(permission.code)).map(
          (permission) => ({ ...permission }),
        ),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_16_CODES]));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

    for (const definition of ROLE_CATALOG) {
      const grants = definition.permissions
        .filter((code) => PHASE_16_CODES.includes(code))
        .flatMap((code) => {
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
          .values(grants.map((permissionId) => ({ roleId: role.id, permissionId })))
          .onConflictDoNothing();
      }
    }
  },
};
