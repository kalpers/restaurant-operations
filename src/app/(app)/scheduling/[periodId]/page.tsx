import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { humanize } from "@/components/employees/format";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { AssignmentExplanation } from "@/components/scheduling/assignment-explanation";
import { shiftTimes } from "@/components/scheduling/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import type { Actor } from "@/modules/auth/types";
import { actorHolds, canReviewSchedules } from "@/modules/scheduling/services/access";
import {
  getShiftFormOptions,
  listTemplates,
} from "@/modules/scheduling/services/config-service";
import { getPeriodCoverage } from "@/modules/scheduling/services/coverage-service";
import { listGenerationRuns } from "@/modules/scheduling/services/generation-service";
import { listColleagues } from "@/modules/scheduling/services/my-schedule-service";
import {
  getPeriodDetail,
  listCandidates,
} from "@/modules/scheduling/services/schedule-service";
import type { AssignmentRationale, UnfilledShiftDetail } from "@/modules/scheduling/rules/explanation-builder";
import { HARD_CONSTRAINT_MESSAGES } from "@/modules/scheduling/rules/eligibility";
import { NotFoundError } from "@/shared/errors/app-error";

import { CoverageSection, type CoverageData } from "./coverage-section";
import { ForecastSection, type ForecastData } from "./forecast-section";
import { getPeriodForecast } from "@/modules/scheduling/services/forecast-service";
import { Breadcrumbs } from "@/components/ui/page-header";
import { StatusBadge } from "@/components/format/status-badge";
import { EmptyState } from "@/components/ui/empty-state";

type Detail = Awaited<ReturnType<typeof getPeriodDetail>>;
type ShiftView = Detail["shifts"][number];

