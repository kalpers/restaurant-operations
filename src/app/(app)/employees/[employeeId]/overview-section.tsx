import Link from "next/link";

import { dateRange, humanize, optionsFrom } from "@/components/employees/format";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { listUsersAtLocation } from "@/modules/auth/services/user-service";
import type { Actor, AuthContext } from "@/modules/auth/types";
import type { EmployeeGeneralDetail } from "@/modules/employees/dto/employee-dto";
import { actorHolds } from "@/modules/employees/services/access";
import { listPositions } from "@/modules/employees/services/reference-service";
import { getEmployeeEmployment } from "@/modules/employees/services/status-service";
import { getLinkedUser } from "@/modules/employees/services/user-link-service";
import { EMPLOYMENT_TYPES } from "@/modules/employees/types";

const CHANGEABLE_STATUSES = ["ACTIVE", "ON_LEAVE", "SUSPENDED"] as const;

type OverviewProps = {
  actor: Actor;
  auth: AuthContext;
  employeeId: string;
  employee: EmployeeGeneralDetail;
};

export async function OverviewSection(props: OverviewProps) {
  const { actor, employee } = props;

  return (
    <div className="grid gap-8">
      <section>
        <h2 className="mb-3 text-lg font-semibold">Details</h2>
        <dl className="mb-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-neutral-600">Preferred name</dt>
            <dd>{employee.preferredName ?? "None"}</dd>
          </div>
          <div>
            <dt className="text-sm text-neutral-600">Work email</dt>
            <dd className="break-all">{employee.workEmail ?? "None"}</dd>
          </div>
          <div>
            <dt className="text-sm text-neutral-600">Hire date</dt>
            <dd>{employee.hireDate}</dd>
          </div>
          <div>
            <dt className="text-sm text-neutral-600">Employment type</dt>
            <dd>{humanize(employee.employmentType)}</dd>
          </div>
        </dl>
        {actorHolds(actor, "employees.edit") && (
          <EntityForm
            method="PATCH"
            url={`/api/employees/${employee.id}`}
            submitLabel="Save details"
            hidden={{ expectedVersion: employee.version }}
            fields={[
              { name: "firstName", label: "First name", required: true, defaultValue: employee.firstName },
              { name: "middleName", label: "Middle name", defaultValue: employee.middleName },
              { name: "lastName", label: "Last name", required: true, defaultValue: employee.lastName },
              { name: "preferredName", label: "Preferred name", defaultValue: employee.preferredName },
              { name: "workEmail", label: "Work email", type: "email", defaultValue: employee.workEmail },
              { name: "employmentType", label: "Employment type", type: "select", required: true, defaultValue: employee.employmentType, options: optionsFrom(EMPLOYMENT_TYPES) },
            ]}
          />
        )}
      </section>

      <AssignmentsPanel {...props} />
      {actorHolds(actor, "hr.view") && <EmploymentPanel {...props} />}
      {actorHolds(actor, "admin.users.view") && <UserLinkPanel {...props} />}
    </div>
  );
}

