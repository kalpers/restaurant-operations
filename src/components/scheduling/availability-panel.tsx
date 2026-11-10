import { humanize, optionsFrom } from "@/components/employees/format";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getAvailability } from "@/modules/scheduling/services/availability-service";
import { AVAILABILITY_TYPES, DAYS_OF_WEEK } from "@/modules/scheduling/types";

import { DAY_OPTIONS, flagOption, shortTime, YES_NO_OPTIONS } from "./format";

type AvailabilityData = Awaited<ReturnType<typeof getAvailability>>;

/**
 * Keeps availability and preferences visibly apart: one decides whether someone can be
 * scheduled at all, the other only nudges the generator and is never a guarantee.
 */
export function AvailabilityPanel({
  data,
  baseUrl,
}: {
  data: AvailabilityData;
  baseUrl: string;
}) {
  const { recurring, exceptions, preferences } = data;

  return (
    <div className="grid gap-8">
      <section aria-labelledby="availability-heading">
        <h2 id="availability-heading" className="mb-1 text-lg font-semibold">
          Availability
        </h2>
        <p className="mb-3 text-sm text-neutral-600">
          When someone can or can&apos;t work. A shift needs availability covering
          every minute, and with nothing entered they can&apos;t be scheduled. An end
          at or before the start runs past midnight, so 00:00 to 00:00 is all day.
        </p>

        {recurring.length === 0 ? (
          <p className="mb-3 text-neutral-600">No recurring availability yet.</p>
        ) : (
          <ul className="mb-4 grid gap-2">
            {recurring.map((record) => (
              <li
                key={record.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
              >
                <span>
                  {DAYS_OF_WEEK[record.dayOfWeek]}, {shortTime(record.startTime)} to{" "}
                  {shortTime(record.endTime)}: {humanize(record.availabilityType)}
                  <span className="block text-sm text-neutral-600">
                    From {record.effectiveFrom}
                    {record.effectiveTo ? ` to ${record.effectiveTo}` : ""}
                  </span>
                </span>
                <ActionButton
                  method="DELETE"
                  url={`${baseUrl}/availability/${record.id}`}
                  body={{ expectedVersion: record.version }}
                  label="Remove"
                  confirm={{ title: "Remove this availability?", confirmLabel: "Remove availability" }}
                />
              </li>
            ))}
          </ul>
        )}

        <h3 className="mb-2 font-medium">Add recurring availability</h3>
        <EntityForm
          method="POST"
          url={`${baseUrl}/availability`}
          submitLabel="Add availability"
          resetOnSuccess
          fields={[
            { name: "dayOfWeek", label: "Day", type: "select", required: true, options: DAY_OPTIONS },
            { name: "availabilityType", label: "Type", type: "select", required: true, options: optionsFrom(AVAILABILITY_TYPES) },
            { name: "startTime", label: "Start", type: "time", required: true },
            { name: "endTime", label: "End", type: "time", required: true },
            { name: "effectiveFrom", label: "Effective from", type: "date", required: true },
            { name: "effectiveTo", label: "Effective to", type: "date" },
          ]}
        />
      </section>

      <section aria-labelledby="exceptions-heading">
        <h2 id="exceptions-heading" className="mb-1 text-lg font-semibold">
          Exceptions for one date
        </h2>
        <p className="mb-3 text-sm text-neutral-600">
          These take precedence over recurring availability for the time they cover.
          Leave the times blank for the whole day.
        </p>

        {exceptions.length > 0 && (
          <ul className="mb-4 grid gap-2">
            {exceptions.map((record) => (
              <li
                key={record.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
              >
                <span>
                  {record.exceptionDate},{" "}
                  {record.startTime
                    ? `${shortTime(record.startTime)} to ${shortTime(record.endTime)}`
                    : "all day"}
                  : {humanize(record.availabilityType)}
                </span>
                <ActionButton
                  method="DELETE"
                  url={`${baseUrl}/availability-exceptions/${record.id}`}
                  body={{ expectedVersion: record.version }}
                  label="Remove"
                  confirm={{ title: "Remove this availability?", confirmLabel: "Remove availability" }}
                />
              </li>
            ))}
          </ul>
        )}

        <EntityForm
          method="POST"
          url={`${baseUrl}/availability-exceptions`}
          submitLabel="Add exception"
          resetOnSuccess
          fields={[
            { name: "exceptionDate", label: "Date", type: "date", required: true },
            { name: "availabilityType", label: "Type", type: "select", required: true, options: optionsFrom(AVAILABILITY_TYPES) },
            { name: "startTime", label: "Start", type: "time" },
            { name: "endTime", label: "End", type: "time" },
            { name: "reason", label: "Reason" },
          ]}
        />
      </section>

      <section aria-labelledby="preferences-heading">
        <h2 id="preferences-heading" className="mb-1 text-lg font-semibold">
          Preferences
        </h2>
        <p className="mb-3 text-sm text-neutral-600">
          What someone would rather work. These only influence automatic scheduling and
          warnings. They aren&apos;t guaranteed, and they never make anyone unavailable.
        </p>
        <EntityForm
          method="PUT"
          url={`${baseUrl}/preferences`}
          submitLabel="Save preferences"
          hidden={{ expectedVersion: preferences?.version ?? null }}
          fields={[
            { name: "targetHoursPerWeek", label: "Target hours per week", defaultValue: preferences?.targetHoursPerWeek },
            { name: "minimumHoursPerWeek", label: "Minimum hours per week", defaultValue: preferences?.minimumHoursPerWeek },
            { name: "maximumHoursPerWeek", label: "Maximum hours per week", defaultValue: preferences?.maximumHoursPerWeek },
            { name: "maximumDaysPerWeek", label: "Maximum days per week", type: "number", defaultValue: preferences?.maximumDaysPerWeek },
            { name: "maximumConsecutiveDays", label: "Maximum days in a row", type: "number", defaultValue: preferences?.maximumConsecutiveDays },
            { name: "preferredShiftStart", label: "Preferred start, from", type: "time", defaultValue: shortTime(preferences?.preferredShiftStart ?? null) },
            { name: "preferredShiftEnd", label: "Preferred start, until", type: "time", defaultValue: shortTime(preferences?.preferredShiftEnd ?? null) },
            { name: "preferWeekends", label: "Weekend shifts", type: "select", options: YES_NO_OPTIONS, defaultValue: flagOption(preferences?.preferWeekends ?? null) },
            { name: "preferOpening", label: "Opening shifts", type: "select", options: YES_NO_OPTIONS, defaultValue: flagOption(preferences?.preferOpening ?? null) },
            { name: "preferClosing", label: "Closing shifts", type: "select", options: YES_NO_OPTIONS, defaultValue: flagOption(preferences?.preferClosing ?? null) },
          ]}
        />
      </section>
    </div>
  );
}
