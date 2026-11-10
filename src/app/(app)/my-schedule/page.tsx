import Link from "next/link";

import { humanize, optionsFrom } from "@/components/employees/format";
import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { AvailabilityPanel } from "@/components/scheduling/availability-panel";
import { shiftTimes } from "@/components/scheduling/format";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/scheduling/services/access";
import { getAvailability } from "@/modules/scheduling/services/availability-service";
import {
  getMySchedule,
  listColleagues,
} from "@/modules/scheduling/services/my-schedule-service";
import { listOwnSwaps } from "@/modules/scheduling/services/swap-service";
import { listOwnTimeOff } from "@/modules/scheduling/services/time-off-service";
import { TIME_OFF_TYPES } from "@/modules/scheduling/types";
import { localDateOf, localTimeOf } from "@/shared/time/zoned-time";
import { EmptyState } from "@/components/ui/empty-state";

export default async function MySchedulePage() {
  const { actor } = await requirePageActor("schedule.view");
  const database = getDatabase();
  const mine = await getMySchedule(database, actor);

  if (!mine.linked) {
    return (
      <>
        <h1 className="mb-4 text-2xl font-semibold">My schedule</h1>
        <p className="text-neutral-600">
          Your login isn&apos;t linked to an employee record, so there&apos;s no schedule
          to show. A manager can link it from the employee&apos;s page.
        </p>
      </>
    );
  }

  const { shifts, timeZone, employeeId } = mine;
  const canRequestTimeOff = actorHolds(actor, "schedule.time-off.request");
  const canRequestSwap = actorHolds(actor, "schedule.swap.request");
  const canEditAvailability = actorHolds(actor, "schedule.availability.self");
  const timeOff = canRequestTimeOff ? await listOwnTimeOff(database, actor) : [];
  const swaps = canRequestSwap ? (await listOwnSwaps(database, actor)).swaps : [];
  const colleagues = canRequestSwap
    ? (await listColleagues(database, actor)).filter((row) => row.id !== employeeId)
    : [];
  const availability = canEditAvailability
    ? await getAvailability(database, actor, { kind: "self" })
    : null;
  const now = new Date();
  const openSwapAssignments = new Set(
    swaps
      .filter((swap) => swap.status === "PENDING" || swap.status === "ACCEPTED")
      .map((swap) => swap.shiftAssignmentId),
  );
  const instant = (value: Date) =>
    `${localDateOf(value, timeZone)} ${localTimeOf(value, timeZone)}`;

  return (
    <>
      <h1 className="mb-4 text-2xl font-semibold">My schedule</h1>

      <section aria-labelledby="my-shifts-heading" className="mb-8">
        <h2 id="my-shifts-heading" className="mb-3 text-lg font-semibold">
          My shifts
        </h2>
        {shifts.length === 0 ? (
          <EmptyState title="No published shifts coming up." />
        ) : (
          <ul className="grid gap-3">
            {shifts.map((shift) => (
              <li
                key={shift.assignmentId}
                data-testid="my-shift"
                className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
              >
                <p className="font-medium">
                  {shift.shiftDate} · {shiftTimes(shift, timeZone)}
                </p>
                <p className="text-sm text-neutral-600">
                  {shift.positionName} · {shift.periodName}
                </p>
                {shift.locationId === actor.locationId && (
                  <p className="text-sm">
                    <Link
                      href={`/scheduling/timeline?date=${shift.shiftDate}`}
                      className="underline"
                    >
                      View day
                    </Link>
                  </p>
                )}

                {canRequestSwap &&
                  shift.locationId === actor.locationId &&
                  shift.startAt > now &&
                  !openSwapAssignments.has(shift.assignmentId) && (
                    <details className="mt-2 text-sm">
                      <summary className="cursor-pointer underline">
                        Request a swap
                      </summary>
                      <div className="mt-2">
                        <EntityForm
                          method="POST"
                          url="/api/scheduling/me/swaps"
                          submitLabel="Request swap"
                          hidden={{ assignmentId: shift.assignmentId }}
                          fields={[
                            {
                              name: "targetEmployeeId",
                              label: "Who could take it",
                              type: "select",
                              options: [
                                { value: "", label: "Not sure yet" },
                                ...colleagues.map((row) => ({
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
      </section>

      {canRequestSwap && swaps.length > 0 && (
        <section aria-labelledby="my-swaps-heading" className="mb-8">
          <h2 id="my-swaps-heading" className="mb-3 text-lg font-semibold">
            Shift swaps
          </h2>
          <ul className="grid gap-3">
            {swaps.map((swap) => (
              <li key={swap.id} className="rounded-lg border border-neutral-200 bg-surface shadow-sm p-3">
                <p className="font-medium">
                  {swap.shiftDate} · {swap.positionName} · {humanize(swap.status)}
                </p>
                <p className="text-sm text-neutral-600">
                  From {swap.requesterName} to {swap.targetName ?? "nobody yet"}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {swap.status === "PENDING" &&
                    swap.targetEmployeeId === employeeId && (
                      <ActionButton
                        method="POST"
                        url={`/api/scheduling/swaps/${swap.id}/accept`}
                        body={{ expectedVersion: swap.version }}
                        label="Accept"
                      />
                    )}
                  {(swap.status === "PENDING" || swap.status === "ACCEPTED") &&
                    swap.requestingEmployeeId === employeeId && (
                      <ActionButton
                        method="POST"
                        url={`/api/scheduling/swaps/${swap.id}/cancel`}
                        body={{ expectedVersion: swap.version }}
                        label="Withdraw"
                        confirm={{ title: "Withdraw this swap request?", confirmLabel: "Withdraw request" }}
                      />
                    )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {canRequestTimeOff && (
        <section aria-labelledby="my-time-off-heading" className="mb-8">
          <h2 id="my-time-off-heading" className="mb-3 text-lg font-semibold">
            Time off
          </h2>
          <div className="mb-4 rounded-lg border border-neutral-200 bg-surface shadow-sm p-4">
            <p className="mb-3 text-sm text-neutral-600">
              Leave the times blank for whole days.
            </p>
            <EntityForm
              method="POST"
              url="/api/scheduling/me/time-off"
              submitLabel="Request time off"
              resetOnSuccess
              fields={[
                { name: "requestType", label: "Type", type: "select", required: true, options: optionsFrom(TIME_OFF_TYPES) },
                { name: "startDate", label: "First day", type: "date", required: true },
                { name: "startTime", label: "Start time", type: "time" },
                { name: "endDate", label: "Last day", type: "date", required: true },
                { name: "endTime", label: "End time", type: "time" },
                { name: "reason", label: "Reason" },
                { name: "employeeNote", label: "Note" },
              ]}
            />
          </div>

          {timeOff.length > 0 && (
            <ul className="grid gap-2">
              {timeOff.map((request) => (
                <li
                  key={request.id}
                  data-testid="my-time-off"
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-surface shadow-sm p-3"
                >
                  <span>
                    {instant(request.startAt)} to {instant(request.endAt)}
                    <span className="block text-sm text-neutral-600">
                      {humanize(request.requestType)} · {humanize(request.status)}
                    </span>
                  </span>
                  {(request.status === "PENDING" ||
                    request.status === "APPROVED") && (
                    <ActionButton
                      method="POST"
                      url={`/api/scheduling/time-off/${request.id}/cancel`}
                      body={{ expectedVersion: request.version }}
                      label="Cancel"
                      confirm={{ title: "Cancel this time-off request?", confirmLabel: "Cancel request" }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {availability && (
        <AvailabilityPanel data={availability} baseUrl="/api/scheduling/me" />
      )}
    </>
  );
}
