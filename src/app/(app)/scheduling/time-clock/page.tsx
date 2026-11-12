import { randomUUID } from "node:crypto";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { AutoRefresh } from "@/components/timeclock/auto-refresh";
import { BreakEditor } from "@/components/timeclock/break-editor";
import { clockTime, hoursFrom, OVERTIME_LABEL, OVERTIME_TONE } from "@/components/timeclock/format";
import { ManagerClockInForm } from "@/components/timeclock/manager-clock-in-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getTimeClockBoard, type EntryView } from "@/modules/scheduling/services/timeclock-service";

type BoardEntry = EntryView & { employee: { number: string; name: string } | null };

function who(entry: BoardEntry): string {
  return entry.employee ? `${entry.employee.name} (${entry.employee.number})` : "Unknown";
}

/** Correct an entry: blank fields stay as they are; a reason is always required. */
function AdjustForm({ entry, positions }: { entry: BoardEntry; positions: { id: string; name: string }[] }) {
  return (
    <details>
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Adjust, edit breaks or void</summary>
      <div className="grid gap-4 md:grid-cols-2">
        <EntityForm
          key={`adjust-${entry.id}-${entry.version}`}
          method="PATCH"
          url={`/api/timeclock/entries/${entry.id}`}
          submitLabel="Save correction"
          successMessage="Time entry corrected."
          hidden={{ expectedVersion: entry.version }}
          fields={[
            { name: "clockInAt", label: "Clock-in (leave blank to keep)", type: "datetime-local" },
            { name: "clockOutAt", label: "Clock-out (leave blank to keep)", type: "datetime-local" },
            ...(positions.length > 1
              ? [
                  {
                    name: "positionId",
                    label: "Position",
                    type: "select" as const,
                    options: [{ value: "", label: "Keep current" }, ...positions.map((p) => ({ value: p.id, label: p.name }))],
                  },
                ]
              : []),
            { name: "reason", label: "Reason", required: true },
          ]}
        />
        <EntityForm
          key={`void-${entry.id}-${entry.version}`}
          method="POST"
          url={`/api/timeclock/entries/${entry.id}/void`}
          submitLabel="Void entry"
          successMessage="Time entry voided."
          hidden={{ expectedVersion: entry.version }}
          fields={[{ name: "reason", label: "Why void it?", required: true }]}
        />
        <div className="md:col-span-2">
          <BreakEditor key={`breaks-${entry.id}-${entry.version}`} entry={entry} />
        </div>
      </div>
    </details>
  );
}

