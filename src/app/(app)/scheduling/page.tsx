import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/scheduling/services/access";
import { listPeriods } from "@/modules/scheduling/services/schedule-service";
import { StatusBadge } from "@/components/format/status-badge";
import { EmptyState } from "@/components/ui/empty-state";

export default async function SchedulingPage() {
  const { location, actor } = await requirePageActor("schedule.view");
  const periods = await listPeriods(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Scheduling</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      {actorHolds(actor, "schedule.edit") && (
        <section className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
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
        <EmptyState title="No schedule periods yet." />
      ) : (
        <ul className="grid gap-2">
          {periods.map((period) => (
            <li key={period.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
              <Link
                href={`/scheduling/${period.id}`}
                className="font-medium underline"
              >
                {period.name}
              </Link>
              <span className="block text-sm text-neutral-600">
                {period.startDate} to {period.endDate} · <StatusBadge domain="schedulePeriod" status={period.status} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
