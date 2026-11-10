import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { listAreas } from "@/modules/organization/services/organization-service";

export default async function AreasPage() {
  const { auth, location } = await requirePagePermission("locations.view");
  const areas = await listAreas(getDatabase(), location.locationId);
  const canManage = hasPermission(auth, "locations.manage", location.locationId);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Restaurant areas</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <ul className="grid gap-6">
        {areas.map((area) => (
          <li key={area.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <h2 className="mb-3 font-semibold">
              {area.name} ({area.code})
            </h2>
            {canManage ? (
              <EntityForm
                method="PATCH"
                url={`/api/admin/areas/${area.id}`}
                submitLabel="Save area"
                fields={[
                  { name: "name", label: "Name", required: true, defaultValue: area.name },
                  { name: "displayOrder", label: "Display order", type: "number", required: true, defaultValue: area.displayOrder },
                  { name: "active", label: "Active", type: "checkbox", defaultValue: area.active },
                ]}
              />
            ) : (
              <p className="text-neutral-700">{area.active ? "Active" : "Inactive"}</p>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
