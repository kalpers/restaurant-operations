import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { InventoryTabs } from "@/components/inventory/inventory-tabs";
import { MEASUREMENT_TYPE_OPTIONS } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listItems, listUnitChoices } from "@/modules/inventory/services/item-service";

export default async function InventoryItemsPage() {
  const { location, actor } = await requirePageActor("inventory.configure");
  const database = getDatabase();
  const [items, units] = await Promise.all([listItems(database, actor), listUnitChoices(database, actor)]);
  const baseUnitOptions = units
    .filter((unit) => ["COUNT", "WEIGHT", "VOLUME"].includes(unit.measurementType))
    .map((unit) => ({ value: unit.id, label: `${unit.code} (${unit.measurementType.toLowerCase()})` }));

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Inventory items</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <InventoryTabs current="/inventory/items" permissions={location.permissions} />

      <section aria-label="Add an inventory item" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 font-semibold">Add an item</h2>
        <p className="mb-3 text-sm text-neutral-600">
          The stock unit must match the measurement type, and it can&apos;t change once the item has
          stock history. Stock levels are set per location on the item&apos;s page.
        </p>
        <EntityForm
          method="POST"
          url="/api/inventory/items"
          submitLabel="Add item"
          resetOnSuccess
          fields={[
            { name: "code", label: "Code (capitals, digits, underscores)", required: true },
            { name: "name", label: "Name", required: true },
            { name: "description", label: "Description" },
            { name: "measurementType", label: "Measurement type", type: "select", required: true, options: MEASUREMENT_TYPE_OPTIONS },
            { name: "baseUnitId", label: "Stock unit", type: "select", required: true, options: baseUnitOptions },
          ]}
        />
      </section>

      <ul className="grid gap-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
          >
            <span>
              <span className="font-medium">{item.name}</span>{" "}
              <span className="text-neutral-600">
                {item.code} · stocked in {item.baseUnitCode}
                {item.active ? "" : " · Inactive"}
              </span>
            </span>
            <Link
              href={`/inventory/items/${item.id}`}
              className="inline-flex min-h-11 items-center rounded-md border border-neutral-300 px-3 text-sm font-medium"
            >
              Configure {item.name}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