async function AssignControls({
  actor,
  shift,
  periodVersion,
}: {
  actor: Actor;
  shift: ShiftView;
  periodVersion: number;
}) {
  const candidates = await listCandidates(getDatabase(), actor, shift.id);
  const onShift = new Set(shift.assignments.map((row) => row.employeeId));
  const available = candidates.filter((row) => !onShift.has(row.employeeId));
  const eligible = available.filter((row) => row.eligible);
  const ineligible = available.filter((row) => !row.eligible);

  return (
    <div className="mt-3 grid gap-2">
      {eligible.length > 0 && (
        <EntityForm
          method="POST"
          url={`/api/scheduling/shifts/${shift.id}/assignments`}
          submitLabel="Assign"
          hidden={{ expectedPeriodVersion: periodVersion }}
          fields={[
            {
              name: "employeeId",
              label: "Employee",
              type: "select",
              required: true,
              options: eligible.map((row) => ({
                value: row.employeeId,
                label: row.warnings.length
                  ? `${row.displayName} (${row.warnings.length} warning${row.warnings.length > 1 ? "s" : ""})`
                  : row.displayName,
              })),
            },
          ]}
        />
      )}
      {ineligible.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer underline">
            {ineligible.length} not eligible
          </summary>
          <ul className="mt-1 grid gap-1 pl-2">
            {ineligible.map((row) => (
              <li key={row.employeeId}>
                {row.displayName}:{" "}
                {row.violations
                  .map((code) => HARD_CONSTRAINT_MESSAGES[code])
                  .join(" ")}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export default async function PeriodPage({
  params,
}: {
  params: Promise<{ periodId: string }>;
}) {
  const { actor } = await requirePageActor("schedule.view");
  const parsed = z.uuid().safeParse((await params).periodId);

  if (!parsed.success) {
    notFound();
  }

  const database = getDatabase();
  const periodId = parsed.data;
  const detail = await getPeriodDetail(database, actor, periodId).catch(
    (error: unknown) => {
      if (error instanceof NotFoundError) {
        notFound();
      }

      throw error;
    },
  );
  const { period, shifts, timeZone } = detail;
  const isDraft = period.status === "DRAFT";
  const canEdit = isDraft && actorHolds(actor, "schedule.edit");
  const canGenerate = isDraft && actorHolds(actor, "schedule.generate");
  const canPublish = isDraft && actorHolds(actor, "schedule.publish");
  const canArchive =
    period.status === "PUBLISHED" && actorHolds(actor, "schedule.publish");
  const canReview = canReviewSchedules(actor);
  const canSwap =
    period.status === "PUBLISHED" && actorHolds(actor, "schedule.swap.approve");
  const coverage: CoverageData | null = canReview
    ? await getPeriodCoverage(database, actor, periodId)
    : null;
  // Phase 24 (policy 10): schedule editors see the forecast; only a draft can use it.
  const forecast: ForecastData | null = actorHolds(actor, "schedule.edit")
    ? await getPeriodForecast(database, actor, periodId)
    : null;
  const runs = canReview
    ? await listGenerationRuns(database, actor, periodId)
    : [];
  const latestCompleted = runs.find((run) => run.status === "COMPLETED");
  const unfilled = new Map(
    ((latestCompleted?.unfilledDetails ?? []) as UnfilledShiftDetail[]).map(
      (row) => [row.shiftId, row],
    ),
  );
  const options = canEdit ? await getShiftFormOptions(database, actor) : null;
  const templates = canEdit
    ? (await listTemplates(database, actor)).filter((row) => row.active)
    : [];
  const colleagues = canSwap ? await listColleagues(database, actor) : [];
  const positionOptions =
    options?.positions.map((row) => ({ value: row.id, label: row.name })) ?? [];
  const areaOptions = [
    { value: "", label: "No specific area" },
    ...(options?.areas.map((row) => ({ value: row.id, label: row.name })) ?? []),
  ];

  return (
    <>
      <Breadcrumbs items={[{ label: "Scheduling", href: "/scheduling" }, { label: period.name }]} />
      <h1 className="mb-1 text-2xl font-semibold">{period.name}</h1>
      <p className="mb-4 text-neutral-600">
        {period.startDate} to {period.endDate} ·{" "}
        <StatusBadge domain="schedulePeriod" status={period.status} data-testid="period-status" />
      </p>

      {(canGenerate || canPublish || canArchive) && (
        <div className="mb-6 flex flex-wrap items-center gap-3">
          {canGenerate && (
            <>
              <ActionButton
                method="POST"
                url={`/api/scheduling/periods/${period.id}/generate`}
                body={{ mode: "GENERATE_DRAFT", expectedVersion: period.version }}
                label="Generate Draft"
              />
              <ActionButton
                method="POST"
                url={`/api/scheduling/periods/${period.id}/generate`}
                body={{ mode: "FILL_OPEN_SHIFTS", expectedVersion: period.version }}
                label="Fill Open Shifts"
              />
            </>
          )}
          {canPublish && (
            <ActionButton
              method="POST"
              url={`/api/scheduling/periods/${period.id}/publish`}
              body={{ expectedVersion: period.version }}
              label="Publish"
              confirm={{ title: "Publish this schedule?", body: "Staff can see it right away. After publishing, assignments change only through shift swaps.", tone: "primary" }}
            />
          )}
          {canArchive && (
            <ActionButton
              method="POST"
              url={`/api/scheduling/periods/${period.id}/archive`}
              body={{ expectedVersion: period.version }}
              label="Archive"
              confirm={{ title: "Archive this schedule period?", body: "It becomes read-only history.", confirmLabel: "Archive period" }}
            />
          )}
        </div>
      )}

      {coverage && <CoverageSection coverage={coverage} />}

      {forecast && <ForecastSection forecast={forecast} canApply={canEdit} />}

      {canEdit && options && (
        <section className="mb-8 grid gap-6 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
          <div>
            <h2 className="mb-3 font-semibold">Add a shift</h2>
            <EntityForm
              method="POST"
              url={`/api/scheduling/periods/${period.id}/shifts`}
              submitLabel="Add shift"
              hidden={{ expectedPeriodVersion: period.version }}
              fields={[
                { name: "positionId", label: "Position", type: "select", required: true, options: positionOptions },
                { name: "restaurantAreaId", label: "Area", type: "select", options: areaOptions },
                { name: "shiftDate", label: "Date", type: "date", required: true },
                { name: "startTime", label: "Start", type: "time", required: true },
                { name: "endTime", label: "End", type: "time", required: true },
                { name: "requiredEmployeeCount", label: "People needed", type: "number", required: true, defaultValue: 1 },
              ]}
            />
          </div>
          {templates.length > 0 && (
            <div>
              <h2 className="mb-3 font-semibold">Apply a staffing template</h2>
              <p className="mb-3 text-sm text-neutral-600">
                Adds shifts for the template&apos;s requirements, never assignments.
                Applying again adds only what&apos;s missing, and leaves shifts you edited
                or cancelled as they are.
              </p>
              <EntityForm
                method="POST"
                url={`/api/scheduling/periods/${period.id}/apply-template`}
                submitLabel="Apply template"
                hidden={{ expectedPeriodVersion: period.version }}
                fields={[
                  {
                    name: "templateId",
                    label: "Template",
                    type: "select",
                    required: true,
                    options: templates.map((row) => ({
                      value: row.id,
                      label: row.name,
                    })),
                  },
                  {
                    name: "useForecast",
                    label: "Size new shifts from the demand forecast",
                    type: "checkbox",
                    defaultValue: false,
                  },
                ]}
              />
            </div>
          )}
        </section>
      )}

      <h2 className="mb-3 text-lg font-semibold">Shifts</h2>
      {shifts.length === 0 ? (
        <EmptyState title="No shifts yet." />
      ) : (
        <ul className="grid gap-3">
          {shifts.map((shift) => {
            const open = shift.requiredEmployeeCount - shift.assignments.length;
            const reason = open > 0 ? unfilled.get(shift.id) : undefined;

            return (
              <li
                key={shift.id}
                data-testid="shift"
                className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="font-medium">
                    <Link
                      href={`/scheduling/timeline?date=${shift.shiftDate}`}
                      className="underline"
                      aria-label={`View ${shift.shiftDate} on the timeline`}
                    >
                      {shift.shiftDate}
                    </Link>{" "}
                    · {shiftTimes(shift, timeZone)} ·{" "}
                    {shift.positionName}
                    {shift.restaurantAreaName
                      ? ` · ${shift.restaurantAreaName}`
                      : ""}
                  </p>
                  <p
                    className={
                      open > 0 ? "text-sm font-medium text-warning-800" : "text-sm text-neutral-600"
                    }
                  >
                    {open > 0
                      ? `${open} open of ${shift.requiredEmployeeCount}`
                      : `Filled (${shift.requiredEmployeeCount})`}
                  </p>
                </div>

                {reason && (
                  <p className="mt-1 text-sm text-warning-800">
                    Still open: {reason.summary}
                  </p>
                )}

                {shift.assignments.length > 0 && (
                  <ul className="mt-2 grid gap-2">
                    {shift.assignments.map((assignment) => (
                      <li key={assignment.id} data-testid="assignment">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{assignment.employeeName}</span>
                          <span className="text-sm text-neutral-600">
                            {humanize(assignment.assignmentSource)}
                          </span>
                          {canEdit && (
                            <ActionButton
                              method="DELETE"
                              url={`/api/scheduling/assignments/${assignment.id}`}
                              body={{ expectedPeriodVersion: period.version }}
                              label="Remove"
                              confirm={{ title: "Remove this assignment?", body: "The slot becomes open.", confirmLabel: "Remove assignment" }}
                            />
                          )}
                        </span>
                        {assignment.rationale ? (
                          <AssignmentExplanation
                            rationale={assignment.rationale as AssignmentRationale}
                          />
                        ) : null}
                        {canSwap && (
                          <details className="mt-1 text-sm">
                            <summary className="cursor-pointer underline">
                              Move to someone else
                            </summary>
                            <div className="mt-2">
                              <EntityForm
                                method="POST"
                                url="/api/scheduling/swaps"
                                submitLabel="Open swap"
                                hidden={{ assignmentId: assignment.id }}
                                fields={[
                                  {
                                    name: "targetEmployeeId",
                                    label: "Give to",
                                    type: "select",
                                    options: [
                                      { value: "", label: "Decide later" },
                                      ...colleagues
                                        .filter((row) => row.id !== assignment.employeeId)
                                        .map((row) => ({
                                          value: row.id,
                                          label: row.displayName,
                                        })),
                                    ],
                                  },
                                  { name: "reason", label: "Reason" },
                                ]}
                              />
                            </div>
                          </details>
                        )}
                      </li>
                    ))}
                  </ul>
                )}

                {canEdit && open > 0 && (
                  <AssignControls
                    actor={actor}
                    shift={shift}
                    periodVersion={period.version}
                  />
                )}

                {canEdit && shift.assignments.length === 0 && (
                  <div className="mt-2">
                    <ActionButton
                      method="DELETE"
                      url={`/api/scheduling/shifts/${shift.id}`}
                      body={{
                        expectedVersion: shift.version,
                        expectedPeriodVersion: period.version,
                      }}
                      label="Cancel shift"
                      confirm={{ title: "Cancel this shift?", body: "Its assignments are removed.", cancelLabel: "Keep shift" }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {runs.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-lg font-semibold">Generation history</h2>
          <ul className="grid gap-1 text-sm">
            {runs.map((run) => (
              <li key={run.id}>
                {run.startedAt.toISOString().slice(0, 16).replace("T", " ")} UTC ·{" "}
                {humanize(run.generationMode)} · {humanize(run.status)}
                {run.status === "COMPLETED"
                  ? ` · ${run.createdAssignmentCount} assigned, ${run.unfilledShiftCount} shifts left open, ${run.warningCount} warnings`
                  : ""}
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
