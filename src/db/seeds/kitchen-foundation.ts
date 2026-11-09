import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** Codes Phase 10 added. `kitchen.view` and `kitchen.manage` are Phase 2. */
const PHASE_10_CODES: readonly PermissionCode[] = [
  "bar.view",
  "bar.manage",
  "fulfillment.start",
  "fulfillment.ready",
  "fulfillment.complete",
  "fulfillment.remake",
];

/** Phase 2 codes whose names changed when Kitchen and Bar got separate scopes. */
const RENAMED_CODES: readonly PermissionCode[] = ["kitchen.view", "kitchen.manage"];

/** Phase 2 grants Phase 10 adds to a system role, beyond the new codes. */
const EXTRA_GRANTS: readonly { roleCode: string; code: PermissionCode }[] = [
  { roleCode: "SERVER", code: "kitchen.view" },
];

/**
 * Bartenders held the Phase 2 `kitchen.manage` (then "kitchen and bar"), which was never
 * enforced. Phase 10 scopes it to kitchen stations, so Bartenders get `bar.manage` instead.
 */
const REVOKED_GRANTS: readonly { roleCode: string; code: PermissionCode }[] = [
  { roleCode: "BARTENDER", code: "kitchen.manage" },
];

/**
 * Upgrades a Phase 9 database, and on a fresh one finds the grants already in place. Only
 * the Phase 10 codes (and the listed extra grant) go to system roles, so a grant an
 * administrator removed stays removed. No tickets or notifications are seeded.
 */
export const securityKitchenPermissionsSeed: Seed = {
  key: "security.kitchen-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) => PHASE_10_CODES.includes(permission.code)).map(
          (permission) => ({ ...permission }),
        ),
      )
      .onConflictDoNothing({ target: permissions.code });

    for (const permission of PERMISSION_CATALOG.filter((entry) => RENAMED_CODES.includes(entry.code))) {
      await transaction
        .update(permissions)
        .set({ name: permission.name })
        .where(eq(permissions.code, permission.code));
    }

    const codes = [...PHASE_10_CODES, ...EXTRA_GRANTS.map((grant) => grant.code), ...REVOKED_GRANTS.map((grant) => grant.code)];
    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, codes));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));
    const systemRole = (code: string) =>
      transaction
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.code, code), eq(roles.systemRole, true)));

    for (const definition of ROLE_CATALOG) {
      const grants = [
        ...definition.permissions.filter((code) => PHASE_10_CODES.includes(code)),
        ...EXTRA_GRANTS.filter((grant) => grant.roleCode === definition.code).map((grant) => grant.code),
      ].flatMap((code) => {
        const permissionId = permissionIds.get(code);

        return permissionId ? [permissionId] : [];
      });

      if (grants.length === 0) {
        continue;
      }

      for (const role of await systemRole(definition.code)) {
        await transaction
          .insert(rolePermissions)
          .values(grants.map((permissionId) => ({ roleId: role.id, permissionId })))
          .onConflictDoNothing();
      }
    }

    for (const revoked of REVOKED_GRANTS) {
      const permissionId = permissionIds.get(revoked.code);

      if (!permissionId) {
        continue;
      }

      for (const role of await systemRole(revoked.roleCode)) {
        await transaction
          .delete(rolePermissions)
          .where(and(eq(rolePermissions.roleId, role.id), eq(rolePermissions.permissionId, permissionId)));
      }
    }
  },
};
