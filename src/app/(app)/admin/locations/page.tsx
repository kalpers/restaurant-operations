import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { listLocationsWithSettings } from "@/modules/organization/services/organization-service";

export default async function LocationsPage() {
  const { auth } = await requirePagePermission("locations.view");
  const viewableIds = auth.locations
    .filter((location) =>
      hasPermission(auth, "locations.view", location.locationId),
    )
    .map((location) => location.locationId);
  const rows = await listLocationsWithSettings(getDatabase(), viewableIds);

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Locations</h1>
      <div className="grid gap-8">
        {rows.map(({ location, settings }) =>
          hasPermission(auth, "locations.manage", location.id) ? (
            <section key={location.id} className="grid gap-6">
              <h2 className="text-lg font-semibold">
                {location.name} ({location.locationCode})
              </h2>
              <EntityForm
                key={`location-${location.version}`}
                method="PATCH"
                url={`/api/admin/locations/${location.id}`}
                submitLabel="Save location"
                hidden={{ expectedVersion: location.version }}
                fields={[
                  { name: "name", label: "Name", required: true, defaultValue: location.name },
                  { name: "addressLine1", label: "Address line 1", defaultValue: location.addressLine1 },
                  { name: "addressLine2", label: "Address line 2", defaultValue: location.addressLine2 },
                  { name: "city", label: "City", defaultValue: location.city },
                  { name: "state", label: "State", defaultValue: location.state },
                  { name: "postalCode", label: "Postal code", defaultValue: location.postalCode },
                  { name: "country", label: "Country", required: true, defaultValue: location.country },
                  { name: "phone", label: "Phone", defaultValue: location.phone },
                  { name: "email", label: "Email", type: "email", defaultValue: location.email },
                  { name: "timezone", label: "Timezone", required: true, defaultValue: location.timezone },
                ]}
              />
              <h3 className="font-semibold">Settings</h3>
              <EntityForm
                key={`settings-${settings.version}`}
                method="PATCH"
                url={`/api/admin/locations/${location.id}/settings`}
                submitLabel="Save settings"
                hidden={{ expectedVersion: settings.version }}
                fields={[
                  { name: "businessDayCutoff", label: "Business day cutoff", type: "time", required: true, defaultValue: settings.businessDayCutoff.slice(0, 5) },
                  { name: "defaultTableTurnMinutes", label: "Table turn (minutes)", type: "number", required: true, defaultValue: settings.defaultTableTurnMinutes },
                  { name: "defaultReservationDurationMinutes", label: "Reservation length (minutes)", type: "number", required: true, defaultValue: settings.defaultReservationDurationMinutes },
                  { name: "defaultWaitQuoteMinutes", label: "Wait quote (minutes)", type: "number", required: true, defaultValue: settings.defaultWaitQuoteMinutes },
                  { name: "allowWalkIns", label: "Allow walk-ins", type: "checkbox", defaultValue: settings.allowWalkIns },
                  { name: "allowReservations", label: "Allow reservations", type: "checkbox", defaultValue: settings.allowReservations },
                  { name: "allowTakeout", label: "Allow takeout", type: "checkbox", defaultValue: settings.allowTakeout },
                  { name: "inventoryEnabled", label: "Inventory enabled", type: "checkbox", defaultValue: settings.inventoryEnabled },
                  { name: "schedulingEnabled", label: "Scheduling enabled", type: "checkbox", defaultValue: settings.schedulingEnabled },
                  { name: "kitchenDisplayEnabled", label: "Kitchen display enabled", type: "checkbox", defaultValue: settings.kitchenDisplayEnabled },
                ]}
              />
            </section>
          ) : (
            <section key={location.id}>
              <h2 className="text-lg font-semibold">
                {location.name} ({location.locationCode})
              </h2>
              <p className="text-neutral-700">Timezone: {location.timezone}</p>
              <p className="text-neutral-700">
                Business day cutoff: {settings.businessDayCutoff.slice(0, 5)}
              </p>
            </section>
          ),
        )}
      </div>
    </>
  );
}
