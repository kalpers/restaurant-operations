import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { DEMAND_MEASURES, MEASURE_LABELS } from "@/modules/scheduling/rules/demand-forecast";
import type { getForecastSettings } from "@/modules/scheduling/services/forecast-service";

type ForecastSettings = Awaited<ReturnType<typeof getForecastSettings>>;

const MEASURE_OPTIONS = DEMAND_MEASURES.map((measure) => ({
  value: measure,
  label: MEASURE_LABELS[measure].name,
}));

/**
 * Phase 24 (policies 6 and 7): staffing ratios and dates left out of forecast history, on
 * the Staffing & rules page under `schedule.rules.manage`.
 */
export function ForecastSettingsSection({ settings }: { settings: ForecastSettings }) {
  const withRatio = new Set(settings.ratios.filter((ratio) => ratio.active).map((ratio) => ratio.positionId));
  const positionOptions = settings.positions
    .filter((position) => !withRatio.has(position.id))
    .map((position) => ({ value: position.id, label: position.name }));

  return (
    <section className="mb-10" aria-labelledby="forecast-settings-heading">
      <h2 id="forecast-settings-heading" className="mb-1 text-lg font-semibold">
        Demand forecast
      </h2>
      <p className="mb-3 text-sm text-neutral-600">
        A staffing ratio says how much one person in a position handles in an hour. Applying a
        template with the forecast sizes each shift from its busiest hour, rounded up and held
        between the minimum and maximum. Positions without a ratio keep the template&apos;s count.
      </p>

      <h3 className="mb-2 font-medium">Staffing ratios</h3>
      {settings.ratios.length > 0 && (
        <ul className="mb-4 grid gap-3">
          {settings.ratios.map((ratio) => (
            <li
              key={ratio.id}
              data-testid="staffing-ratio"
              className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
            >
              <p className="mb-2 font-medium">
                {ratio.positionName}
                {ratio.active ? "" : " (inactive)"}
              </p>
              <EntityForm
                method="PATCH"
                url={`/api/scheduling/forecast/ratios/${ratio.id}`}
                submitLabel="Save ratio"
                hidden={{ expectedVersion: ratio.version, active: ratio.active }}
                fields={[
                  { name: "measure", label: "Demand", type: "select", required: true, options: MEASURE_OPTIONS, defaultValue: ratio.measure },
                  { name: "unitsPerEmployeeHour", label: "One person handles per hour", required: true, defaultValue: ratio.unitsPerEmployeeHour },
                  { name: "minimumEmployees", label: "Minimum people", type: "number", required: true, defaultValue: ratio.minimumEmployees },
                  { name: "maximumEmployees", label: "Maximum people", type: "number", required: true, defaultValue: ratio.maximumEmployees },
                ]}
              />
              <div className="mt-2">
                <ActionButton
                  method="PATCH"
                  url={`/api/scheduling/forecast/ratios/${ratio.id}`}
                  body={{
                    measure: ratio.measure,
                    unitsPerEmployeeHour: ratio.unitsPerEmployeeHour,
                    minimumEmployees: ratio.minimumEmployees,
                    maximumEmployees: ratio.maximumEmployees,
                    active: !ratio.active,
                    expectedVersion: ratio.version,
                  }}
                  label={ratio.active ? "Deactivate ratio" : "Reactivate ratio"}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {positionOptions.length > 0 && (
        <div className="mb-6 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <EntityForm
            method="POST"
            url="/api/scheduling/forecast/ratios"
            submitLabel="Add ratio"
            resetOnSuccess
            fields={[
              { name: "positionId", label: "Position", type: "select", required: true, options: positionOptions },
              { name: "measure", label: "Demand", type: "select", required: true, options: MEASURE_OPTIONS, defaultValue: "DINING_COVERS" },
              { name: "unitsPerEmployeeHour", label: "One person handles per hour", required: true },
              { name: "minimumEmployees", label: "Minimum people", type: "number", required: true, defaultValue: 1 },
              { name: "maximumEmployees", label: "Maximum people", type: "number", required: true, defaultValue: 6 },
            ]}
          />
        </div>
      )}

      <h3 className="mb-1 font-medium">Dates left out of the history</h3>
      <p className="mb-2 text-sm text-neutral-600">
        For a day that wasn&apos;t typical, such as a storm or a private event. Forecasts already
        used keep the dates they used.
      </p>
      {settings.excludedDates.length > 0 && (
        <ul className="mb-3 grid gap-2">
          {settings.excludedDates.map((row) => (
            <li key={row.id} data-testid="excluded-date" className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span>
                {row.excludedDate}: {row.reason}
              </span>
              <ActionButton
                method="DELETE"
                url={`/api/scheduling/forecast/excluded-dates/${row.id}`}
                label="Put back"
              />
            </li>
          ))}
        </ul>
      )}
      <div className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
        <EntityForm
          method="POST"
          url="/api/scheduling/forecast/excluded-dates"
          submitLabel="Leave date out"
          resetOnSuccess
          fields={[
            { name: "excludedDate", label: "Date", type: "date", required: true },
            { name: "reason", label: "Reason", required: true },
          ]}
        />
      </div>
    </section>
  );
}
