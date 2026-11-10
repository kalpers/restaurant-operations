import { EntityForm, type FormField } from "@/components/forms/entity-form";
import { STATION_TYPE_OPTIONS } from "@/components/menu/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listStations } from "@/modules/menu/services/prep-station-service";

export default async function PrepStationsPage() {
  const { location, actor } = await requirePageActor("prep-stations.manage");
  const stations = await listStations(getDatabase(), actor);

  const fields = (station?: (typeof stations)[number]): FormField[] => [
    { name: "name", label: "Name", required: true, defaultValue: station?.name },
    {
      name: "stationType",
      label: "Type",
      type: "select",
      required: true,
      options: STATION_TYPE_OPTIONS,
      defaultValue: station?.stationType ?? "KITCHEN",
    },
    { name: "sortOrder", label: "Sort order", type: "number", defaultValue: station?.sortOrder ?? 0 },
  ];

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Prep stations</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      <section className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 font-semibold">Add a station</h2>
        <EntityForm
          method="POST"
          url="/api/prep-stations"
          submitLabel="Add station"
          resetOnSuccess
          fields={[{ name: "code", label: "Code (capitals, digits, underscores)", required: true }, ...fields()]}
        />
      </section>

      <ul className="grid gap-4">
        {stations.map((station) => (
          <li
            key={station.id}
            aria-label={`Station ${station.code}`}
            className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
          >
            <h2 className="mb-3 font-semibold">
              {station.code}
              {station.active ? "" : " · Inactive"}
            </h2>
            <EntityForm
              method="PATCH"
              url={`/api/prep-stations/${station.id}`}
              submitLabel="Save station"
              hidden={{ expectedVersion: station.version }}
              fields={[
                ...fields(station),
                { name: "active", label: "Active", type: "checkbox", defaultValue: station.active },
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
