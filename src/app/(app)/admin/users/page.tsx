import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { MINIMUM_PASSWORD_LENGTH } from "@/modules/auth/password";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { listRoles } from "@/modules/auth/services/role-service";
import { listUsersAtLocation } from "@/modules/auth/services/user-service";

export default async function UsersPage() {
  const { auth, location } = await requirePagePermission("admin.users.view");
  const database = getDatabase();
  const users = await listUsersAtLocation(database, location.locationId);
  const canManage = hasPermission(
    auth,
    "admin.users.manage",
    location.locationId,
  );

  // Only offers roles the server would accept. The server still enforces this.
  const assignableRoles = canManage
    ? (await listRoles(database, location.organizationId)).filter(
        (role) =>
          role.active &&
          role.permissions.every((code) =>
            (location.permissions as string[]).includes(code),
          ),
      )
    : [];
  const roleOptions = assignableRoles.map((role) => ({
    value: role.id,
    label: role.name,
  }));

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Users</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      {canManage && (
        <section className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 font-semibold">Add a user</h2>
          <EntityForm
            method="POST"
            url="/api/admin/users"
            submitLabel="Create user"
            resetOnSuccess
            fields={[
              { name: "email", label: "Email", type: "email", required: true, autoComplete: "off" },
              { name: "password", label: `Initial password (${MINIMUM_PASSWORD_LENGTH}+ characters)`, type: "password", required: true, minLength: MINIMUM_PASSWORD_LENGTH, autoComplete: "new-password" },
              { name: "roleId", label: "Role at this location", type: "select", required: true, options: roleOptions },
            ]}
          />
        </section>
      )}

      <ul className="grid gap-4">
        {users.map((user) => (
          <li key={user.id} className="rounded border border-neutral-200 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium break-all">{user.email}</p>
              <p className={user.active ? "text-green-800" : "text-red-700"}>
                {user.active ? "Active" : "Disabled"}
              </p>
            </div>
            <ul className="mb-3 grid gap-2">
              {user.roles.map((role) => (
                <li key={role.id} className="flex flex-wrap items-center gap-3">
                  <span>{role.name}</span>
                  {canManage && (
                    <ActionButton
                      method="DELETE"
                      url={`/api/admin/users/${user.id}/roles/${role.id}`}
                      label={`Remove ${role.name}`}
                    />
                  )}
                </li>
              ))}
              {user.roles.length === 0 && (
                <li className="text-neutral-600">No role at this location</li>
              )}
            </ul>
            {canManage && (
              <div className="grid gap-4">
                {user.id !== auth.userId && (
                  <ActionButton
                    method="PATCH"
                    url={`/api/admin/users/${user.id}`}
                    body={{ active: !user.active, expectedVersion: user.version }}
                    label={user.active ? "Disable" : "Enable"}
                  />
                )}
                <EntityForm
                  method="POST"
                  url={`/api/admin/users/${user.id}/roles`}
                  submitLabel="Assign role"
                  fields={[
                    { name: "roleId", label: "Add a role", type: "select", required: true, options: roleOptions },
                  ]}
                />
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
