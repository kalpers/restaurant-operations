import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { DAY_OPTIONS, shortTime } from "@/components/scheduling/format";
import { getDatabase } from "@/db";
import { requirePageActorWithAny } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/scheduling/services/access";
import {
  getRules,
  getShiftFormOptions,
  listTemplates,
} from "@/modules/scheduling/services/config-service";
import { DAYS_OF_WEEK } from "@/modules/scheduling/types";

export default async function StaffingAndRulesPage() {
  const { actor } = await requirePageActorWithAny([
    "schedule.templates.manage",
    "schedule.rules.manage",
  ]);
  const database = getDatabase();
  const canManageTemplates = actorHolds(actor, "schedule.templates.manage");
  const canManageRules = actorHolds(actor, "schedule.rules.manage");
  const templates = canManageTemplates ? await listTemplates(database, actor) : [];
  const options = canManageTemplates
    ? await getShiftFormOptions(database, actor)
    : { positions: [], areas: [] };
  const rules = canManageRules ? await getRules(database, actor) : null;

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Staffing &amp; rules</h1>

      {canManageTemplates && (
        <section className="mb-10">
          <h2 className="mb-1 text-lg font-semibold">Staffing templates</h2>
          <p className="mb-3 text-sm text-neutral-600">
            Reusable staffing demand. A template says what&apos;s needed, never who works
            it. An end at or before the start runs past midnight.
          </p>

          <div className="mb-6 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <EntityForm
              method="POST"
              url="/api/scheduling/templates"
              submitLabel="Create template"
              resetOnSuccess
              fields={[
                { name: "name", label: "Template name", required: true },
                { name: "description", label: "Description" },
              ]}
            />
          </div>

          <ul className="grid gap-4">
            {templates.map((template) => (
              <li
                key={template.id}
                data-testid="staffing-template"
                className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
              >
                <h3 className="mb-2 font-medium">
                  {template.name}
                  {template.active ? "" : " (inactive)"}
                </h3>

                {template.requirements.length > 0 && (
                  <ul className="mb-3 grid gap-2">
                    {template.requirements.map((requirement) => (
                      <li
                        key={requirement.id}
                        className="flex flex-wrap items-center justify-between gap-2 text-sm"
                      >
                        <span>
                          {DAYS_OF_WEEK[requirement.dayOfWeek]},{" "}
                          {shortTime(requirement.startTime)} to{" "}
                          {shortTime(requirement.endTime)}: {requirement.positionName}{" "}
                          × {requirement.requiredEmployeeCount}
                          {requirement.restaurantAreaName
                            ? `, ${requirement.restaurantAreaName}`
                            : ""}
                          {requirement.priority !== 0
                            ? `, priority ${requirement.priority}`
                            : ""}
                        </span>
                        <ActionButton
                          method="DELETE"
                          url={`/api/scheduling/templates/${template.id}/requirements/${requirement.id}`}
                          label="Remove"
                          confirm={{ title: "Remove this staffing requirement?", confirmLabel: "Remove requirement" }}
                        />
                      </li>
                    ))}
                  </ul>
                )}

                <details className="mb-3">
                  <summary className="cursor-pointer text-sm underline">
                    Add a requirement
                  </summary>
                  <div className="mt-2">
                    <EntityForm
                      method="POST"
                      url={`/api/scheduling/templates/${template.id}/requirements`}
                      submitLabel="Add requirement"
                      resetOnSuccess
                      fields={[
                        { name: "dayOfWeek", label: "Day", type: "select", required: true, options: DAY_OPTIONS },
                        {
                          name: "positionId",
                          label: "Position",
                          type: "select",
                          required: true,
                          options: options.positions.map((row) => ({
                            value: row.id,
                            label: row.name,
                          })),
                        },
                        {
                          name: "restaurantAreaId",
                          label: "Area",
                          type: "select",
                          options: [
                            { value: "", label: "No specific area" },
                            ...options.areas.map((row) => ({
                              value: row.id,
                              label: row.name,
                            })),
                          ],
                        },
                        { name: "startTime", label: "Start", type: "time", required: true },
                        { name: "endTime", label: "End", type: "time", required: true },
                        { name: "requiredEmployeeCount", label: "People needed", type: "number", required: true, defaultValue: 1 },
                        { name: "priority", label: "Priority", type: "number", defaultValue: 0 },
                      ]}
                    />
                  </div>
                </details>

                <ActionButton
                  method="PATCH"
                  url={`/api/scheduling/templates/${template.id}`}
                  body={{
                    name: template.name,
                    description: template.description,
                    active: !template.active,
                    expectedVersion: template.version,
                  }}
                  label={template.active ? "Deactivate" : "Reactivate"}
                  confirm={
                    template.active
                      ? {
                          title: `Deactivate ${template.name}?`,
                          body: "Schedule generation stops using it. Existing schedules aren't changed.",
                        }
                      : undefined
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      {rules && (
        <section>
          <h2 className="mb-1 text-lg font-semibold">Scheduling rules</h2>
          <p className="mb-3 text-sm text-neutral-600">
            A limit marked as a hard limit stops anyone being scheduled past it, for
            manual and automatic scheduling alike. Otherwise it only affects scores and
            warnings. These are your own settings, and don&apos;t establish compliance with
            any labor law.
          </p>
          <EntityForm
            method="PUT"
            url="/api/scheduling/rules"
            submitLabel="Save rules"
            hidden={{ expectedVersion: rules.version }}
            fields={[
              { name: "weekStartDay", label: "Week starts on", type: "select", required: true, options: DAY_OPTIONS, defaultValue: String(rules.weekStartDay) },
              { name: "avoidOvertime", label: "Preference: avoid overtime", type: "checkbox", defaultValue: rules.avoidOvertime },
              { name: "weeklyOvertimeThreshold", label: "Weekly overtime threshold (hours)", required: true, defaultValue: rules.weeklyOvertimeThreshold },
              { name: "maximumWeeklyHours", label: "Hard limit: maximum weekly hours", defaultValue: rules.maximumWeeklyHours },
              { name: "minimumRestHours", label: "Minimum rest between shifts (hours)", defaultValue: rules.minimumRestHours },
              { name: "minimumRestHard", label: "Minimum rest is a hard limit", type: "checkbox", defaultValue: rules.minimumRestHard },
              { name: "maximumDaysPerWeek", label: "Maximum days per week", type: "number", defaultValue: rules.maximumDaysPerWeek },
              { name: "maximumDaysHard", label: "Maximum days is a hard limit", type: "checkbox", defaultValue: rules.maximumDaysHard },
              { name: "maximumConsecutiveDays", label: "Maximum consecutive days", type: "number", defaultValue: rules.maximumConsecutiveDays },
              { name: "maximumConsecutiveHard", label: "Maximum consecutive days is a hard limit", type: "checkbox", defaultValue: rules.maximumConsecutiveHard },
              { name: "balanceWeekendShifts", label: "Preference: balance weekend shifts", type: "checkbox", defaultValue: rules.balanceWeekendShifts },
              { name: "balanceClosingShifts", label: "Preference: balance closing shifts", type: "checkbox", defaultValue: rules.balanceClosingShifts },
              { name: "preferTargetHours", label: "Preference: move toward target hours", type: "checkbox", defaultValue: rules.preferTargetHours },
            ]}
          />
        </section>
      )}
    </>
  );
}
