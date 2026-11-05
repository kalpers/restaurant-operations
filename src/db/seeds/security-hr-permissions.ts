import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** Permissions Phase 3 added or newly grants, including `hr.view` for the Manager. */
const PHASE_3_CODES: ReadonlySet<PermissionCode> = new Set(
  PERMISSION_CATALOG.map((permission) => permission.code).filter(
    (code) =>
      (code.startsWith("hr.") ||
        code === "employees.create" ||
        code === "employees.terminate" ||
        code === "employees.positions.manage" ||
        code === "employees.locations.manage") &&
      code !== "hr.compensation.view" &&
      code !== "hr.compensation.edit",
  ),
);

/**
 * Upgrades a Phase 2 database, and changes nothing on a fresh one, where
 * `security.initial` already applied the current catalog. Only Phase 3 codes are
 * granted, on system roles, so a grant an administrator removed from any other
 * permission stays removed.
 */
export const securityHrPermissionsSeed: Seed = {
  key: "security.hr-permissions-v2",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(PERMISSION_CATALOG.map((permission) => ({ ...permission })))
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_3_CODES]));
    const permissionIds = new Map(
      permissionRows.map((row) => [row.code, row.id]),
    );

    for (const definition of ROLE_CATALOG) {
      const roleRows = await transaction
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.code, definition.code), eq(roles.systemRole, true)));

      // The only role whose meaning Phase 3 changed.
      if (definition.code === "MANAGER") {
        await transaction
          .update(roles)
          .set({ description: definition.description })
          .where(
            and(eq(roles.code, definition.code), eq(roles.systemRole, true)),
          );
      }

      const grants = definition.permissions.flatMap((code) => {
        const permissionId = permissionIds.get(code);

        return permissionId ? [permissionId] : [];
      });

      for (const role of roleRows) {
        if (grants.length > 0) {
          await transaction
            .insert(rolePermissions)
            .values(
              grants.map((permissionId) => ({ roleId: role.id, permissionId })),
            )
            .onConflictDoNothing();
        }
      }
    }
  },
};
