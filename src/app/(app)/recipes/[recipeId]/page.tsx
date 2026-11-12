import { notFound } from "next/navigation";
import { z } from "zod";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { formatQuantity } from "@/components/inventory/format";
import { formatInstant } from "@/components/menu/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listInventoryItemChoices } from "@/modules/inventory/queries/item-facts";
import { listItems } from "@/modules/menu/services/catalog-service";
import { getRecipeDetail } from "@/modules/recipes/services/recipe-service";
import { listUnits } from "@/modules/recipes/services/unit-service";
import { NotFoundError } from "@/shared/errors/app-error";
import { Breadcrumbs } from "@/components/ui/page-header";

const STATUS_LABELS = { DRAFT: "Draft", PUBLISHED: "Published", RETIRED: "Retired" } as const;

export default async function RecipeDetailPage({
  params,
}: {
  params: Promise<{ recipeId: string }>;
}) {
  const { location, actor } = await requirePageActor("recipes.view");
  const parsedId = z.uuid().safeParse((await params).recipeId);

  if (!parsedId.success) {
    notFound();
  }

  const database = getDatabase();
  const detail = await getRecipeDetail(database, actor, parsedId.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const { recipe, revisions, effectiveRevisionId } = detail;
  const canEdit = actor.permissions.has("recipes.edit");
  const units = await listUnits(database, actor);
  const items = canEdit && actor.permissions.has("menu.view") ? await listItems(database, actor) : [];
  const unitOptions = [
    { value: "", label: "No unit" },
    ...units.map((unit) => ({ value: unit.id, label: `${unit.name} (${unit.code})` })),
  ];
  const ingredientUnitOptions = units.map((unit) => ({ value: unit.id, label: unit.code }));
  const inventoryChoices =
    canEdit && revisions.some((revision) => revision.status === "DRAFT")
      ? await listInventoryItemChoices(database, actor.organizationId)
      : [];
  const withIngredients = revisions.filter((revision) => revision.ingredients.length > 0);

  const draftFields = (revision?: (typeof revisions)[number]): FormField[] => [
    { name: "yieldQuantity", label: "Yield quantity", required: true, defaultValue: revision?.yieldQuantity },
    { name: "yieldUnitId", label: "Yield unit", type: "select", options: unitOptions, defaultValue: revision?.yieldUnitId ?? "" },
    { name: "preparationNotes", label: "Preparation notes", type: "textarea", defaultValue: revision?.preparationNotes },
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: "Recipes", href: "/recipes" }, { label: recipe.name }]} />
      <h1 className="mb-1 text-2xl font-semibold">{recipe.name}</h1>
      <p className="mb-2 text-neutral-600">
        {recipe.code} · {location.locationName}
        {recipe.active ? "" : " · Inactive"}
      </p>
      <p className="mb-6 text-sm text-neutral-600">
        A recipe says how something is prepared, what one batch yields and which inventory items
        it requires. Saving a recipe never changes stock; a published revision can&apos;t be edited.
      </p>

      {canEdit && (
        <section aria-label="Recipe details" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 text-xl font-semibold">Details</h2>
          <EntityForm
            method="PATCH"
            url={`/api/recipes/${recipe.id}`}
            submitLabel="Save recipe"
            hidden={{ expectedVersion: recipe.version }}
            fields={[
              { name: "name", label: "Name", required: true, defaultValue: recipe.name },
              { name: "description", label: "Description", defaultValue: recipe.description },
              {
                name: "menuItemId",
                label: "Menu item",
                type: "select",
                defaultValue: recipe.menuItemId ?? "",
                options: [
                  { value: "", label: "None" },
                  ...items.map((item) => ({ value: item.id, label: item.name })),
                ],
              },
              { name: "active", label: "Active", type: "checkbox", defaultValue: recipe.active },
            ]}
          />
        </section>
      )}

      <section aria-label="Revisions" className="mb-8">
        <h2 className="mb-3 text-xl font-semibold">Revisions</h2>
        {revisions.length === 0 && <p className="text-neutral-600">No revisions yet.</p>}
        <ul className="grid gap-4">
          {revisions.map((revision) => (
            <li
              key={revision.id}
              aria-label={`Revision ${revision.revisionNumber}`}
              className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
            >
              <h3 className="mb-1 font-semibold">
                Revision {revision.revisionNumber} · {STATUS_LABELS[revision.status]}
                {revision.id === effectiveRevisionId ? " · In effect now" : ""}
              </h3>
              <p className="text-sm">
                Yield {revision.yieldQuantity} {revision.yieldUnitCode ?? ""}
              </p>
              {revision.status !== "DRAFT" && (
                <p className="text-sm text-neutral-600">
                  From {formatInstant(revision.effectiveFrom)} until {formatInstant(revision.effectiveTo)}
                </p>
              )}
              {revision.preparationNotes && (
                <p className="mt-2 whitespace-pre-wrap text-sm">{revision.preparationNotes}</p>
              )}

              <h4 className="mb-1 mt-3 text-sm font-semibold">Ingredients</h4>
              {revision.ingredients.length === 0 ? (
                <p className="text-sm text-neutral-600">None yet.</p>
              ) : (
                <ul className="grid gap-2 text-sm">
                  {revision.ingredients.map((ingredient) => (
                    <li key={ingredient.id} aria-label={`Ingredient ${ingredient.inventoryItemName}`}>
                      {ingredient.inventoryItemName}: {formatQuantity(ingredient.quantity)} {ingredient.unitCode}
                      {ingredient.preparationNote ? ` (${ingredient.preparationNote})` : ""}
                      {canEdit && revision.status === "DRAFT" && (
                        <div className="mt-2 grid gap-2 rounded border border-neutral-100 p-2">
                          <EntityForm
                            method="PATCH"
                            url={`/api/recipes/${recipe.id}/revisions/${revision.id}/ingredients/${ingredient.id}`}
                            submitLabel={`Save ${ingredient.inventoryItemName}`}
                            hidden={{ expectedVersion: revision.version, sortOrder: ingredient.sortOrder }}
                            fields={[
                              { name: "quantity", label: "Quantity", required: true, defaultValue: ingredient.quantity },
                              { name: "unitOfMeasureId", label: "Unit", type: "select", required: true, options: ingredientUnitOptions, defaultValue: ingredient.unitOfMeasureId },
                              { name: "preparationNote", label: "Note", defaultValue: ingredient.preparationNote },
                            ]}
                          />
                          <ActionButton
                            method="DELETE"
                            url={`/api/recipes/${recipe.id}/revisions/${revision.id}/ingredients/${ingredient.id}`}
                            body={{ expectedVersion: revision.version }}
                            label={`Remove ${ingredient.inventoryItemName}`}
                            confirm={{ title: `Remove ${ingredient.inventoryItemName}?`, body: "Only this draft revision changes.", confirmLabel: "Remove ingredient" }}
                          />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {canEdit && revision.status === "DRAFT" && (
                <div className="mt-3 grid gap-3 rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
                  <h4 className="text-sm font-semibold">Add an ingredient</h4>
                  <EntityForm
                    method="POST"
                    url={`/api/recipes/${recipe.id}/revisions/${revision.id}/ingredients`}
                    submitLabel="Add ingredient"
                    resetOnSuccess
                    hidden={{ expectedVersion: revision.version, sortOrder: revision.ingredients.length }}
                    fields={[
                      {
                        name: "inventoryItemId",
                        label: "Inventory item",
                        type: "select",
                        required: true,
                        options: inventoryChoices.map((item) => ({ value: item.id, label: `${item.name} (stocked in ${item.baseUnitCode})` })),
                      },
                      { name: "quantity", label: "Quantity", required: true },
                      { name: "unitOfMeasureId", label: "Unit", type: "select", required: true, options: ingredientUnitOptions },
                      { name: "preparationNote", label: "Note" },
                    ]}
                  />
                  {revision.ingredients.length === 0 && withIngredients.length > 0 && (
                    <EntityForm
                      method="POST"
                      url={`/api/recipes/${recipe.id}/revisions/${revision.id}/ingredients/copy`}
                      submitLabel="Copy ingredients"
                      hidden={{ expectedVersion: revision.version }}
                      fields={[
                        {
                          name: "fromRevisionId",
                          label: "Copy ingredients from",
                          type: "select",
                          required: true,
                          options: withIngredients.map((source) => ({ value: source.id, label: `Revision ${source.revisionNumber}` })),
                        },
                      ]}
                    />
                  )}
                </div>
              )}

              {canEdit && revision.status === "DRAFT" && (
                <div className="mt-4 grid gap-4">
                  <EntityForm
                    method="PATCH"
                    url={`/api/recipes/${recipe.id}/revisions/${revision.id}`}
                    submitLabel="Save draft"
                    hidden={{ expectedVersion: revision.version }}
                    fields={draftFields(revision)}
                  />
                  <div className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
                    <h4 className="mb-2 text-sm font-semibold">Publish this revision</h4>
                    <EntityForm
                      method="POST"
                      url={`/api/recipes/${recipe.id}/revisions/${revision.id}/publish`}
                      submitLabel="Publish revision"
                      hidden={{ expectedVersion: revision.version }}
                      fields={[
                        { name: "effectiveFrom", label: "Takes effect (location time; blank is now)", type: "datetime-local" },
                      ]}
                    />
                  </div>
                  <ActionButton
                    method="DELETE"
                    url={`/api/recipes/${recipe.id}/revisions/${revision.id}`}
                    label="Discard draft"
                    confirm={{ title: "Discard this draft revision?", body: "The draft and its ingredients are deleted. Published revisions aren't affected." }}
                  />
                </div>
              )}
              {canEdit && revision.status === "PUBLISHED" && (
                <div className="mt-4">
                  <ActionButton
                    method="POST"
                    url={`/api/recipes/${recipe.id}/revisions/${revision.id}/retire`}
                    body={{ expectedVersion: revision.version }}
                    label="Retire revision"
                    confirm={{ title: "Retire this revision?", body: "It stops applying to new orders. Orders already sent keep their recipe snapshot." }}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canEdit && (
        <section aria-label="New revision" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 text-xl font-semibold">New revision</h2>
          <EntityForm
            method="POST"
            url={`/api/recipes/${recipe.id}/revisions`}
            submitLabel="Create draft revision"
            resetOnSuccess
            fields={draftFields()}
          />
        </section>
      )}
    </>
  );
}
