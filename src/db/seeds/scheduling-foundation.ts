import { and, eq, inArray } from "drizzle-orm";

import {
  PERMISSION_CATALOG,
  type PermissionCode,
} from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import {
  locationSettings,
  permissions,
  rolePermissions,
  roles,
  schedulingRules,
} from "../schema";
import type { Seed } from "./run-seeds";

/** The permissions Phase 4 added. The four older `schedule.*` codes are unchanged. */
const PHASE_4_CODES: readonly PermissionCode[] = [
  "schedule.availability.self",
  "schedule.availability.manage",
  "schedule.time-off.request",
  "schedule.time-off.approve",
  "schedule.swap.request",
  "schedule.swap.approve",
  "schedule.templates.manage",
  "schedule.rules.manage",
];

/**
 * Upgrades a Phase 3 database, and changes nothing on a fresh one. Only Phase 4 codes are
 * granted, on system roles, so a grant an administrator removed from any other permission
 * stays removed.
 */
export const securitySchedulingPermissionsSeed: Seed = {
  key: "security.scheduling-permissions",
  run: async (transaction) => {
    await transaction
      .insert(permissions)
      .values(
        PERMISSION_CATALOG.filter((permission) =>
          PHASE_4_CODES.includes(permission.code),
        ).map((permission) => ({ ...permission })),
      )
      .onConflictDoNothing({ target: permissions.code });

    const permissionRows = await transaction
      .select({ id: permissions.id, code: permissions.code })
      .from(permissions)
      .where(inArray(permissions.code, [...PHASE_4_CODES]));
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

/**
 * Default rules for scheduling-enabled locations. Column defaults hold the values, and
 * minimum rest is added here as a soft 8 hours. No staffing demand or employee records
 * are created.
 */
export const schedulingDefaultRulesSeed: Seed = {
  key: "scheduling.default-rules",
  run: async (transaction) => {
    const enabled = await transaction
      .select({ locationId: locationSettings.locationId })
      .from(locationSettings)
      .where(eq(locationSettings.schedulingEnabled, true));

    if (enabled.length > 0) {
      await transaction
        .insert(schedulingRules)
        .values(
          enabled.map(({ locationId }) => ({
            locationId,
            minimumRestHours: "8.00",
          })),
        )
        .onConflictDoNothing({ target: schedulingRules.locationId });
    }
  },
};
