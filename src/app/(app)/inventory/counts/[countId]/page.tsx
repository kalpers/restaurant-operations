import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { COUNT_STATUS_LABELS, formatQuantity } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActorWithAny } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/inventory/services/access";
import { getCount } from "@/modules/inventory/services/count-service";
import { NotFoundError } from "@/shared/errors/app-error";

export default async function CountPage({ params }: { params: Promise<{ countId: string }> }) {
  const { actor } = await requirePageActorWithAny(["inventory.count", "inventory.count.approve"]);
  const parsed = z.uuid().safeParse((await params).countId);

  if (!parsed.success) {
    notFound();
  }

  const { count, lines } = await getCount(getDatabase(), actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const editable = count.status === "DRAFT" && actorHolds(actor, "inventory.count");
  const activity = lines.filter((line) => line.activitySinceSnapshot).length;

  return (
    <>
      <p className="mb-2">
        <Link href="/inventory/counts" className="text-sm underline">
          Back to counts
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold">{count.name}</h1>
      <p className="mb-4 text-neutral-600" aria-label="Count status">
        {COUNT_STATUS_LABELS[count.status] ?? count.status}
        {count.activityAcknowledgedAt && " · Later stock activity acknowledged at approval"}
      </p>

      <ul className="mb-8 grid gap-3">
        {lines.map((line) => (
          <li
            key={line.id}
            aria-label={`Count line ${line.itemName}`}
            className="rounded border border-neutral-200 p-4"
          >
            <p className="font-medium">{line.itemName}</p>
            <p className="text-sm">
              Expected {formatQuantity(line.expectedQuantity)} {line.unitCode}
              {line.countedQuantity !== null &&
                ` · counted ${formatQuantity(line.countedQuantity)} · variance ${formatQuantity(line.varianceQuantity)}`}
            </p>
            {line.activitySinceSnapshot && (
              <p className="text-sm text-amber-800">Stock has moved since this line was captured.</p>
            )}
            {editable && (
              <div className="mt-3">
                <EntityForm
                  method="PATCH"
                  url={`/api/inventory/counts/${count.id}/lines/${line.id}`}
                  submitLabel={`Save ${line.itemName}`}
                  hidden={{ expectedVersion: line.version }}
                  fields={[
                    {
                      name: "countedQuantity",
                      label: `Counted ${line.itemName} (${line.unitCode})`,
                      defaultValue: line.countedQuantity === null ? null : formatQuantity(line.countedQuantity),
                    },
                    { name: "notes", label: "Notes", defaultValue: line.notes },
                  ]}
                />
              </div>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-3">
        {editable && (
          <ActionButton
            method="POST"
            url={`/api/inventory/counts/${count.id}/submit`}
            body={{ expectedVersion: count.version }}
            label="Submit count"
          />
        )}
        {(count.status === "DRAFT" || count.status === "SUBMITTED") && (
          <ActionButton
            method="POST"
            url={`/api/inventory/counts/${count.id}/cancel`}
            body={{ expectedVersion: count.version }}
            label="Cancel count"
          />
        )}
      </div>

      {count.status === "SUBMITTED" && actorHolds(actor, "inventory.count.approve") && (
        <section aria-label="Approve count" className="mt-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-1 text-xl font-semibold">Approve</h2>
          <p className="mb-3 text-sm text-neutral-600">
            Each variance is posted against current stock as a count adjustment. Stock isn&apos;t
            set to the counted figure.
            {activity > 0 &&
              ` ${activity} line${activity === 1 ? " has" : "s have"} moved since the count started: acknowledge to approve.`}
          </p>
          <EntityForm
            method="POST"
            url={`/api/inventory/counts/${count.id}/approve`}
            submitLabel="Approve count"
            hidden={{ expectedVersion: count.version }}
            fields={
              activity > 0
                ? [{ name: "acknowledgeActivity", label: "I've reviewed the stock activity since the count started", type: "checkbox" }]
                : []
            }
          />
          <div className="mt-3">
            <ActionButton
              method="POST"
              url={`/api/inventory/counts/${count.id}/return`}
              body={{ expectedVersion: count.version }}
              label="Return for correction"
            />
          </div>
        </section>
      )}
    </>
  );
}
