import { notFound } from "next/navigation";
import { z } from "zod";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { formatQuantity, MEASUREMENT_TYPE_OPTIONS } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getItemConfiguration, listUnitChoices } from "@/modules/inventory/services/item-service";
import { NotFoundError } from "@/shared/errors/app-error";
import { Breadcrumbs } from "@/components/ui/page-header";

export default async function InventoryItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const { location, actor } = await requirePageActor("inventory.configure");
  const parsed = z.uuid().safeParse((await params).itemId);

  if (!parsed.success) {
    notFound();
  }

  const database = getDatabase();
  const detail = await getItemConfiguration(database, actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const units = await listUnitChoices(database, actor);
  const unitCode = new Map(units.map((unit) => [unit.id, unit.code]));
  const unitOptions = units.map((unit) => ({ value: unit.id, label: unit.code }));
  const here = detail.locations.find((entry) => entry.locationId === location.locationId);
  const { item } = detail;
  const base = unitCode.get(item.baseUnitId) ?? "";

  return (
    <>
      <Breadcrumbs items={[{ label: "Inventory items", href: "/inventory/items" }, { label: item.name }]} />
      <h1 className="mb-1 text-2xl font-semibold">{item.name}</h1>
      <p className="mb-6 text-neutral-600">
        {item.code} · stocked in {base}
      </p>

      <section aria-label="Item details" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 text-xl font-semibold">Details</h2>
        <EntityForm
          method="PATCH"
          url={`/api/inventory/items/${item.id}`}
          submitLabel="Save item"
          hidden={{ expectedVersion: item.version }}
          fields={[
            { name: "name", label: "Name", required: true, defaultValue: item.name },
            { name: "description", label: "Description", defaultValue: item.description },
            { name: "measurementType", label: "Measurement type", type: "select", required: true, options: MEASUREMENT_TYPE_OPTIONS, defaultValue: item.measurementType },
            { name: "baseUnitId", label: "Stock unit", type: "select", required: true, options: unitOptions, defaultValue: item.baseUnitId },
            { name: "active", label: "Active", type: "checkbox", defaultValue: item.active },
          ]}
        />
      </section>

      <section aria-label="Stock levels here" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-1 text-xl font-semibold">Stock levels at {location.locationName}</h2>
        <p className="mb-3 text-sm text-neutral-600">
          In {base}. Stock is low at or below the reorder level; suggestions refill to the target.
          {here ? "" : " This item isn't stocked here yet: saving stocks it."}
        </p>
        <EntityForm
          method="PUT"
          url={`/api/inventory/items/${item.id}/location`}
          submitLabel={here ? "Save levels" : "Stock here"}
          hidden={{ expectedVersion: here?.version ?? null }}
          fields={[
            { name: "parLevel", label: "Par level", defaultValue: here?.parLevel ? formatQuantity(here.parLevel) : null },
            { name: "reorderLevel", label: "Reorder level", defaultValue: here?.reorderLevel ? formatQuantity(here.reorderLevel) : null },
            { name: "reorderTarget", label: "Reorder target", defaultValue: here?.reorderTarget ? formatQuantity(here.reorderTarget) : null },
            { name: "storageNote", label: "Storage note", defaultValue: here?.storageNote },
            { name: "active", label: "Stocked here", type: "checkbox", defaultValue: here?.active ?? true },
          ]}
        />
      </section>

      <section aria-label="Packaging conversions" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-1 text-xl font-semibold">Packaging conversions</h2>
        <p className="mb-3 text-sm text-neutral-600">
          For this item only, such as 1 CASE = 12 BOTTLE. Generic conversions (LB to OZ_WEIGHT)
          apply automatically. Each unit may convert one way, and loops are refused.
        </p>
        <ul className="mb-4 grid gap-2">
          {detail.conversions.map((conversion) => (
            <li key={conversion.id} className="flex flex-wrap items-center gap-3 text-sm">
              1 {unitCode.get(conversion.fromUnitId)} = {formatQuantity(conversion.factor)} {unitCode.get(conversion.toUnitId)}
              {conversion.active ? (
                <ActionButton
                  method="POST"
                  url={`/api/inventory/items/${item.id}/conversions/${conversion.id}/deactivate`}
                  body={{ expectedVersion: conversion.version }}
                  label="Deactivate"
                  confirm={{ title: "Deactivate this conversion?", body: "New entries stop using it. Recorded history keeps the conversion it used.", confirmLabel: "Deactivate conversion" }}
                />
              ) : (
                <span className="text-neutral-500">Inactive</span>
              )}
            </li>
          ))}
        </ul>
        <EntityForm
          method="POST"
          url={`/api/inventory/items/${item.id}/conversions`}
          submitLabel="Add conversion"
          resetOnSuccess
          fields={[
            { name: "fromUnitId", label: "From (1 of)", type: "select", required: true, options: unitOptions },
            { name: "factor", label: "Equals how many", required: true },
            { name: "toUnitId", label: "Of", type: "select", required: true, options: unitOptions },
          ]}
        />
      </section>
    </>
  );
}
