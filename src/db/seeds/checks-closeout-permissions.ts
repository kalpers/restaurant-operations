import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
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

/**
 * Upgrades a Phase 16 database, and on a fresh one finds the grants already in place. Only
 * the Phase 17 codes are granted, and only on system roles whose catalog entry holds them,
 * so a grant an administrator removed from another code stays removed.
 */
export const securityChecksCloseoutPermissionsSeed: Seed = {
  key: "security.checks-closeout-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) => PHASE_17_CODES.includes(permission.code)).map(
          (permission) => ({ ...permission }),
        ),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_17_CODES]));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

    for (const definition of ROLE_CATALOG) {
      const grants = definition.permissions
        .filter((code) => PHASE_17_CODES.includes(code))
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
