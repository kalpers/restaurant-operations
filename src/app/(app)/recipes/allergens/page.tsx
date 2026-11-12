import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Breadcrumbs } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listAllergenChoices, listIngredientsNeedingReview } from "@/modules/recipes/services/allergen-service";

/** Phase 21 (policies 6 and 18): the allergen list and the ingredients still to review. */
export default async function AllergensPage() {
  const { actor } = await requirePageActor("recipes.allergens.manage");
  const database = getDatabase();
  const [allergens, needsReview] = await Promise.all([
    listAllergenChoices(database, actor),
    listIngredientsNeedingReview(database, actor),
  ]);

  return (
    <>
      <Breadcrumbs items={[{ label: "Recipes", href: "/recipes" }, { label: "Allergens" }]} />
      <h1 className="mb-1 text-2xl font-semibold">Allergens</h1>
      <p className="mb-6 max-w-3xl text-neutral-600">
        Tag each ingredient with what it contains on its inventory item page. A menu item&apos;s label is worked out
        from its recipe and the modifiers chosen, plus what the menu item declares. Servers are warned when an item
        matches a guest&apos;s allergies. Labels are only as good as this data: an ingredient nobody has reviewed makes
        every item using it show &quot;Allergens incomplete&quot;.
      </p>

      <section aria-label="Needs allergen review" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-1 text-xl font-semibold">Needs allergen review</h2>
        <p className="mb-3 text-sm text-neutral-600">Active ingredients in current or draft recipes that nobody has reviewed.</p>
        {needsReview.length === 0 ? (
          <EmptyState title="Every ingredient in use has been reviewed." />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {needsReview.map((item) => (
              <li key={item.id} className="flex items-center gap-2">
                <Badge tone="danger">Not reviewed</Badge>
                <Link href={`/inventory/items/${item.id}`} className="underline">
                  {item.name}
                </Link>
                <span className="text-sm text-neutral-500">{item.code}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Allergen list" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 text-xl font-semibold">Allergen list</h2>
        <ul className="mb-6 grid gap-4">
          {allergens.map((allergen) => (
            <li key={allergen.id} className="rounded-md border border-neutral-200 p-3">
              <p className="mb-2 font-medium">
                {allergen.name} <span className="text-sm text-neutral-500">{allergen.code}</span>{" "}
                {allergen.active ? null : <Badge>Inactive</Badge>}
              </p>
              <EntityForm
                method="PATCH"
                url={`/api/recipes/allergens/${allergen.id}`}
                submitLabel="Save allergen"
                hidden={{ expectedVersion: allergen.version }}
                fields={[
                  { name: "name", label: "Name", required: true, defaultValue: allergen.name },
                  { name: "displayOrder", label: "Display order", type: "number", defaultValue: allergen.displayOrder },
                  { name: "active", label: "Active (can be tagged and recorded)", type: "checkbox", defaultValue: allergen.active },
                ]}
              />
            </li>
          ))}
        </ul>
        <h3 className="mb-2 font-semibold">Add an allergen</h3>
        <EntityForm
          method="POST"
          url="/api/recipes/allergens"
          submitLabel="Add allergen"
          resetOnSuccess
          fields={[
            { name: "code", label: "Code (capitals, digits, underscores)", required: true },
            { name: "name", label: "Name", required: true },
            { name: "displayOrder", label: "Display order", type: "number", defaultValue: 100 },
          ]}
        />
      </section>
    </>
  );
}
