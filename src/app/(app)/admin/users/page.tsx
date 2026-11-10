import { ResetPasswordButton } from "@/components/admin/reset-password-button";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { MINIMUM_PASSWORD_LENGTH } from "@/modules/auth/password";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { listRoles } from "@/modules/auth/services/role-service";
import { listUsersAtLocation } from "@/modules/auth/services/user-service";
import { listLocationsWithSettings } from "@/modules/organization/services/organization-service";

function formatLockTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(value);
}

export default async function UsersPage() {
  const { auth, location } = await requirePagePermission("admin.users.view");
  const database = getDatabase();
  const users = await listUsersAtLocation(database, location.locationId);
  const [locationRow] = await listLocationsWithSettings(database, [location.locationId]);
  const timeZone = locationRow?.location.timezone ?? "UTC";
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
        <section className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
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
          <li key={user.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium break-all">{user.email}</p>
              <div className="flex flex-wrap items-center gap-3">
                {user.lockedUntil && (
                  <p className="text-warning-800" data-testid="user-locked">
                    Locked until {formatLockTime(user.lockedUntil, timeZone)}
                  </p>
                )}
                {user.mustChangePassword && (
                  <p className="text-neutral-600">Must change password</p>
                )}
                <p className={user.active ? "text-success-800" : "text-danger-700"}>
                  {user.active ? "Active" : "Disabled"}
                </p>
              </div>
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
                      confirm={{ title: `Remove the ${role.name} role?`, body: "This user loses the role's permissions at this location.", confirmLabel: "Remove role" }}
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
                {user.lockedUntil && (
                  <ActionButton
                    method="POST"
                    url={`/api/admin/users/${user.id}/unlock`}
                    label="Unlock"
                    confirm={{ title: "Unlock this account?", body: "The sign-in lockout ends now. Their password doesn't change.", confirmLabel: "Unlock" }}
                  />
                )}
                {user.id !== auth.userId && (
                  <ResetPasswordButton userId={user.id} email={user.email} version={user.version} />
                )}
                {user.id !== auth.userId && (
                  <ActionButton
                    method="PATCH"
                    url={`/api/admin/users/${user.id}`}
                    body={{ active: !user.active, expectedVersion: user.version }}
                    label={user.active ? "Disable" : "Enable"}
                    confirm={user.active ? { title: "Disable this user?", body: "They can't sign in until the account is enabled again.", confirmLabel: "Disable user" } : undefined}
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
