import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listCertificationTypes } from "@/modules/employees/services/reference-service";

export default async function CertificationTypesPage() {
  const { actor } = await requirePageActor("hr.certifications.manage");
  const types = await listCertificationTypes(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Certification types</h1>

      <section className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 font-semibold">Add a certification type</h2>
        <EntityForm
          method="POST"
          url="/api/certification-types"
          submitLabel="Create certification type"
          resetOnSuccess
          fields={[
            { name: "code", label: "Code", required: true },
            { name: "name", label: "Name", required: true },
            { name: "description", label: "Description" },
            { name: "warningDays", label: "Warning days", type: "number" },
            { name: "expirationRequired", label: "Expiration required", type: "checkbox" },
          ]}
        />
      </section>

      <ul className="grid gap-4">
        {types.map((type) => (
          <li key={type.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <p className="mb-3 font-medium">{type.code}</p>
            <EntityForm
              method="PATCH"
              url={`/api/certification-types/${type.id}`}
              submitLabel="Save certification type"
              hidden={{ expectedVersion: type.version }}
              fields={[
                { name: "name", label: "Name", required: true, defaultValue: type.name },
                { name: "description", label: "Description", defaultValue: type.description },
                { name: "warningDays", label: "Warning days", type: "number", defaultValue: type.warningDays },
                { name: "expirationRequired", label: "Expiration required", type: "checkbox", defaultValue: type.expirationRequired },
                { name: "active", label: "Active", type: "checkbox", defaultValue: type.active },
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
