import Link from "next/link";

import { humanize, optionsFrom } from "@/components/employees/format";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/employees/services/access";
import { listEmployees } from "@/modules/employees/services/employee-service";
import { listPositions } from "@/modules/employees/services/reference-service";
import { EMPLOYMENT_TYPES } from "@/modules/employees/types";
import { EmptyState } from "@/components/ui/empty-state";

export default async function EmployeesPage() {
  const { location, actor } = await requirePageActor("employees.view");
  const database = getDatabase();
  const employees = await listEmployees(database, actor);
  const canCreate = actorHolds(actor, "employees.create");
  const canAssignPosition = actorHolds(actor, "employees.positions.manage");
  const showStatus = actorHolds(actor, "hr.view");
  const positions =
    canCreate && canAssignPosition
      ? (await listPositions(database, actor)).filter(
          (position) => position.active,
        )
      : [];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Employees</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      {canCreate && (
        <section className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 font-semibold">Add an employee</h2>
          <p className="mb-3 text-sm text-neutral-600">
            This creates an employment record only. It doesn&apos;t create a login
            or grant any software access.
          </p>
          <EntityForm
            method="POST"
            url="/api/employees"
            submitLabel="Create employee"
            resetOnSuccess
            fields={[
              { name: "employeeNumber", label: "Employee number", required: true },
              { name: "firstName", label: "First name", required: true },
              { name: "middleName", label: "Middle name" },
              { name: "lastName", label: "Last name", required: true },
              { name: "preferredName", label: "Preferred name" },
              { name: "workEmail", label: "Work email", type: "email" },
              { name: "hireDate", label: "Hire date", type: "date", required: true },
              { name: "employmentType", label: "Employment type", type: "select", required: true, options: optionsFrom(EMPLOYMENT_TYPES) },
              ...(canAssignPosition
                ? [
                    {
                      name: "positionId",
                      label: "Initial position",
                      type: "select" as const,
                      options: [
                        { value: "", label: "None" },
                        ...positions.map((position) => ({
                          value: position.id,
                          label: position.name,
                        })),
                      ],
                    },
                  ]
                : []),
            ]}
          />
        </section>
      )}

      {employees.length === 0 ? (
        <EmptyState title="No employees at this location yet." />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-neutral-200 bg-surface shadow-sm">
          <table className="w-full min-w-max border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-neutral-100 text-neutral-800">
              <tr className="border-b border-neutral-300">
                <th className="px-2 py-2 font-semibold">Number</th>
                <th className="px-2 py-2 font-semibold">Name</th>
                <th className="px-2 py-2 font-semibold">Primary location</th>
                <th className="px-2 py-2 font-semibold">Primary position</th>
                {showStatus && (
                  <th className="px-2 py-2 font-semibold">Status</th>
                )}
                <th className="px-2 py-2 font-semibold">Type</th>
              </tr>
            </thead>
            <tbody className="[&>tr:nth-child(even)]:bg-neutral-50">
              {employees.map((employee) => (
                <tr key={employee.id} className="border-b border-neutral-200">
                  <td className="px-2 py-2">{employee.employeeNumber}</td>
                  <td className="px-2 py-2">
                    <Link
                      href={`/employees/${employee.id}`}
                      className="font-medium underline"
                    >
                      {employee.lastName}, {employee.firstName}
                    </Link>
                    {employee.preferredName && (
                      <span className="text-neutral-600">
                        {" "}
                        ({employee.preferredName})
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {employee.primaryLocationName ?? "None"}
                  </td>
                  <td className="px-2 py-2">
                    {employee.primaryPositionName ?? "None"}
                  </td>
                  {showStatus && (
                    <td className="px-2 py-2">
                      {humanize(employee.employmentStatus ?? "")}
                    </td>
                  )}
                  <td className="px-2 py-2">
                    {humanize(employee.employmentType)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
