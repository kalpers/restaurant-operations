import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** Codes Phase 9 added. `orders.create`, `.submit`, `.void` and `.close` are Phase 2. */
const PHASE_9_CODES: readonly PermissionCode[] = [
  "orders.view",
  "orders.edit",
  "orders.discount.apply",
  "orders.discount.manage",
];

/**
 * Upgrades a Phase 8 database, and on a fresh one finds the grants already in place. Only
 * the Phase 9 codes are granted, and only on system roles, so a grant an administrator
 * removed stays removed. No orders or discount definitions are seeded.
 */
export const securityOrdersPermissionsSeed: Seed = {
  key: "security.orders-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) => PHASE_9_CODES.includes(permission.code)).map(
          (permission) => ({ ...permission }),
        ),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_9_CODES]));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

    for (const definition of ROLE_CATALOG) {
      const grants = definition.permissions
        .filter((code) => PHASE_9_CODES.includes(code))
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
