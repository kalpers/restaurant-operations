import Link from "next/link";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { ITEM_TYPE_OPTIONS } from "@/components/menu/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import {
  listCategories,
  listItems,
  listMenus,
  listUnplacedItems,
} from "@/modules/menu/services/catalog-service";

const codeField = (defaultValue?: string): FormField => ({
  name: "code",
  label: "Code (capitals, digits, underscores)",
  required: true,
  defaultValue,
});

export default async function ManageMenuPage() {
  const { location, actor } = await requirePageActor("menu.edit");
  const database = getDatabase();
  const [categories, menus, items, unplaced] = await Promise.all([
    listCategories(database, actor),
    listMenus(database, actor),
    listItems(database, actor),
    listUnplacedItems(database, actor),
  ]);

  const basicFields = (row?: { name: string; description: string | null; displayOrder: number }): FormField[] => [
    { name: "name", label: "Name", required: true, defaultValue: row?.name },
    { name: "description", label: "Description", defaultValue: row?.description },
    { name: "displayOrder", label: "Display order", type: "number", defaultValue: row?.displayOrder ?? 0 },
  ];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Manage menu</h1>
      <p className="mb-6 text-neutral-600">{location.locationName}</p>

      <section aria-label="Categories" className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Categories</h2>
        <div className="mb-4 rounded border border-neutral-200 p-4">
          <h3 className="mb-3 font-semibold">Add a category</h3>
          <EntityForm
            method="POST"
            url="/api/menu/categories"
            submitLabel="Add category"
            resetOnSuccess
            fields={[codeField(), ...basicFields()]}
          />
        </div>
        <ul className="grid gap-4">
          {categories.map((category) => (
            <li
              key={category.id}
              aria-label={`Category ${category.code}`}
              className="rounded border border-neutral-200 p-4"
            >
              <h3 className="mb-3 font-semibold">
                {category.code}
                {category.active ? "" : " · Inactive"}
              </h3>
              <EntityForm
                method="PATCH"
                url={`/api/menu/categories/${category.id}`}
                submitLabel="Save category"
                hidden={{ expectedVersion: category.version }}
                fields={[
                  ...basicFields(category),
                  { name: "active", label: "Active", type: "checkbox", defaultValue: category.active },
                ]}
              />
            </li>
          ))}
        </ul>
      </section>

      <section aria-label="Menus" className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Menus</h2>
        <div className="mb-4 rounded border border-neutral-200 p-4">
          <h3 className="mb-3 font-semibold">Add a menu</h3>
          <EntityForm
            method="POST"
            url="/api/menu/menus"
            submitLabel="Add menu"
            resetOnSuccess
            fields={[codeField(), ...basicFields()]}
          />
        </div>
        <ul className="grid gap-4">
          {menus.map((menu) => {
            const here = menu.locations.find((entry) => entry.locationId === location.locationId);
            const offered = here?.active === true;

            return (
              <li
                key={menu.id}
                aria-label={`Menu ${menu.code}`}
                className="rounded border border-neutral-200 p-4"
              >
                <h3 className="mb-1 font-semibold">
                  {menu.code}
                  {menu.active ? "" : " · Inactive"}
                </h3>
                <p className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                  {offered ? "Offered at this location." : "Not offered at this location."}
                  <ActionButton
                    method="PUT"
                    url={`/api/menu/menus/${menu.id}/locations`}
                    body={{ locationId: location.locationId, active: !offered }}
                    label={offered ? "Stop offering here" : "Offer here"}
                  />
                </p>
                <EntityForm
                  method="PATCH"
                  url={`/api/menu/menus/${menu.id}`}
                  submitLabel="Save menu"
                  hidden={{ expectedVersion: menu.version }}
                  fields={[
                    ...basicFields(menu),
                    { name: "active", label: "Active", type: "checkbox", defaultValue: menu.active },
                  ]}
                />
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-label="Menu items" className="mb-10">
        <h2 className="mb-3 text-xl font-semibold">Menu items</h2>
        <div className="mb-4 rounded border border-neutral-200 p-4">
          <h3 className="mb-3 font-semibold">Add a menu item</h3>
          <EntityForm
            method="POST"
            url="/api/menu/items"
            submitLabel="Add item"
            resetOnSuccess
            fields={[
              codeField(),
              { name: "name", label: "Name", required: true },
              { name: "shortName", label: "Short name" },
              { name: "description", label: "Description" },
              { name: "itemType", label: "Type", type: "select", required: true, options: ITEM_TYPE_OPTIONS, defaultValue: "FOOD" },
              { name: "displayOrder", label: "Display order", type: "number", defaultValue: 0 },
            ]}
          />
        </div>
        {unplaced.length > 0 && (
          <p className="mb-3 text-sm text-amber-800">
            {unplaced.length} item{unplaced.length === 1 ? " is" : "s are"} not on any menu.
          </p>
        )}
        <ul className="grid gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-neutral-200 p-3"
            >
              <span>
                <span className="font-medium">{item.name}</span>{" "}
                <span className="text-neutral-600">
                  {item.code}
                  {item.active ? "" : " · Inactive"}
                  {item.active && !item.available ? " · Unavailable" : ""}
                </span>
              </span>
              <Link
                href={`/menu/items/${item.id}`}
                className="inline-flex min-h-11 items-center rounded border border-neutral-400 px-3 text-sm font-medium"
              >
                Edit {item.name}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
