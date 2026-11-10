import { humanize } from "@/components/employees/format";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { getDatabase } from "@/db";
import { requirePageActorWithAny } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/scheduling/services/access";
import { listColleagues } from "@/modules/scheduling/services/my-schedule-service";
import { loadLocationContext } from "@/modules/scheduling/services/scheduling-input";
import { listSwapsForReview } from "@/modules/scheduling/services/swap-service";
import { listTimeOffForReview } from "@/modules/scheduling/services/time-off-service";
import { localDateOf, localTimeOf } from "@/shared/time/zoned-time";
import { EmptyState } from "@/components/ui/empty-state";

export default async function SchedulingRequestsPage() {
  const { actor } = await requirePageActorWithAny([
    "schedule.time-off.approve",
    "schedule.swap.approve",
  ]);
  const database = getDatabase();
  const { timeZone } = await loadLocationContext(database, actor);
  const canReviewTimeOff = actorHolds(actor, "schedule.time-off.approve");
  const canReviewSwaps = actorHolds(actor, "schedule.swap.approve");
  const timeOff = canReviewTimeOff
    ? await listTimeOffForReview(database, actor)
    : [];
  const swaps = canReviewSwaps ? await listSwapsForReview(database, actor) : [];
  const colleagues = canReviewSwaps ? await listColleagues(database, actor) : [];
  const instant = (value: Date) =>
    `${localDateOf(value, timeZone)} ${localTimeOf(value, timeZone)}`;

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">Scheduling requests</h1>

      {canReviewTimeOff && (
        <section className="mb-8">
          <h2 className="mb-3 text-lg font-semibold">Time off</h2>
          {timeOff.length === 0 ? (
            <EmptyState title="No time-off requests." />
          ) : (
            <ul className="grid gap-3">
              {timeOff.map((request) => (
                <li
                  key={request.id}
                  data-testid="time-off-request"
                  className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
                >
                  <p className="font-medium">
                    {request.employeeName}: {humanize(request.requestType)} ·{" "}
                    {humanize(request.status)}
                  </p>
                  <p className="text-sm text-neutral-600">
                    {instant(request.startAt)} to {instant(request.endAt)}
                  </p>
                  {request.reason && (
                    <p className="text-sm">Reason: {request.reason}</p>
                  )}

                  {request.conflicts.length > 0 && (
                    <div className="mt-2 rounded border border-amber-300 bg-warning-50 p-2 text-sm text-warning-900">
                      <p className="font-medium">
                        Can&apos;t be approved until these are resolved:
                      </p>
                      <ul className="grid gap-1">
                        {request.conflicts.map((conflict) => (
                          <li key={conflict.assignmentId}>
                            {conflict.shiftDate}, {conflict.positionName},{" "}
                            {conflict.periodName} ({humanize(conflict.periodStatus)})
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {request.status === "PENDING" && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <ActionButton
                        method="POST"
                        url={`/api/scheduling/time-off/${request.id}/approve`}
                        body={{ managerNote: null, expectedVersion: request.version }}
                        label="Approve"
                      />
                      <ActionButton
                        method="POST"
                        url={`/api/scheduling/time-off/${request.id}/deny`}
                        body={{ managerNote: null, expectedVersion: request.version }}
                        label="Deny"
                        confirm={{ title: "Deny this time-off request?", confirmLabel: "Deny request" }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {canReviewSwaps && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Shift swaps</h2>
          {swaps.length === 0 ? (
            <EmptyState title="No swap requests." />
          ) : (
            <ul className="grid gap-3">
              {swaps.map((swap) => (
                <li
                  key={swap.id}
                  data-testid="swap-request"
                  className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
                >
                  <p className="font-medium">
                    {swap.shiftDate} · {swap.positionName} · {humanize(swap.status)}
                  </p>
                  <p className="text-sm text-neutral-600">
                    From {swap.requesterName} to {swap.targetName ?? "nobody yet"}
                  </p>
                  {swap.reason && <p className="text-sm">Reason: {swap.reason}</p>}

                  {swap.status === "PENDING" && (
                    <div className="mt-2">
                      <EntityForm
                        method="PUT"
                        url={`/api/scheduling/swaps/${swap.id}/target`}
                        submitLabel="Set who takes it"
                        hidden={{ expectedVersion: swap.version }}
                        fields={[
                          {
                            name: "targetEmployeeId",
                            label: "Give to",
                            type: "select",
                            required: true,
                            defaultValue: swap.targetEmployeeId,
                            options: colleagues
                              .filter((row) => row.id !== swap.requestingEmployeeId)
                              .map((row) => ({
                                value: row.id,
                                label: row.displayName,
                              })),
                          },
                        ]}
                      />
                    </div>
                  )}

                  {(swap.status === "PENDING" || swap.status === "ACCEPTED") && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {swap.status === "PENDING" && swap.targetEmployeeId && (
                        <ActionButton
                          method="POST"
                          url={`/api/scheduling/swaps/${swap.id}/record-acceptance`}
                          body={{ expectedVersion: swap.version }}
                          label="Record acceptance"
                        />
                      )}
                      {swap.status === "ACCEPTED" && (
                        <ActionButton
                          method="POST"
                          url={`/api/scheduling/swaps/${swap.id}/approve`}
                          body={{ expectedVersion: swap.version }}
                          label="Approve swap"
                        />
                      )}
                      <ActionButton
                        method="POST"
                        url={`/api/scheduling/swaps/${swap.id}/deny`}
                        body={{ expectedVersion: swap.version }}
                        label="Deny swap"
                        confirm={{ title: "Deny this swap?" }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}
