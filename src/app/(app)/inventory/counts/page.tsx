import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { getDatabase } from "@/db";
import { requirePageActorWithAny } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/inventory/services/access";
import { listCounts } from "@/modules/inventory/services/count-service";
import { StatusBadge } from "@/components/format/status-badge";
import { EmptyState } from "@/components/ui/empty-state";

export default async function CountsPage() {
  const { location, actor } = await requirePageActorWithAny(["inventory.count", "inventory.count.approve"]);
  const counts = await listCounts(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Inventory counts</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory/counts" permissions={location.permissions} />

      {actorHolds(actor, "inventory.count") && (
        <section aria-label="Start a count" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-1 font-semibold">Start a count</h2>
          <p className="mb-3 text-sm text-neutral-600">
            Covers every active item stocked here. Expected quantities are captured now. Stock
            stays live while you count; anything that moves before approval is flagged.
          </p>
          <EntityForm
            method="POST"
            url="/api/inventory/counts"
            submitLabel="Start count"
            resetOnSuccess
            fields={[{ name: "name", label: "Count name", required: true }]}
          />
        </section>
      )}

      {counts.length === 0 ? (
        <EmptyState title="No counts yet." />
      ) : (
        <ul className="grid gap-2">
          {counts.map((count) => (
            <li
              key={count.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
            >
              <span>
                <span className="font-medium">{count.name}</span>{" "}
                <StatusBadge domain="inventoryCount" status={count.status} />
              </span>
              <Link
                href={`/inventory/counts/${count.id}`}
                className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium"
              >
                Open {count.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
