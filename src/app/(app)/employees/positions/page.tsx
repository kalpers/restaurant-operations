import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listPositions } from "@/modules/employees/services/reference-service";

export default async function PositionsPage() {
  const { actor } = await requirePageActor("employees.positions.manage");
  const positions = await listPositions(getDatabase(), actor);

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Positions</h1>
      <p className="mb-4 text-neutral-600">
        Jobs people do. A position holds no wage and grants no software access.
      </p>

      <section className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <h2 className="mb-3 font-semibold">Add a position</h2>
        <EntityForm
          method="POST"
          url="/api/positions"
          submitLabel="Create position"
          resetOnSuccess
          fields={[
            { name: "code", label: "Code", required: true },
            { name: "name", label: "Name", required: true },
            { name: "description", label: "Description" },
          ]}
        />
      </section>

      <ul className="grid gap-4">
        {positions.map((position) => (
          <li key={position.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <p className="mb-3 font-medium">{position.code}</p>
            <EntityForm
              method="PATCH"
              url={`/api/positions/${position.id}`}
              submitLabel="Save position"
              hidden={{ expectedVersion: position.version }}
              fields={[
                { name: "name", label: "Name", required: true, defaultValue: position.name },
                { name: "description", label: "Description", defaultValue: position.description },
                { name: "active", label: "Active", type: "checkbox", defaultValue: position.active },
              ]}
            />
          </li>
        ))}
      </ul>
    </>
  );
}