export default async function TimeClockPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const { actor, location } = await requirePageActor("timeclock.view");
  const { date } = await searchParams;
  const board = await getTimeClockBoard(getDatabase(), actor, {
    businessDate: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
  });
  const positionsOf = (employeeId: string) => board.staff.find((member) => member.id === employeeId)?.positions ?? [];

  return (
    <>
      <AutoRefresh />
      <PageHeader
        title="Time clock"
        description={`Who is working at ${location.locationName}, missed clock-outs and each day's time entries. Business date ${board.today}.`}
      />

      <div className="grid gap-6">
        <Card aria-label="On the clock">
          <CardTitle>On the clock now ({board.onClock.length})</CardTitle>
          {board.onClock.length === 0 ? (
            <p className="text-sm text-neutral-700">Nobody is clocked in.</p>
          ) : (
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Employee</Th>
                    <Th>Position</Th>
                    <Th>Since</Th>
                    <Th numeric>Hours today</Th>
                    <Th numeric>Week</Th>
                    <Th>Overtime</Th>
                    {board.canManage && <Th>Action</Th>}
                  </Tr>
                </THead>
                <TBody>
                  {board.onClock.map((entry) => (
                    <Tr key={entry.id}>
                      <Td>
                        {who(entry)}
                        {entry.onBreak ? " · on break" : ""}
                        {entry.scheduled ? "" : " · unscheduled"}
                      </Td>
                      <Td>{entry.positionName}</Td>
                      <Td>{clockTime(entry.clockInAt, board.timeZone)}</Td>
                      <Td numeric>{hoursFrom(entry.workedSeconds)}</Td>
                      <Td numeric>{hoursFrom(entry.week.workedSeconds)}</Td>
                      <Td>
                        <Badge tone={OVERTIME_TONE[entry.week.state]}>{OVERTIME_LABEL[entry.week.state]}</Badge>
                      </Td>
                      {board.canManage && (
                        <Td>
                          <ActionButton
                            method="POST"
                            url="/api/timeclock/clock-out"
                            body={{ entryId: entry.id, expectedVersion: entry.version, idempotencyKey: `clockout-${randomUUID()}` }}
                            label="Clock out"
                            successMessage="Clocked out."
                            confirm={{ title: `Clock out ${who(entry)}?`, body: "This records the clock-out now.", confirmLabel: "Clock out" }}
                          />
                        </Td>
                      )}
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Card>

        {board.canManage && (
          <Card aria-label="Clock someone in">
            <CardTitle>Clock someone in</CardTitle>
            <p className="mb-3 text-sm text-neutral-700">For staff without a login, or when someone can&apos;t punch themselves. This is audited.</p>
            <ManagerClockInForm staff={board.staff} />
          </Card>
        )}

        {board.missedClockOuts.length > 0 && (
          <Card aria-label="Missed clock-outs">
            <CardTitle>
              Missed clock-outs <Badge tone="warning">{board.missedClockOuts.length}</Badge>
            </CardTitle>
            <p className="mb-3 text-sm text-neutral-700">
              These entries are still open from an earlier day and count no hours until closed. Enter the clock-out time and a reason.
            </p>
            <ul className="grid gap-4">
              {board.missedClockOuts.map((entry) => (
                <li key={entry.id} className="grid gap-2 border-t border-neutral-200 pt-3">
                  <p className="font-medium">
                    {who(entry)} · {entry.positionName} · in at {clockTime(entry.clockInAt, board.timeZone)} ({entry.businessDate})
                  </p>
                  {board.canManage && <AdjustForm entry={entry} positions={positionsOf(entry.employeeId)} />}
                </li>
              ))}
            </ul>
          </Card>
        )}

        <Card aria-label="Time entries">
          <CardTitle>Time entries for {board.businessDate}</CardTitle>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <label className="grid gap-1 text-sm">
              Business date
              <input type="date" name="date" defaultValue={board.businessDate} className="min-h-11 rounded border border-neutral-300 px-3" />
            </label>
            <button type="submit" className="min-h-11 rounded border border-neutral-300 px-4 text-sm font-medium">
              Show
            </button>
          </form>
          {board.entries.length === 0 ? (
            <p className="text-sm text-neutral-700">No time entries on this date.</p>
          ) : (
            <ul className="grid gap-4">
              {board.entries.map((entry) => (
                <li key={entry.id} className="grid gap-1 border-t border-neutral-200 pt-3" data-testid="time-entry">
                  <p className="font-medium">
                    {who(entry)} · {entry.positionName}{" "}
                    {entry.status === "OPEN" ? <Badge tone="info">Open</Badge> : null}{" "}
                    {entry.adjusted ? <Badge tone="warning">Adjusted</Badge> : null}{" "}
                    {entry.scheduled ? null : <Badge>Unscheduled</Badge>}
                  </p>
                  <p className="text-sm">
                    {clockTime(entry.clockInAt, board.timeZone)} to{" "}
                    {entry.clockOutAt ? clockTime(entry.clockOutAt, board.timeZone) : "now"} ·{" "}
                    <span className="tabular">{hoursFrom(entry.workedSeconds)} h</span>
                    {entry.breaks.length > 0 ? ` · ${entry.breaks.length} break(s)` : ""}
                  </p>
                  {board.canManage && <AdjustForm entry={entry} positions={positionsOf(entry.employeeId)} />}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
