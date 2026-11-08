import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { formatCost, formatQuantity } from "@/components/inventory/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listItems, listUnitChoices } from "@/modules/inventory/services/item-service";
import { listSupplierItems, listSuppliers } from "@/modules/inventory/services/supplier-service";

/** Suppliers and how each sells items. There is no preferred supplier. */
export default async function SuppliersPage() {
  const { location, actor } = await requirePageActor("suppliers.manage");
  const database = getDatabase();
  const [suppliers, supplierItems, items, units] = await Promise.all([
    listSuppliers(database, actor),
    listSupplierItems(database, actor),
    listItems(database, actor),
    listUnitChoices(database, actor),
  ]);
  const itemOptions = items.filter((item) => item.active).map((item) => ({ value: item.id, label: item.name }));
  const unitOptions = units.map((unit) => ({ value: unit.id, label: unit.code }));
  const supplierFields = (supplier?: (typeof suppliers)[number]): FormField[] => [
    { name: "name", label: "Name", required: true, defaultValue: supplier?.name },
    { name: "contactName", label: "Contact", defaultValue: supplier?.contactName },
    { name: "phone", label: "Phone", defaultValue: supplier?.phone },
    { name: "email", label: "Email", type: "email", defaultValue: supplier?.email },
  ];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Suppliers</h1>
      <p className="mb-6 text-neutral-600">{location.locationName}</p>

      <section aria-label="Add a supplier" className="mb-8 rounded border border-neutral-200 p-4">
        <h2 className="mb-3 font-semibold">Add a supplier</h2>
        <EntityForm
          method="POST"
          url="/api/suppliers"
          submitLabel="Add supplier"
          resetOnSuccess
          fields={[{ name: "code", label: "Code (capitals, digits, underscores)", required: true }, ...supplierFields()]}
        />
      </section>

      <ul className="grid gap-6">
        {suppliers.map((supplier) => (
          <li
            key={supplier.id}
            aria-label={`Supplier ${supplier.code}`}
            className="rounded border border-neutral-200 p-4"
          >
            <h2 className="mb-3 text-xl font-semibold">
              {supplier.name} <span className="font-normal text-neutral-600">{supplier.code}{supplier.active ? "" : " · Inactive"}</span>
            </h2>
            <EntityForm
              method="PATCH"
              url={`/api/suppliers/${supplier.id}`}
              submitLabel="Save supplier"
              hidden={{ expectedVersion: supplier.version }}
              fields={[...supplierFields(supplier), { name: "active", label: "Active", type: "checkbox", defaultValue: supplier.active }]}
            />

            <h3 className="mb-2 mt-6 font-semibold">Items this supplier sells</h3>
            <ul className="mb-4 grid gap-3">
              {supplierItems
                .filter((entry) => entry.supplierId === supplier.id)
                .map((entry) => (
                  <li key={entry.id} aria-label={`Supplier item ${entry.inventoryItemName}`} className="rounded border border-neutral-100 p-3">
                    <p className="mb-2 text-sm">
                      {entry.inventoryItemName} by the {entry.purchaseUnitCode} = {formatQuantity(entry.baseUnitsPerPurchase)} stock units
                      {entry.lastUnitCost !== null && ` · listed ${formatCost(entry.lastUnitCost)}`}
                      {entry.active ? "" : " · Inactive"}
                    </p>
                    <EntityForm
                      method="PATCH"
                      url={`/api/supplier-items/${entry.id}`}
                      submitLabel="Save supplier item"
                      hidden={{ expectedVersion: entry.version }}
                      fields={[
                        { name: "supplierSku", label: "Supplier SKU", defaultValue: entry.supplierSku },
                        { name: "lastUnitCost", label: `Listed cost per ${entry.purchaseUnitCode}`, defaultValue: entry.lastUnitCost },
                        { name: "active", label: "Active", type: "checkbox", defaultValue: entry.active },
                      ]}
                    />
                  </li>
                ))}
            </ul>
            <EntityForm
              method="POST"
              url={`/api/suppliers/${supplier.id}/items`}
              submitLabel="Add supplier item"
              resetOnSuccess
              fields={[
                { name: "inventoryItemId", label: "Item", type: "select", required: true, options: itemOptions },
                { name: "purchaseUnitId", label: "Sold by the", type: "select", required: true, options: unitOptions },
                { name: "supplierSku", label: "Supplier SKU" },
                { name: "lastUnitCost", label: "Listed cost per purchase unit" },
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
