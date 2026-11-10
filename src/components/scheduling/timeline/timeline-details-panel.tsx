"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { humanize } from "@/components/employees/format";
import { AssignmentExplanation } from "@/components/scheduling/assignment-explanation";
import { HARD_CONSTRAINT_MESSAGES } from "@/modules/scheduling/rules/eligibility";
import { formatDuration } from "@/modules/scheduling/rules/timeline-layout";
import type {
  DayTimeline,
  TimelineBar,
  TimelinePosition,
} from "@/modules/scheduling/services/timeline-service";

import { clockTime, dateAndTime } from "./timeline-format";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1">
      <dt className="text-neutral-600">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Details of the selected bar. It shows only what the server sent, and the server sends
 * reviewer fields only to reviewers.
 */
export function TimelineDetailsPanel({
  bar,
  data,
  position,
  onClose,
}: {
  bar: TimelineBar;
  data: DayTimeline;
  position: TimelinePosition | undefined;
  onClose: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const employee = data.employees.find((row) => row.id === bar.employeeId);
  const reviewer = bar.reviewer;
  const title = bar.kind === "OPEN" ? "Open slot" : (employee?.displayName ?? "Unknown");

  useEffect(() => {
    closeButton.current?.focus();
  }, [bar.key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby="timeline-panel-title"
      data-testid="timeline-panel"
      className="fixed inset-x-0 bottom-0 z-40 max-h-[75vh] overflow-y-auto rounded-t-lg border border-neutral-300 bg-white p-4 shadow-lg sm:inset-x-auto sm:top-0 sm:right-0 sm:bottom-0 sm:max-h-none sm:w-96 sm:rounded-none"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <h2 id="timeline-panel-title" className="text-lg font-semibold">
            {title}
          </h2>
          <p className="text-sm text-neutral-600">{position?.name ?? "Position"}</p>
        </div>
        <button
          ref={closeButton}
          type="button"
          onClick={onClose}
          className="min-h-11 min-w-11 rounded-md border border-neutral-300 px-3 text-sm font-medium hover:bg-neutral-100"
        >
          Close
        </button>
      </div>

      <dl className="text-sm">
        <Field label="Position">{position?.name ?? "Position"}</Field>
        <Field label="Area">{bar.restaurantAreaName ?? "No specific area"}</Field>
        <Field label="Date">{bar.shiftDate}</Field>
        <Field label="Time">
          {clockTime(bar.startAt, data.timeZone)} to {clockTime(bar.endAt, data.timeZone)}
          {bar.endsNextDay && <span className="text-neutral-600"> (ends next day)</span>}
        </Field>
        <Field label="Duration">{formatDuration(bar.durationMinutes)}</Field>
        <Field label="Schedule">
          {bar.periodName} · <span data-testid="panel-period-status">{humanize(bar.periodStatus)}</span>
        </Field>
        <Field label="Staffing">
          {Math.min(bar.filledCount, bar.requiredCount)} of {bar.requiredCount} filled
        </Field>

        {reviewer && (
          <div data-testid="panel-reviewer">
            {bar.kind === "ASSIGNMENT" && (
              <>
                <Field label="Source">
                  {reviewer.assignmentSource ? humanize(reviewer.assignmentSource) : "Unknown"}
                </Field>
                {reviewer.assignedAt && (
                  <Field label="Assigned">{dateAndTime(reviewer.assignedAt, data.timeZone)}</Field>
                )}
                {reviewer.employeePeriodMinutes !== null && (
                  <Field label="Hours">
                    {formatDuration(employee?.scheduledMinutes ?? 0)} today ·{" "}
                    {formatDuration(reviewer.employeePeriodMinutes)} this schedule
                  </Field>
                )}
                {reviewer.openSwap && <Field label="Swap">A swap request is open</Field>}
              </>
            )}
            {reviewer.stationNote && <Field label="Station">{reviewer.stationNote}</Field>}
            {reviewer.notes && <Field label="Notes">{reviewer.notes}</Field>}
            {reviewer.openSlotSummary && (
              <Field label="Still open">{reviewer.openSlotSummary}</Field>
            )}
          </div>
        )}
      </dl>

      {reviewer && reviewer.violations.length > 0 && (
        <div
          className="mt-3 rounded border border-danger-300 bg-danger-50 p-2 text-sm text-danger-800"
          data-testid="panel-violations"
        >
          <p className="font-medium">Needs attention</p>
          <ul className="list-disc pl-5">
            {reviewer.violations.map((code) => (
              <li key={code}>{HARD_CONSTRAINT_MESSAGES[code]}</li>
            ))}
          </ul>
        </div>
      )}

      {reviewer?.rationale && <AssignmentExplanation rationale={reviewer.rationale} />}

      {reviewer && (
        <p className="mt-4">
          <Link href={`/scheduling/${bar.periodId}`} className="text-sm font-medium underline">
            Open this schedule
          </Link>
        </p>
      )}
    </aside>
  );
}
