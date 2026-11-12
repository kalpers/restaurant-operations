import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { EntityForm } from "@/components/forms/entity-form";
import {
  describeSelection,
  formatInstant,
  formatMoney,
  ITEM_TYPE_OPTIONS,
} from "@/components/menu/format";
import { RoutingForm } from "@/components/menu/routing-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { loadSelectionGroups } from "@/modules/menu/services/selection-service";
import {
  getItem,
  listCategories,
  listMenus,
  listPlacements,
} from "@/modules/menu/services/catalog-service";
import { listGroups, listItemAttachments, listModifiers } from "@/modules/menu/services/modifier-service";
import { listItemRouting, listStations } from "@/modules/menu/services/prep-station-service";
import { listPriceHistory } from "@/modules/menu/services/pricing-service";
import { listTaxCategories } from "@/modules/menu/services/tax-service";
import { actorHolds } from "@/modules/menu/services/access";
import { listRecipes } from "@/modules/recipes/services/recipe-service";
import { NotFoundError } from "@/shared/errors/app-error";
import { Breadcrumbs } from "@/components/ui/page-header";
import { AllergenLabelBadges } from "@/components/allergens/allergen-label";
import { AllergenTagsForm } from "@/components/allergens/allergen-tags-form";
import {
  getDeclaredAllergens,
  listAllergens,
  loadBaseAllergenLabels,
} from "@/modules/recipes/queries/allergen-facts";

