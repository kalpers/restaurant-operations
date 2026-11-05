import { RolePermissionsForm } from "@/components/admin/role-permissions-form";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { OWNER_ROLE_CODE } from "@/modules/auth/role-catalog";
import { hasPermission } from "@/modules/auth/services/permission-service";
import {
  listPermissions,
  listRoles,
} from "@/modules/auth/services/role-service";

export default async function RolesPage() {
  const { auth, location } = await requirePagePermission("admin.roles.view");
  const database = getDatabase();
  const [roles, catalog] = await Promise.all([
    listRoles(database, location.organizationId),
    listPermissions(database),
  ]);
  const canManage = hasPermission(
    auth,
    "admin.roles.manage",
    location.locationId,
  );

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Roles</h1>

      {canManage && (
        <section className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 font-semibold">Add a role</h2>
          <EntityForm
            method="POST"
            url="/api/admin/roles"
            submitLabel="Create role"
            resetOnSuccess
            fields={[
              { name: "code", label: "Code (for example SHIFT_LEAD)", required: true },
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description" },
            ]}
          />
        </section>
      )}

      <ul className="grid gap-4">
        {roles.map((role) => {
          const editable = canManage && role.code !== OWNER_ROLE_CODE;

          return (
            <li key={role.id} className="rounded border border-neutral-200 p-4">
              <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                <h2 className="font-semibold">
                  {role.name} ({role.code})
                </h2>
                <p>{role.active ? "Active" : "Inactive"}</p>
              </div>
              {role.description && (
                <p className="mb-2 text-neutral-700">{role.description}</p>
              )}
              <details>
                <summary className="flex min-h-11 cursor-pointer items-center font-medium">
                  {role.permissions.length} permissions
                </summary>
                {editable ? (
                  <RolePermissionsForm
                    key={role.version}
                    roleId={role.id}
                    version={role.version}
                    granted={role.permissions}
                    catalog={catalog}
                  />
                ) : (
                  <ul className="grid gap-1 sm:grid-cols-2">
                    {role.permissions.map((code) => (
                      <li key={code} className="text-sm">
                        {code}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
              {editable && !role.systemRole && (
                <div className="mt-3">
                  <ActionButton
                    method="PATCH"
                    url={`/api/admin/roles/${role.id}`}
                    body={{ active: !role.active, expectedVersion: role.version }}
                    label={role.active ? "Deactivate" : "Activate"}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
