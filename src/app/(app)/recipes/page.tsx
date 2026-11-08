import Link from "next/link";

import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listItems } from "@/modules/menu/services/catalog-service";
import { listRecipes } from "@/modules/recipes/services/recipe-service";

export default async function RecipesPage() {
  const { location, actor } = await requirePageActor("recipes.view");
  const database = getDatabase();
  const recipes = await listRecipes(database, actor);
  const canEdit = actor.permissions.has("recipes.edit");
  const items =
    canEdit && actor.permissions.has("menu.view") ? await listItems(database, actor) : [];
  const linked = new Set(recipes.flatMap((recipe) => (recipe.menuItemId ? [recipe.menuItemId] : [])));

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Recipes</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      {canEdit && (
        <section aria-label="Add a recipe" className="mb-8 rounded border border-neutral-200 p-4">
          <h2 className="mb-3 font-semibold">Add a recipe</h2>
          <EntityForm
            method="POST"
            url="/api/recipes"
            submitLabel="Add recipe"
            resetOnSuccess
            fields={[
              { name: "code", label: "Code (capitals, digits, underscores)", required: true },
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description" },
              {
                name: "menuItemId",
                label: "Menu item (optional)",
                type: "select",
                defaultValue: "",
                options: [
                  { value: "", label: "None" },
                  ...items
                    .filter((item) => !linked.has(item.id))
                    .map((item) => ({ value: item.id, label: item.name })),
                ],
              },
            ]}
          />
        </section>
      )}

      {recipes.length === 0 ? (
        <p className="text-neutral-600">No recipes yet.</p>
      ) : (
        <ul className="grid gap-2">
          {recipes.map((recipe) => (
            <li
              key={recipe.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-200 p-3"
            >
              <span>
                <span className="font-medium">{recipe.name}</span>{" "}
                <span className="text-neutral-600">
                  {recipe.code}
                  {recipe.menuItemName ? ` · ${recipe.menuItemName}` : ""}
                  {recipe.active ? "" : " · Inactive"}
                </span>
              </span>
              <Link
                href={`/recipes/${recipe.id}`}
                className="inline-flex min-h-11 items-center rounded border border-neutral-400 px-3 text-sm font-medium"
              >
                Open {recipe.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