export default async function MenuItemEditorPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const { location, actor } = await requirePageActor("menu.edit");
  const parsedId = z.uuid().safeParse((await params).itemId);

  if (!parsedId.success) {
    notFound();
  }

  const itemId = parsedId.data;
  const database = getDatabase();
  const item = await getItem(database, actor, itemId).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });

  const canSeePricing = actorHolds(actor, "menu.pricing.view");
  const canEditPricing = actorHolds(actor, "menu.pricing.edit");
  const [placements, menus, categories, attachments, groups, routing, stations, modifiers, selection] =
    await Promise.all([
      listPlacements(database, actor, { menuItemId: itemId }),
      listMenus(database, actor),
      listCategories(database, actor),
      listItemAttachments(database, actor, itemId),
      listGroups(database, actor),
      listItemRouting(database, actor, itemId),
      listStations(database, actor),
      listModifiers(database, actor),
      loadSelectionGroups(database, actor.organizationId, itemId),
    ]);
  const prices = canSeePricing ? await listPriceHistory(database, actor, itemId) : [];
  // Phase 17: explicit taxability. Without tax.view the field is left out, so it stays as is.
  const taxCategories = actorHolds(actor, "tax.view") ? await listTaxCategories(database, actor) : null;
  const recipe = actorHolds(actor, "recipes.view")
    ? (await listRecipes(database, actor)).find((entry) => entry.menuItemId === itemId)
    : undefined;
  const nameOf = new Map<string, string>([
    ...menus.map((menu) => [menu.id, menu.name] as const),
    ...categories.map((category) => [category.id, category.name] as const),
  ]);
  const attachedIds = new Set(attachments.map((attachment) => attachment.modifierGroupId));
  const modifierName = new Map(modifiers.map((modifier) => [modifier.id, modifier]));
  const activeStations = stations.filter((station) => station.active);
  // Phase 21 (policies 10, 11, 18): the label as sold with no modifiers, and the declarations.
  const [allergenChoices, declared, baseLabels] = await Promise.all([
    listAllergens(database, actor.organizationId),
    getDeclaredAllergens(database, actor.organizationId, itemId),
    loadBaseAllergenLabels(database, actor.organizationId, [itemId], new Date()),
  ]);
  const baseLabel = baseLabels.get(itemId)!;

  return (
    <>
      <Breadcrumbs items={[{ label: "Manage menu", href: "/menu/manage" }, { label: item.name }]} />
      <h1 className="mb-1 text-2xl font-semibold">{item.name}</h1>
      <p className="mb-6 text-neutral-600">
        {item.code} · {location.locationName}
      </p>

      <section aria-label="Details" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 text-xl font-semibold">Details</h2>
        <EntityForm
          method="PATCH"
          url={`/api/menu/items/${item.id}`}
          submitLabel="Save item"
          hidden={{ expectedVersion: item.version }}
          fields={[
            { name: "name", label: "Name", required: true, defaultValue: item.name },
            { name: "shortName", label: "Short name", defaultValue: item.shortName },
            { name: "description", label: "Description", defaultValue: item.description },
            { name: "itemType", label: "Type", type: "select", required: true, options: ITEM_TYPE_OPTIONS, defaultValue: item.itemType },
            { name: "displayOrder", label: "Display order", type: "number", defaultValue: item.displayOrder },
            { name: "active", label: "Active (in the catalog)", type: "checkbox", defaultValue: item.active },
            { name: "available", label: "Available (can be sold now)", type: "checkbox", defaultValue: item.available },
            ...(taxCategories
              ? [
                  {
                    name: "taxCategoryId",
                    label: "Tax category",
                    type: "select" as const,
                    defaultValue: item.taxCategoryId ?? "",
                    options: [
                      { value: "", label: "None (not taxed)" },
                      ...taxCategories
                        .filter((category) => category.active || category.id === item.taxCategoryId)
                        .map((category) => ({ value: category.id, label: `${category.name} (${category.code})` })),
                    ],
                  },
                ]
              : []),
          ]}
        />
      </section>

      {canSeePricing && (
        <section aria-label="Pricing" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 text-xl font-semibold">Pricing</h2>
          {prices.length === 0 ? (
            <p className="mb-3 text-warning-800">No price yet: this item can&apos;t be sold.</p>
          ) : (
            <table className="mb-4 w-full text-left text-sm">
              <thead className="sticky top-0 bg-neutral-100 text-neutral-800">
                <tr>
                  <th className="py-1 pr-3">Price</th>
                  <th className="py-1 pr-3">Scope</th>
                  <th className="py-1 pr-3">From</th>
                  <th className="py-1">Until</th>
                </tr>
              </thead>
              <tbody className="[&>tr:nth-child(even)]:bg-neutral-50">
                {prices.map((price) => (
                  <tr key={price.id} className={price.current ? "font-semibold" : undefined}>
                    <td className="py-1 pr-3">
                      {formatMoney(price.price)}
                      {price.current ? " (current)" : ""}
                    </td>
                    <td className="py-1 pr-3">
                      {price.locationId === null
                        ? "All locations"
                        : price.locationId === location.locationId
                          ? "This location"
                          : "Another location"}
                    </td>
                    <td className="py-1 pr-3">{formatInstant(price.effectiveFrom)}</td>
                    <td className="py-1">{formatInstant(price.effectiveTo)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {canEditPricing && (
            <EntityForm
              method="POST"
              url={`/api/menu/items/${item.id}/prices`}
              submitLabel="Set new price"
              resetOnSuccess
              fields={[
                { name: "price", label: "New price", required: true },
                {
                  name: "locationId",
                  label: "Applies to",
                  type: "select",
                  defaultValue: "",
                  options: [
                    { value: "", label: "All locations" },
                    { value: location.locationId, label: `${location.locationName} only` },
                  ],
                },
                { name: "effectiveFrom", label: "Starts (location time; blank is now)", type: "datetime-local" },
              ]}
            />
          )}
        </section>
      )}

      <section aria-label="Placements" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 text-xl font-semibold">On menus</h2>
        {placements.length === 0 ? (
          <p className="mb-3 text-warning-800">This item is not on any menu.</p>
        ) : (
          <ul className="mb-4 grid gap-3">
            {placements.map((placement) => (
              <li key={placement.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
                <p className="mb-2 font-medium">
                  {nameOf.get(placement.menuId) ?? "Menu"} · {nameOf.get(placement.menuCategoryId) ?? "Category"}
                  {placement.active ? "" : " · Hidden"}
                </p>
                <EntityForm
                  method="PATCH"
                  url={`/api/menu/placements/${placement.id}`}
                  submitLabel="Save placement"
                  hidden={{ expectedVersion: placement.version }}
                  fields={[
                    { name: "displayOrder", label: "Display order", type: "number", defaultValue: placement.displayOrder },
                    { name: "active", label: "Visible", type: "checkbox", defaultValue: placement.active },
                  ]}
                />
              </li>
            ))}
          </ul>
        )}
        <h3 className="mb-2 font-semibold">Add to a menu</h3>
        <EntityForm
          method="POST"
          url="/api/menu/placements"
          submitLabel="Add to menu"
          resetOnSuccess
          hidden={{ menuItemId: item.id }}
          fields={[
            { name: "menuId", label: "Menu", type: "select", required: true, options: menus.filter((menu) => menu.active).map((menu) => ({ value: menu.id, label: menu.name })) },
            { name: "menuCategoryId", label: "Category", type: "select", required: true, options: categories.filter((category) => category.active).map((category) => ({ value: category.id, label: category.name })) },
            { name: "displayOrder", label: "Display order", type: "number", defaultValue: 0 },
          ]}
        />
      </section>

      <section aria-label="Modifier groups" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 text-xl font-semibold">Modifier groups</h2>
        {attachments.length === 0 && <p className="mb-3 text-neutral-600">No modifier groups.</p>}
        <ul className="mb-4 grid gap-3">
          {attachments.map((attachment) => {
            const preview = selection.groups.find((entry) => entry.modifierGroupId === attachment.modifierGroupId);

            return (
              <li
                key={attachment.id}
                aria-label={`Modifier group ${attachment.group.name}`}
                className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
              >
                <p className="font-medium">
                  {attachment.group.name}{" "}
                  <span className="font-normal text-neutral-600">
                    ({describeSelection(attachment.constraints.minimum, attachment.constraints.maximum)}
                    {attachment.constraints.minimum > 0 ? ", required" : ""})
                    {attachment.active ? "" : " · Detached"}
                  </span>
                </p>
                <ul className="mb-3 ml-4 list-disc text-sm">
                  {preview?.modifiers.map((entry) => {
                    const modifier = modifierName.get(entry.modifierId);

                    return (
                      <li key={entry.modifierId}>
                        {entry.name}
                        {modifier && modifier.priceAdjustment !== "0.00" && ` (${formatMoney(modifier.priceAdjustment)})`}
                        {entry.active ? "" : " · Inactive"}
                      </li>
                    );
                  })}
                </ul>
                <EntityForm
                  method="PATCH"
                  url={`/api/menu/attachments/${attachment.id}`}
                  submitLabel="Save group settings"
                  hidden={{ expectedVersion: attachment.version }}
                  fields={[
                    { name: "displayOrder", label: "Display order", type: "number", defaultValue: attachment.displayOrder },
                    { name: "minimumOverride", label: "Minimum override (blank uses the group rule)", type: "number", defaultValue: attachment.minimumOverride },
                    { name: "maximumOverride", label: "Maximum override (blank uses the group rule)", type: "number", defaultValue: attachment.maximumOverride },
                    { name: "active", label: "Offered on this item", type: "checkbox", defaultValue: attachment.active },
                  ]}
                />
              </li>
            );
          })}
        </ul>
        <h3 className="mb-2 font-semibold">Attach a group</h3>
        <EntityForm
          method="POST"
          url={`/api/menu/items/${item.id}/modifier-groups`}
          submitLabel="Attach group"
          resetOnSuccess
          fields={[
            {
              name: "modifierGroupId",
              label: "Group",
              type: "select",
              required: true,
              options: groups
                .filter((group) => group.active && !attachedIds.has(group.id))
                .map((group) => ({ value: group.id, label: group.name })),
            },
            { name: "displayOrder", label: "Display order", type: "number", defaultValue: 0 },
            { name: "minimumOverride", label: "Minimum override", type: "number" },
            { name: "maximumOverride", label: "Maximum override", type: "number" },
          ]}
        />
      </section>

      <section aria-label="Preparation routing" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 text-xl font-semibold">Preparation routing</h2>
        <RoutingForm
          menuItemId={item.id}
          stations={activeStations.map((station) => ({ id: station.id, code: station.code, name: station.name }))}
          selectedIds={routing.filter((row) => row.active).map((row) => row.prepStationId)}
        />
      </section>

      <section aria-label="Allergens" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-1 text-xl font-semibold">Allergens</h2>
        <p className="mb-2 text-sm text-neutral-600">
          Worked out from the recipe in effect now and its ingredients&apos; tags, plus what you declare here.
          Modifiers can add or remove allergens; the order screen shows the label for the choices made.
        </p>
        <p className="mb-4">
          <AllergenLabelBadges label={baseLabel} />
        </p>
        {actorHolds(actor, "recipes.allergens.manage") ? (
          <>
            <h3 className="mb-2 font-semibold">Declared allergens</h3>
            <p className="mb-3 text-sm text-neutral-600">
              &quot;Contains&quot; for what the recipe doesn&apos;t show (an item with no recipe). &quot;May contain&quot;
              for cross-contact, such as a shared fryer. An item with no recipe is incomplete until this is saved.
            </p>
            <AllergenTagsForm
              mode="declared"
              url={`/api/menu/items/${item.id}/allergens`}
              allergens={allergenChoices}
              declared={declared.declared}
              reviewVersion={declared.review?.version ?? null}
            />
          </>
        ) : null}
      </section>

      {recipe && (
        <section aria-label="Recipe" className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <h2 className="mb-3 text-xl font-semibold">Recipe</h2>
          <p>
            <Link href={`/recipes/${recipe.id}`} className="underline">
              {recipe.name}
            </Link>
          </p>
        </section>
      )}
    </>
  );
}
