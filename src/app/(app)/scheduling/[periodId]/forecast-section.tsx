import { ActionButton } from "@/components/forms/action-button";
import { shortTime } from "@/components/scheduling/format";
import { hourLabel, MEASURE_LABELS, type DemandMeasure } from "@/modules/scheduling/rules/demand-forecast";
import type { getPeriodForecast } from "@/modules/scheduling/services/forecast-service";

export type ForecastData = Awaited<ReturnType<typeof getPeriodForecast>>;

const STATUS_TEXT: Record<string, string> = {
  OK: "Forecast",
  NOT_ENOUGH_HISTORY: "Not enough history",
  BOOKINGS_ONLY: "Bookings only",
};

const SHOWN: readonly DemandMeasure[] = ["DINING_COVERS", "BAR_CHECKS", "TAKEOUT_CHECKS", "ALL_CHECKS"];

function plain(value: string | null): string {
  if (value === null) {
    return "–";
  }

  return value.endsWith(".00") ? value.slice(0, -3) : value;
}

function weekday(date: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
}

/** The busy hours of one date: hours where any measure is above zero or covers are booked. */
function busyHours(date: ForecastData["dates"][number]) {
  return date.hours.filter((hour) =>
    SHOWN.some((measure) => {
      const value = hour.values[measure];

      return value.booked > 0 || (value.forecast !== null && value.forecast !== "0.00");
    }),
  );
}

/**
 * Phase 24 (policies 10 and 13, D5): the period's demand forecast and what it suggests for
 * each shift from a template. Suggestions change a shift only when a manager uses them.
 */
export function ForecastSection({ forecast, canApply }: { forecast: ForecastData; canApply: boolean }) {
  const templateShifts = forecast.shifts.filter((shift) => shift.fromTemplate);
  const changes = templateShifts.filter(
    (shift) => shift.applyCount !== null && shift.applyCount !== shift.currentCount,
  );

  return (
    <section
      aria-labelledby="forecast-heading"
      data-testid="forecast-section"
      className="mb-8 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4"
    >
      <h2 id="forecast-heading" className="mb-1 font-semibold">
        Demand forecast
      </h2>
      <p className="mb-3 text-sm text-neutral-600">
        The same weekday over the last {forecast.settings.lookbackWeeks} weeks of closed checks,
        newest weeks counting most, raised to the covers already booked. A date needs at least{" "}
        {forecast.settings.minimumSamples} past weeks.
        {forecast.excludedDates.length > 0 && ` Left out: ${forecast.excludedDates.join(", ")}.`}{" "}
        Shifts change only when you use a suggestion.
      </p>

      {forecast.ratios.length === 0 && (
        <p className="mb-3 rounded border border-amber-300 bg-warning-50 p-3 text-sm text-warning-900">
          No staffing ratios yet, so nothing is sized. Add them on Staffing &amp; rules.
        </p>
      )}

      {forecast.dates.length === 0 ? (
        <p className="mb-3 text-sm text-neutral-600">Every date in this period has passed.</p>
      ) : (
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          {forecast.dates.map((date) => {
            const hours = busyHours(date);

            return (
              <div key={date.businessDate} data-testid="forecast-date" className="overflow-x-auto">
                <h3 className="mb-1 font-medium">
                  {weekday(date.businessDate)} {date.businessDate}:{" "}
                  <span data-testid="forecast-date-status">{STATUS_TEXT[date.status] ?? date.status}</span>
                </h3>
                {date.sampleDates.length > 0 && (
                  <p className="mb-1 text-xs text-neutral-600">From {date.sampleDates.join(", ")}</p>
                )}
                {hours.length > 0 && (
                  <table className="w-full border-collapse text-left text-sm">
                    <thead className="bg-neutral-100 text-neutral-800">
                      <tr className="border-b border-neutral-300">
                        <th className="px-2 py-1 font-semibold">Hour</th>
                        {SHOWN.map((measure) => (
                          <th key={measure} className="px-2 py-1 font-semibold">
                            {MEASURE_LABELS[measure].name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="[&>tr:nth-child(even)]:bg-neutral-50">
                      {hours.map((hour) => (
                        <tr key={hour.hour} className="border-b border-neutral-200">
                          <td className="px-2 py-1 whitespace-nowrap">{hourLabel(hour.hour)}</td>
                          {SHOWN.map((measure) => {
                            const value = hour.values[measure];

                            return (
                              <td key={measure} className="px-2 py-1">
                                {plain(value.forecast)}
                                {measure === "DINING_COVERS" && value.booked > 0 && (
                                  <span className="text-xs text-neutral-600"> ({value.booked} booked)</span>
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })}
        </div>
      )}

      {templateShifts.length > 0 && (
        <div className="overflow-x-auto">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Suggested headcount</h3>
            {canApply && changes.length > 0 && (
              <ActionButton
                method="POST"
                url={`/api/scheduling/periods/${forecast.period.id}/forecast/apply`}
                body={{ expectedPeriodVersion: forecast.period.version }}
                label="Use all suggestions"
                confirm={{
                  title: `Use ${changes.length} suggestion(s)?`,
                  body: "Each shift from a template is set to the forecast's count, never below the people already assigned. You can still edit any shift.",
                  tone: "primary",
                }}
              />
            )}
          </div>
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-neutral-100 text-neutral-800">
              <tr className="border-b border-neutral-300">
                <th className="px-2 py-1 font-semibold">Shift</th>
                <th className="px-2 py-1 font-semibold">Template</th>
                <th className="px-2 py-1 font-semibold">Now</th>
                <th className="px-2 py-1 font-semibold">Suggested</th>
                <th className="px-2 py-1 font-semibold">Why</th>
                {canApply && <th className="px-2 py-1 font-semibold"><span className="sr-only">Action</span></th>}
              </tr>
            </thead>
            <tbody className="[&>tr:nth-child(even)]:bg-neutral-50">
              {templateShifts.map((shift) => (
                <tr key={shift.shiftId} data-testid="forecast-shift" className="border-b border-neutral-200 align-top">
                  <td className="px-2 py-1">
                    {weekday(shift.shiftDate)} {shift.shiftDate}, {shortTime(shift.startTime)}–{shortTime(shift.endTime)}:{" "}
                    {shift.positionName}
                    {shift.restaurantAreaName ? ` (${shift.restaurantAreaName})` : ""}
                  </td>
                  <td className="px-2 py-1">{shift.templateCount ?? "–"}</td>
                  <td className="px-2 py-1">{shift.currentCount}</td>
                  <td className="px-2 py-1" data-testid="forecast-suggested">
                    {shift.applyCount ?? "–"}
                  </td>
                  <td className="px-2 py-1 text-neutral-700">{shift.explanation}</td>
                  {canApply && (
                    <td className="px-2 py-1">
                      {shift.applyCount !== null && shift.applyCount !== shift.currentCount && (
                        <ActionButton
                          method="POST"
                          url={`/api/scheduling/periods/${forecast.period.id}/forecast/apply`}
                          body={{ expectedPeriodVersion: forecast.period.version, shiftIds: [shift.shiftId] }}
                          label="Use suggestion"
                        />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
