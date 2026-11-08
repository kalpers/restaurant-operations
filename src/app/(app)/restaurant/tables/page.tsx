import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listAreas } from "@/modules/organization/services/organization-service";
import { listTablesForConfiguration } from "@/modules/restaurant/services/table-service";

export default async function TablesPage() {
  const { location, actor } = await requirePageActor("restaurant.tables.manage");
  const database = getDatabase();
  const tables = await listTablesForConfiguration(database, actor);
  // Takeout isn't a seating area, so it isn't offered.
  const areaOptions = (await listAreas(database, location.locationId))
    .filter((area) => area.areaType !== "TAKEOUT")
    .map((area) => ({ value: area.id, label: area.name }));

  const fields = (table?: (typeof tables)[number]): FormField[] => [
    { name: "tableNumber", label: "Table number", required: true, defaultValue: table?.tableNumber },
    { name: "name", label: "Display name", defaultValue: table?.name },
    {
      name: "restaurantAreaId",
      label: "Area",
      type: "select",
      required: true,
      options: areaOptions,
      defaultValue: table?.restaurantAreaId,
    },
    { name: "capacity", label: "Capacity", type: "number", required: true, defaultValue: table?.capacity },
    { name: "minimumCapacity", label: "Minimum capacity", type: "number", defaultValue: table?.minimumCapacity },
    { name: "sortOrder", label: "Sort order", type: "number", defaultValue: table?.sortOrder },
  ];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Tables</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      <section className="mb-8 rounded border border-neutral-200 p-4">
        <h2 className="mb-3 font-semibold">Add a table</h2>
        <EntityForm
          method="POST"
          url="/api/restaurant/tables"
          submitLabel="Add table"
          resetOnSuccess
          fields={fields()}
        />
      </section>

      {tables.length === 0 ? (
        <p className="text-neutral-600">No tables yet.</p>
      ) : (
        <ul className="grid gap-4">
          {tables.map((table) => (
            <li
              key={table.id}
              aria-label={`Table ${table.tableNumber}`}
              className="rounded border border-neutral-200 p-4"
            >
              <h2 className="mb-3 font-semibold">
                {table.tableNumber}
                <span className="ml-2 font-normal text-neutral-600">
                  {table.areaName}
                  {table.active ? "" : " · Inactive"}
                </span>
              </h2>
              <EntityForm
                method="PATCH"
                url={`/api/restaurant/tables/${table.id}`}
                submitLabel="Save table"
                hidden={{ expectedVersion: table.version }}
                fields={[
                  ...fields(table),
                  { name: "active", label: "Active", type: "checkbox", defaultValue: table.active },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
