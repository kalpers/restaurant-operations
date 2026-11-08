import { EntityForm } from "@/components/forms/entity-form";
import { ADJUSTMENT_REASON_OPTIONS, formatQuantity, WASTE_REASON_OPTIONS } from "@/components/inventory/format";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listOnHand } from "@/modules/inventory/queries/stock-queries";
import { actorHolds } from "@/modules/inventory/services/access";
import { listUnitChoices } from "@/modules/inventory/services/item-service";

/**
 * Waste, manual adjustments and transfers. Each posts a ledger row through the one posting
 * service; there is no field that sets a quantity directly.
 */
export default async function MovementsPage() {
  const { auth, location, actor } = await requirePageActor("inventory.view");
  const database = getDatabase();
  const stocked = (await listOnHand(database, actor)).filter((row) => row.itemActive && row.stockedActive);
  const units = await listUnitChoices(database, actor);
  const itemOptions = stocked.map((row) => ({
    value: row.inventoryItemId,
    label: `${row.name} (${formatQuantity(row.quantityOnHand)} ${row.baseUnitCode} on hand)`,
  }));
  const unitOptions = units.map((unit) => ({ value: unit.id, label: unit.code }));
  const destinations = auth.locations
    .filter((entry) => entry.locationId !== location.locationId && entry.permissions.includes("inventory.transfer"))
    .map((entry) => ({ value: entry.locationId, label: entry.locationName }));
  const movementFields = [
    { name: "inventoryItemId", label: "Item", type: "select" as const, required: true, options: itemOptions },
    { name: "quantity", label: "Quantity", required: true },
    { name: "unitOfMeasureId", label: "Unit", type: "select" as const, required: true, options: unitOptions },
  ];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Waste, adjustments and transfers</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory/movements" permissions={location.permissions} />

      {itemOptions.length === 0 && <p className="mb-6 text-neutral-600">No items are stocked here yet.</p>}

      {actorHolds(actor, "inventory.waste") && itemOptions.length > 0 && (
        <section aria-label="Record waste" className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 text-xl font-semibold">Record waste</h2>
          <EntityForm
            method="POST"
            url="/api/inventory/waste"
            submitLabel="Record waste"
            resetOnSuccess
            fields={[
              ...movementFields,
              { name: "reasonCode", label: "Reason", type: "select", required: true, options: WASTE_REASON_OPTIONS },
              { name: "notes", label: "Notes" },
            ]}
          />
        </section>
      )}

      {actorHolds(actor, "inventory.adjust") && itemOptions.length > 0 && (
        <section aria-label="Adjust stock" className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 text-xl font-semibold">Adjust stock</h2>
          <EntityForm
            method="POST"
            url="/api/inventory/adjustments"
            submitLabel="Record adjustment"
            resetOnSuccess
            fields={[
              ...movementFields,
              {
                name: "direction",
                label: "Direction",
                type: "select",
                required: true,
                options: [
                  { value: "INCREASE", label: "Increase" },
                  { value: "DECREASE", label: "Decrease" },
                ],
              },
              { name: "reasonCode", label: "Reason", type: "select", required: true, options: ADJUSTMENT_REASON_OPTIONS },
              { name: "notes", label: "Notes" },
            ]}
          />
        </section>
      )}

      {actorHolds(actor, "inventory.transfer") && itemOptions.length > 0 && destinations.length > 0 && (
        <section aria-label="Transfer stock" className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 text-xl font-semibold">Transfer to another location</h2>
          <EntityForm
            method="POST"
            url="/api/inventory/transfers"
            submitLabel="Transfer"
            resetOnSuccess
            fields={[
              ...movementFields,
              { name: "toLocationId", label: "To", type: "select", required: true, options: destinations },
              { name: "notes", label: "Notes" },
            ]}
          />
        </section>
      )}
    </>
  );
}
