import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** Codes Phase 11 added. `settlements.complete` is Phase 2. */
const PHASE_11_CODES: readonly PermissionCode[] = [
  "settlements.view",
  "settlements.create",
  "settlements.tender.cash",
  "settlements.tender.external-card",
  "settlements.tender.gift-card",
  "settlements.tender.house-account",
  "settlements.tender.other",
  "settlements.void-tender",
  "settlements.view-card-metadata",
];

/**
 * Upgrades a Phase 10 database, and on a fresh one finds the grants already in place. Only
 * the Phase 11 codes are granted, and only on system roles, so a grant an administrator
 * removed stays removed. No settlements or tenders are seeded: financial history comes only
 * from real operations and test fixtures.
 */
export const securitySettlementPermissionsSeed: Seed = {
  key: "security.settlement-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) => PHASE_11_CODES.includes(permission.code)).map(
          (permission) => ({ ...permission }),
        ),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_11_CODES]));
    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

    for (const definition of ROLE_CATALOG) {
      const grants = definition.permissions
        .filter((code) => PHASE_11_CODES.includes(code))
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
