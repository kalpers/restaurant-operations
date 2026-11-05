import { PERMISSION_CATALOG } from "../../modules/auth/permission-catalog";
import { ROLE_CATALOG } from "../../modules/auth/role-catalog";
import { organizations, permissions, rolePermissions, roles } from "../schema";
import type { Seed } from "./run-seeds";

/** The permission catalog, the nine system roles and the starting matrix. */
export const securityFoundationSeed: Seed = {
  key: "security.initial",
  run: async (transaction) => {
    const [organization, ...others] = await transaction
      .select({ id: organizations.id })
      .from(organizations);

    if (!organization || others.length > 0) {
      throw new Error("The security seed needs exactly one organization.");
    }

    const permissionRows = await transaction
      .insert(permissions)
      .values(PERMISSION_CATALOG.map((permission) => ({ ...permission })))
      .returning({ id: permissions.id, code: permissions.code });

    const permissionIds = new Map(permissionRows.map((row) => [row.code, row.id]));

    for (const definition of ROLE_CATALOG) {
      const [role] = await transaction
        .insert(roles)
        .values({
          organizationId: organization.id,
          code: definition.code,
          name: definition.name,
          description: definition.description,
          systemRole: true,
        })
        .returning({ id: roles.id });

      if (!role) {
        throw new Error("Seed insert returned no role.");
      }

      await transaction.insert(rolePermissions).values(
        definition.permissions.map((code) => {
          const permissionId = permissionIds.get(code);

          if (!permissionId) {
            throw new Error(`Role matrix references unknown permission ${code}.`);
          }

          return { roleId: role.id, permissionId };
        }),
      );
    }
  },
};
