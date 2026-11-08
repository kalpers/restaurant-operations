import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { SectionTablesForm } from "@/components/restaurant/section-tables-form";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listAreas } from "@/modules/organization/services/organization-service";
import { actorHolds } from "@/modules/restaurant/services/access";
import { listServerCandidates } from "@/modules/restaurant/services/floor-service";
import { listSections } from "@/modules/restaurant/services/section-service";
import { listTablesForConfiguration } from "@/modules/restaurant/services/table-service";

export default async function SectionsPage() {
  const { location, actor } = await requirePageActor("restaurant.sections.manage");
  const database = getDatabase();
  const sections = await listSections(database, actor);
  const tables = await listTablesForConfiguration(database, actor);
  const seatingAreas = (await listAreas(database, location.locationId)).filter(
    (area) => area.areaType !== "TAKEOUT",
  );
  const areaOptions = [
    { value: "", label: "No area" },
    ...seatingAreas.map((area) => ({ value: area.id, label: area.name })),
  ];
  const canAssign = actorHolds(actor, "restaurant.server.assign");
  const canOverride = actorHolds(actor, "restaurant.schedule.override");
  const candidatesByArea = new Map(
    canAssign
      ? await Promise.all(
          seatingAreas.map(
            async (area) =>
              [
                area.id,
                await listServerCandidates(database, actor, { areaId: area.id }),
              ] as const,
          ),
        )
      : [],
  );

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Sections</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>

      <section className="mb-8 rounded border border-neutral-200 p-4">
        <h2 className="mb-3 font-semibold">Add a section</h2>
        <EntityForm
          method="POST"
          url="/api/restaurant/sections"
          submitLabel="Add section"
          resetOnSuccess
          fields={[
            { name: "code", label: "Code", required: true },
            { name: "name", label: "Name", required: true },
            { name: "restaurantAreaId", label: "Area", type: "select", options: areaOptions },
          ]}
        />
      </section>

      {sections.length === 0 ? (
        <p className="text-neutral-600">No sections yet.</p>
      ) : (
        <ul className="grid gap-4">
          {sections.map((section) => {
            const eligibleTables = tables.filter(
              (table) =>
                table.active &&
                (!section.restaurantAreaId ||
                  table.restaurantAreaId === section.restaurantAreaId),
            );
            const candidates = section.restaurantAreaId
              ? (candidatesByArea.get(section.restaurantAreaId) ?? [])
              : [
                  ...new Map(
                    [...candidatesByArea.values()]
                      .flat()
                      .map((candidate) => [candidate.employeeId, candidate]),
                  ).values(),
                ];

            return (
              <li
                key={section.id}
                aria-label={`Section ${section.code}`}
                className="grid gap-4 rounded border border-neutral-200 p-4"
              >
                <h2 className="font-semibold">
                  {section.name} ({section.code})
                  {section.active ? "" : " · Inactive"}
                </h2>
                <EntityForm
                  method="PATCH"
                  url={`/api/restaurant/sections/${section.id}`}
                  submitLabel="Save section"
                  hidden={{ expectedVersion: section.version }}
                  fields={[
                    { name: "name", label: "Name", required: true, defaultValue: section.name },
                    {
                      name: "restaurantAreaId",
                      label: "Area",
                      type: "select",
                      options: areaOptions,
                      defaultValue: section.restaurantAreaId,
                    },
                    { name: "active", label: "Active", type: "checkbox", defaultValue: section.active },
                  ]}
                />
                {section.active && (
                  <SectionTablesForm
                    sectionId={section.id}
                    version={section.version}
                    tables={eligibleTables}
                    initialTableIds={section.tables.map((table) => table.tableId)}
                  />
                )}
                {section.active && canAssign && (
                  <div className="grid gap-2 border-t border-neutral-200 pt-3">
                    <h3 className="text-sm font-semibold">Server today</h3>
                    {section.currentAssignment ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span>{section.currentAssignment.displayName}</span>
                        <ActionButton
                          method="POST"
                          url={`/api/restaurant/section-assignments/${section.currentAssignment.id}/end`}
                          body={{ expectedVersion: section.currentAssignment.version }}
                          label="End assignment"
                        />
                      </div>
                    ) : (
                      <EntityForm
                        method="POST"
                        url={`/api/restaurant/sections/${section.id}/assignments`}
                        submitLabel="Assign server"
                        resetOnSuccess
                        fields={[
                          {
                            name: "employeeId",
                            label: "Server",
                            type: "select",
                            required: true,
                            options: candidates.map((candidate) => ({
                              value: candidate.employeeId,
                              label: candidate.scheduledNow
                                ? candidate.displayName
                                : `${candidate.displayName} (not on shift)`,
                            })),
                          },
                          ...(canOverride
                            ? [
                                {
                                  name: "scheduleOverrideReason",
                                  label: "Schedule override reason, if not on shift",
                                },
                              ]
                            : []),
                        ]}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
