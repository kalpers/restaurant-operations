import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { formatInstant } from "@/components/menu/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listItems } from "@/modules/menu/services/catalog-service";
import { getRecipeDetail } from "@/modules/recipes/services/recipe-service";
import { listUnits } from "@/modules/recipes/services/unit-service";
import { NotFoundError } from "@/shared/errors/app-error";

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

  const draftFields = (revision?: (typeof revisions)[number]): FormField[] => [
    { name: "yieldQuantity", label: "Yield quantity", required: true, defaultValue: revision?.yieldQuantity },
    { name: "yieldUnitId", label: "Yield unit", type: "select", options: unitOptions, defaultValue: revision?.yieldUnitId ?? "" },
    { name: "preparationNotes", label: "Preparation notes", type: "textarea", defaultValue: revision?.preparationNotes },
  ];

  return (
    <>
      <p className="mb-2">
        <Link href="/recipes" className="text-sm underline">
          Back to recipes
        </Link>
      </p>
      <h1 className="mb-1 text-2xl font-semibold">{recipe.name}</h1>
      <p className="mb-2 text-neutral-600">
        {recipe.code} · {location.locationName}
        {recipe.active ? "" : " · Inactive"}
      </p>
      <p className="mb-6 text-sm text-neutral-600">
        A recipe says how something is prepared and what one batch yields. Ingredients and their
        quantities are added when Inventory is introduced.
      </p>

      {canEdit && (
        <section aria-label="Recipe details" className="mb-8 rounded border border-neutral-200 p-4">
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
              className="rounded border border-neutral-200 p-4"
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

              {canEdit && revision.status === "DRAFT" && (
                <div className="mt-4 grid gap-4">
                  <EntityForm
                    method="PATCH"
                    url={`/api/recipes/${recipe.id}/revisions/${revision.id}`}
                    submitLabel="Save draft"
                    hidden={{ expectedVersion: revision.version }}
                    fields={draftFields(revision)}
                  />
                  <div className="rounded border border-neutral-200 p-3">
                    <h4 className="mb-2 text-sm font-semibold">Publish this revision</h4>
                    <EntityForm
                      method="POST"
                      url={`/api/recipes/${recipe.id}/revisions/${revision.id}/publish`}
                      submitLabel="Publish revision"
                      hidden={{ expectedVersion: revision.version }}
                      fields={[
                        { name: "effectiveFrom", label: "Takes effect (your local time; blank is now)", type: "datetime-local" },
                      ]}
                    />
                  </div>
                  <ActionButton
                    method="DELETE"
                    url={`/api/recipes/${recipe.id}/revisions/${revision.id}`}
                    label="Discard draft"
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
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {canEdit && (
        <section aria-label="New revision" className="mb-8 rounded border border-neutral-200 p-4">
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
