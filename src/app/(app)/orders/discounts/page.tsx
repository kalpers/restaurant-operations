import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { formatMoney } from "@/components/orders/order-api";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listDiscountDefinitions } from "@/modules/orders/services/discount-service";

/** Discount definitions. Applying one snapshots it; editing here changes later uses only. */
export default async function DiscountsPage() {
  const { actor } = await requirePageActor("orders.discount.manage");
  const definitions = await listDiscountDefinitions(getDatabase(), actor, { includeInactive: true });

  return (
    <>
      <p className="mb-2">
        <Link href="/orders" className="text-sm underline">
          Back to orders
        </Link>
      </p>
      <h1 className="mb-2 text-2xl font-semibold">Discounts</h1>
      <p className="mb-6 text-neutral-600">
        Item discounts apply first, then order discounts. Percentages round half up to the cent, every
        discount is capped at what remains, and 100% is a comp. No tax is calculated.
      </p>

      <section aria-label="New discount" className="mb-8 max-w-xl">
        <h2 className="mb-3 text-xl font-semibold">New discount</h2>
        <EntityForm
          method="POST"
          url="/api/discount-definitions"
          submitLabel="Create discount"
          resetOnSuccess
          fields={[
            { name: "code", label: "Code", required: true },
            { name: "name", label: "Name", required: true },
            {
              name: "scope",
              label: "Applies to",
              type: "select",
              options: [
                { value: "ITEM", label: "One item" },
                { value: "ORDER", label: "Whole order" },
              ],
            },
            {
              name: "discountType",
              label: "Type",
              type: "select",
              options: [
                { value: "PERCENTAGE", label: "Percentage" },
                { value: "FIXED_AMOUNT", label: "Fixed amount" },
              ],
            },
            { name: "value", label: "Value (percent or dollars)", required: true },
          ]}
        />
      </section>

      <section aria-label="Discounts">
        <h2 className="mb-3 text-xl font-semibold">All discounts</h2>
        {definitions.length === 0 && <p className="text-neutral-600">No discounts yet.</p>}
        <ul className="grid gap-4">
          {definitions.map((definition) => (
            <li key={definition.id} aria-label={`Discount ${definition.name}`} className="rounded-md border border-neutral-300 p-4">
              <p className="font-medium">
                {definition.name} · {definition.scope === "ITEM" ? "item" : "order"} ·{" "}
                {definition.discountType === "PERCENTAGE" ? `${definition.value}%` : formatMoney(definition.value)}
                {definition.active ? "" : " · inactive"}
              </p>
              <p className="mb-2 text-sm text-neutral-600">{definition.code}</p>
              <details>
                <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Edit</summary>
                <EntityForm
                  method="PATCH"
                  url={`/api/discount-definitions/${definition.id}`}
                  submitLabel="Save discount"
                  hidden={{ expectedVersion: definition.version }}
                  fields={[
                    { name: "name", label: "Name", required: true, defaultValue: definition.name },
                    { name: "value", label: "Value", required: true, defaultValue: definition.value },
                    { name: "active", label: "Active", type: "checkbox", defaultValue: definition.active },
                  ]}
                />
              </details>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
