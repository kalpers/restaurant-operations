import Link from "next/link";

import { humanize } from "@/components/employees/format";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/scheduling/services/access";
import { listPeriods } from "@/modules/scheduling/services/schedule-service";

export default async function SchedulingPage() {
  const { location, actor } = await requirePageActor("schedule.view");
  const periods = await listPeriods(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Scheduling</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      {actorHolds(actor, "schedule.edit") && (
        <section className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 font-semibold">Create a schedule period</h2>
          <EntityForm
            method="POST"
            url="/api/scheduling/periods"
            submitLabel="Create period"
            resetOnSuccess
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "startDate", label: "Start date", type: "date", required: true },
              { name: "endDate", label: "End date", type: "date", required: true },
            ]}
          />
        </section>
      )}

      {periods.length === 0 ? (
        <p className="text-neutral-600">No schedule periods yet.</p>
      ) : (
        <ul className="grid gap-2">
          {periods.map((period) => (
            <li key={period.id} className="rounded border border-neutral-200 p-3">
              <Link
                href={`/scheduling/${period.id}`}
                className="font-medium underline"
              >
                {period.name}
              </Link>
              <span className="block text-sm text-neutral-600">
                {period.startDate} to {period.endDate} · {humanize(period.status)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
