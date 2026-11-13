import Link from "next/link";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { formatQuantity } from "@/components/inventory/format";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/inventory/services/access";
import { listLots } from "@/modules/inventory/services/lot-service";

const STATUS = {
  OK: { tone: "neutral", label: "OK" },
  EXPIRING: { tone: "warning", label: "Expiring soon" },
  EXPIRED: { tone: "danger", label: "Expired" },
} as const;

const ORIGIN: Record<string, string> = {
  RECEIPT: "Received",
  TRANSFER: "Transferred in",
  OPENING: "On hand when tracking started",
  FOUND: "Found or counted",
};

/**
 * Phase 23 (policies 21–22): lots with stock left here, first to expire first. Expired and
 * expiring lots can be wasted in one step; a mistyped code or date can be corrected.
 */
export default async function LotsPage() {
  const { location, actor } = await requirePageActor("inventory.view");
  const { lots, businessDate, warningDays } = await listLots(getDatabase(), actor);
  const canWaste = actorHolds(actor, "inventory.waste");
  const canCorrect = actorHolds(actor, "inventory.adjust");
  const canTrace = actorHolds(actor, "reports.view") && actorHolds(actor, "reports.inventory");

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Lots</h1>
      <p className="mb-4 text-neutral-600">
        {location.locationName} · business date {businessDate} · warns {warningDays} day{warningDays === 1 ? "" : "s"} ahead
      </p>
      <InventoryTabs current="/inventory/lots" permissions={location.permissions} />

      {lots.length === 0 && (
        <EmptyState title="No lots with stock here">Turn on lot tracking for an item on its page, then receive it.</EmptyState>
      )}

      <ul className="grid gap-4">
        {lots.map((lot) => (
          <li key={lot.id} className="rounded-lg border border-neutral-200 bg-surface p-4 shadow-sm" data-testid="lot-row">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-semibold">{lot.itemName}</span>
              <span className="text-neutral-700">{lot.lotNumber}</span>
              <Badge tone={STATUS[lot.status].tone}>{STATUS[lot.status].label}</Badge>
            </div>
            <p className="text-sm text-neutral-700">
              {formatQuantity(lot.quantityRemaining)} {lot.baseUnitCode} left · use by {lot.expiresOn ?? "not set"} · received {lot.receivedOn} ·{" "}
              {ORIGIN[lot.origin] ?? lot.origin}
              {lot.supplierLotCode && <> · supplier lot {lot.supplierLotCode}</>}
              {lot.unitCost && <> · cost {lot.unitCost} per {lot.baseUnitCode}</>}
            </p>
            <div className="mt-3 flex flex-wrap items-start gap-4">
              {canTrace && (
                <Link href={`/reports/lot-trace/${lot.id}`} className="inline-flex min-h-11 items-center font-medium underline">
                  Trace
                </Link>
              )}
              {canWaste && (
                <ActionButton
                  method="POST"
                  url={`/api/inventory/lots/${lot.id}/waste`}
                  body={{ reasonCode: lot.status === "EXPIRED" ? "EXPIRED" : "SPOILAGE", notes: null }}
                  label="Waste lot"
                  variant={lot.status === "OK" ? "secondary" : "danger"}
                  successMessage="Lot wasted."
                  confirm={{
                    title: `Waste all of ${lot.lotNumber}?`,
                    body: `${formatQuantity(lot.quantityRemaining)} ${lot.baseUnitCode} of ${lot.itemName} is recorded as waste.`,
                    confirmLabel: "Waste lot",
                  }}
                />
              )}
              {canCorrect && (
                <details className="min-w-64">
                  <summary className="cursor-pointer text-sm font-medium">Correct code or date</summary>
                  <div className="mt-2">
                    <EntityForm
                      key={`lot-${lot.version}`}
                      method="PATCH"
                      url={`/api/inventory/lots/${lot.id}`}
                      submitLabel="Save correction"
                      hidden={{ expectedVersion: lot.version }}
                      fields={[
                        { name: "supplierLotCode", label: "Supplier lot code", defaultValue: lot.supplierLotCode },
                        { name: "expiresOn", label: "Use by", type: "date", defaultValue: lot.expiresOn },
                        { name: "reason", label: "Reason", required: true },
                      ]}
                    />
                  </div>
                </details>
              )}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