async function AssignmentsPanel({ actor, auth, employee }: OverviewProps) {
  const canManageLocations = actorHolds(actor, "employees.locations.manage");
  const canManagePositions = actorHolds(actor, "employees.positions.manage");
  const base = `/api/employees/${employee.id}`;
  const hidden = { expectedVersion: employee.version };
  const locationOptions = (permission: "employees.locations.manage" | "employees.positions.manage") =>
    auth.locations
      .filter((location) =>
        hasPermission(auth, permission, location.locationId),
      )
      .map((location) => ({
        value: location.locationId,
        label: location.locationName,
      }));
  const positions = canManagePositions
    ? (await listPositions(getDatabase(), actor)).filter(
        (position) => position.active,
      )
    : [];

  return (
    <section className="grid gap-6">
      <div>
        <h2 className="mb-3 text-lg font-semibold">Locations</h2>
        <ul className="mb-4 grid gap-3">
          {employee.locations.map((assignment) => (
            <li key={assignment.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
              <p className="font-medium">
                {assignment.locationName}
                {assignment.primaryLocation && " (primary)"}
              </p>
              <p className="mb-2 text-sm text-neutral-600">
                {dateRange(assignment.effectiveFrom, assignment.effectiveTo)}
              </p>
              {canManageLocations && assignment.active && (
                <div className="grid gap-3">
                  {!assignment.primaryLocation && (
                    <ActionButton
                      method="PUT"
                      url={`${base}/locations/${assignment.id}/primary`}
                      body={hidden}
                      label="Make primary"
                    />
                  )}
                  <EntityForm
                    method="PATCH"
                    url={`${base}/locations/${assignment.id}`}
                    submitLabel="End location"
                    hidden={hidden}
                    fields={[{ name: "effectiveTo", label: "End date", type: "date", required: true }]}
                  />
                </div>
              )}
            </li>
          ))}
          {employee.locations.length === 0 && (
            <li className="text-neutral-600">No current locations.</li>
          )}
        </ul>
        {canManageLocations && (
          <EntityForm
            method="POST"
            url={`${base}/locations`}
            submitLabel="Add location"
            hidden={hidden}
            fields={[
              { name: "locationId", label: "Location", type: "select", required: true, options: locationOptions("employees.locations.manage") },
              { name: "effectiveFrom", label: "Start date", type: "date", required: true },
            ]}
          />
        )}
      </div>

      <div>
        <h2 className="mb-1 text-lg font-semibold">Positions</h2>
        <p className="mb-3 text-sm text-neutral-600">
          Work this person performs. Positions don&apos;t grant software access.
        </p>
        <ul className="mb-4 grid gap-3">
          {employee.positions.map((assignment) => (
            <li key={assignment.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
              <p className="font-medium">
                {assignment.positionName}
                {assignment.primaryPosition && " (primary)"}
              </p>
              <p className="mb-2 text-sm text-neutral-600">
                {assignment.locationName},{" "}
                {dateRange(assignment.effectiveFrom, assignment.effectiveTo)}
              </p>
              {canManagePositions && assignment.active && (
                <div className="grid gap-3">
                  {!assignment.primaryPosition && (
                    <ActionButton
                      method="PUT"
                      url={`${base}/positions/${assignment.id}/primary`}
                      body={hidden}
                      label="Make primary"
                    />
                  )}
                  <EntityForm
                    method="PATCH"
                    url={`${base}/positions/${assignment.id}`}
                    submitLabel="End position"
                    hidden={hidden}
                    fields={[{ name: "effectiveTo", label: "End date", type: "date", required: true }]}
                  />
                </div>
              )}
            </li>
          ))}
          {employee.positions.length === 0 && (
            <li className="text-neutral-600">No current positions.</li>
          )}
        </ul>
        {canManagePositions && (
          <EntityForm
            method="POST"
            url={`${base}/positions`}
            submitLabel="Add position"
            hidden={hidden}
            fields={[
              { name: "positionId", label: "Position", type: "select", required: true, options: positions.map((position) => ({ value: position.id, label: position.name })) },
              { name: "locationId", label: "Position location", type: "select", required: true, options: locationOptions("employees.positions.manage") },
              { name: "effectiveFrom", label: "Start date", type: "date", required: true },
              { name: "primaryPosition", label: "Primary position", type: "checkbox" },
            ]}
          />
        )}
      </div>
    </section>
  );
}

async function EmploymentPanel({ actor, employeeId }: OverviewProps) {
  const employment = await getEmployeeEmployment(
    getDatabase(),
    actor,
    employeeId,
  );
  const terminated = employment.employmentStatus === "TERMINATED";
  const hidden = { expectedVersion: employment.version };

  return (
    <section>
      <h2 className="mb-3 text-lg font-semibold">Employment</h2>
      <p className="mb-1">
        Status: <strong>{humanize(employment.employmentStatus)}</strong>
      </p>
      {employment.terminationDate && (
        <p className="mb-1">Terminated on {employment.terminationDate}</p>
      )}

      <h3 className="mt-4 mb-2 font-medium">Status history</h3>
      <ul className="mb-4 grid gap-2 text-sm">
        {employment.statusHistory.map((entry) => (
          <li key={entry.id}>
            {humanize(entry.status)} on {entry.effectiveAt.toISOString().slice(0, 10)},
            by <span className="break-all">{entry.changedByEmail}</span>
            {entry.reason && `: ${entry.reason}`}
          </li>
        ))}
      </ul>

      {!terminated && actorHolds(actor, "employees.edit") && (
        <div className="mb-6">
          <EntityForm
            method="POST"
            url={`/api/employees/${employeeId}/status`}
            submitLabel="Change status"
            hidden={hidden}
            fields={[
              { name: "status", label: "New status", type: "select", required: true, options: optionsFrom(CHANGEABLE_STATUSES) },
              { name: "reason", label: "Status reason" },
            ]}
          />
        </div>
      )}

      {!terminated && actorHolds(actor, "employees.terminate") && (
        <div className="rounded border border-red-200 p-4">
          <h3 className="mb-1 font-medium">Terminate employee</h3>
          <p className="mb-3 text-sm text-neutral-600">
            This is final. It ends all location and position assignments and
            disables any linked login. All history is kept.
          </p>
          <EntityForm
            method="POST"
            url={`/api/employees/${employeeId}/terminate`}
            submitLabel="Terminate employee"
            hidden={hidden}
            fields={[
              { name: "terminationDate", label: "Termination date", type: "date", required: true },
              { name: "reason", label: "Termination reason" },
            ]}
          />
        </div>
      )}
    </section>
  );
}

async function UserLinkPanel({ actor, employeeId, employee }: OverviewProps) {
  const database = getDatabase();
  const linked = await getLinkedUser(database, actor, employeeId);
  const canManage =
    actorHolds(actor, "employees.edit") &&
    actorHolds(actor, "admin.users.manage");
  const users =
    canManage && !linked
      ? await listUsersAtLocation(database, actor.locationId)
      : [];
  const hidden = { expectedVersion: employee.version };

  return (
    <section>
      <h2 className="mb-1 text-lg font-semibold">Application login</h2>
      <p className="mb-3 text-sm text-neutral-600">
        A link identifies this person&apos;s login. It doesn&apos;t change their
        roles or positions.
      </p>
      {linked ? (
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/admin/users" className="break-all underline">
            {linked.email}
          </Link>
          {canManage && (
            <ActionButton
              method="DELETE"
              url={`/api/employees/${employeeId}/user-link`}
              body={hidden}
              label="Unlink user"
              confirm={{ title: "Unlink this user account?", body: "The employee record stays. The login is no longer linked to it." }}
            />
          )}
        </div>
      ) : (
        <p className="mb-3">No linked login.</p>
      )}
      {canManage && !linked && (
        <EntityForm
          method="PUT"
          url={`/api/employees/${employeeId}/user-link`}
          submitLabel="Link user"
          hidden={hidden}
          fields={[
            { name: "userId", label: "User", type: "select", required: true, options: users.map((user) => ({ value: user.id, label: user.email })) },
          ]}
        />
      )}
    </section>
  );
}
