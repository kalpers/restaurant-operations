import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePagePermission } from "@/modules/auth/guards";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { getOrganization } from "@/modules/organization/services/organization-service";

export default async function OrganizationPage() {
  const { auth, location } = await requirePagePermission("organization.view");
  const organization = await getOrganization(
    getDatabase(),
    location.organizationId,
  );
  const canManage = hasPermission(
    auth,
    "organization.manage",
    location.locationId,
  );

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Organization</h1>
      {canManage ? (
        <EntityForm
          key={organization.version}
          method="PATCH"
          url="/api/admin/organization"
          submitLabel="Save organization"
          hidden={{ expectedVersion: organization.version }}
          fields={[
            { name: "name", label: "Name", required: true, defaultValue: organization.name },
            { name: "legalName", label: "Legal name", defaultValue: organization.legalName },
            { name: "phone", label: "Phone", defaultValue: organization.phone },
            { name: "email", label: "Email", type: "email", defaultValue: organization.email },
            { name: "defaultTimezone", label: "Default timezone", required: true, defaultValue: organization.defaultTimezone },
            { name: "defaultCurrency", label: "Default currency", required: true, defaultValue: organization.defaultCurrency },
          ]}
        />
      ) : (
        <dl className="grid gap-3 sm:grid-cols-2">
          {[
            ["Name", organization.name],
            ["Legal name", organization.legalName],
            ["Phone", organization.phone],
            ["Email", organization.email],
            ["Default timezone", organization.defaultTimezone],
            ["Default currency", organization.defaultCurrency],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-sm text-neutral-600">{label}</dt>
              <dd>{value ?? "Not set"}</dd>
            </div>
          ))}
        </dl>
      )}
    </>
  );
}
