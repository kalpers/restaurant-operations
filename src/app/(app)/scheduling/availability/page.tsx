import Link from "next/link";

import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listColleagues } from "@/modules/scheduling/services/my-schedule-service";
import { EmptyState } from "@/components/ui/empty-state";

export default async function EmployeeAvailabilityListPage() {
  const { location, actor } = await requirePageActor(
    "schedule.availability.manage",
  );
  const employees = await listColleagues(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Availability</h1>
      <p className="mb-4 text-neutral-600">
        Maintain availability for employees at {location.locationName}, including
        those without a login.
      </p>

      {employees.length === 0 ? (
        <EmptyState title="No employees at this location yet." />
      ) : (
        <ul className="grid gap-2">
          {employees.map((employee) => (
            <li key={employee.id}>
              <Link
                href={`/scheduling/availability/${employee.id}`}
                className="flex min-h-11 items-center rounded-lg border border-neutral-200 bg-surface shadow-sm px-3 font-medium underline"
              >
                {employee.displayName}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
