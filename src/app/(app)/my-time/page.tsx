import { randomUUID } from "node:crypto";

import { ActionButton } from "@/components/forms/action-button";
import { EntityForm } from "@/components/forms/entity-form";
import { formatMoney } from "@/components/format/money";
import { clockTime, hoursFrom, OVERTIME_LABEL, OVERTIME_TONE } from "@/components/timeclock/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getMyTime } from "@/modules/scheduling/services/timeclock-service";
import { getMyTipShares } from "@/modules/settlements/services/tip-service";
import { addDays } from "@/shared/time/zoned-time";

/**
 * The signed-in employee's own time clock (Phase 18). Each punch carries an idempotency key
 * generated for this render, so resubmitting after a lost response reuses it; the refresh
 * after success brings a new one.
 */
export default async function MyTimePage() {
  const { actor } = await requirePageActor("timeclock.punch");
  const database = getDatabase();
  const mine = await getMyTime(database, actor);

  if (!mine.linked) {
    return (
      <>
        <PageHeader title="My time" />
        <EmptyState title="No employee record">
          Your login isn&apos;t linked to an employee record, so you can&apos;t clock in. A manager can link it from the
          employee&apos;s page, or clock you in from the time clock.
        </EmptyState>
      </>
    );
  }

  const { openEntry, week, timeZone, positions } = mine;
  const shares = await getMyTipShares(database, actor, { from: addDays(mine.businessDate, -30), to: mine.businessDate });
  const onBreak = openEntry?.breaks.some((span) => span.endedAt === null) ?? false;

  return (
    <>
      <PageHeader
        title="My time"
        description={`Business date ${mine.businessDate}. Week of ${week.weekStart}: ${hoursFrom(week.workedSeconds)} of ${hoursFrom(week.thresholdSeconds)} hours before overtime.`}
      />

      <div className="grid gap-6">
        <Card aria-label="Time clock">
          <CardTitle>
            {openEntry ? "On the clock" : "Off the clock"}{" "}
            <Badge tone={OVERTIME_TONE[week.state]}>{OVERTIME_LABEL[week.state]}</Badge>
          </CardTitle>
          {mine.openElsewhere ? (
            <p className="text-sm">You&apos;re on the clock at another location. Clock out there first.</p>
          ) : openEntry ? (
            <div className="grid gap-3">
              <p className="text-sm">
                Clocked in at {clockTime(openEntry.clockInAt, timeZone)} as {openEntry.positionName}
                {openEntry.scheduled ? "" : " (not on the schedule)"}. Worked so far:{" "}
                <span className="tabular font-semibold">{hoursFrom(openEntry.workedSeconds)} h</span>
                {onBreak ? " · on a break" : ""}
              </p>
              <div className="flex flex-wrap gap-3">
                {onBreak ? (
                  <ActionButton
                    method="POST"
                    url="/api/timeclock/breaks"
                    body={{ action: "END", idempotencyKey: `break-${randomUUID()}` }}
                    label="End break"
                    successMessage="Break ended."
                  />
                ) : (
                  <ActionButton
                    method="POST"
                    url="/api/timeclock/breaks"
                    body={{ action: "START", paid: false, idempotencyKey: `break-${randomUUID()}` }}
                    label="Start unpaid break"
                    successMessage="Break started."
                  />
                )}
                <ActionButton
                  method="POST"
                  url="/api/timeclock/clock-out"
                  body={{ idempotencyKey: `clockout-${randomUUID()}` }}
                  label="Clock out"
                  variant="primary"
                  successMessage="Clocked out."
                />
              </div>
            </div>
          ) : positions.length === 0 ? (
            <p className="text-sm">You don&apos;t hold a position at this location, so you can&apos;t clock in here.</p>
          ) : (
            <EntityForm
              key={`clock-in-${week.entries.length}`}
              method="POST"
              url="/api/timeclock/clock-in"
              submitLabel="Clock in"
              successMessage="Clocked in."
              hidden={{
                idempotencyKey: `clockin-${randomUUID()}`,
                ...(positions.length === 1 ? { positionId: positions[0]!.id } : {}),
              }}
              fields={
                positions.length > 1
                  ? [
                      {
                        name: "positionId",
                        label: "Position",
                        type: "select",
                        required: true,
                        options: positions.map((position) => ({ value: position.id, label: position.name })),
                      },
                    ]
                  : []
              }
            />
          )}
        </Card>

        <Card aria-label="This week">
          <CardTitle>This week</CardTitle>
          {week.entries.length === 0 ? (
            <p className="text-sm text-neutral-700">No time recorded this week.</p>
          ) : (
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Business date</Th>
                    <Th>Position</Th>
                    <Th>In</Th>
                    <Th>Out</Th>
                    <Th numeric>Hours</Th>
                  </Tr>
                </THead>
                <TBody>
                  {week.entries.map((entry) => (
                    <Tr key={entry.id}>
                      <Td>{entry.businessDate}</Td>
                      <Td>
                        {entry.positionName}
                        {entry.adjusted ? " (adjusted)" : ""}
                      </Td>
                      <Td>{clockTime(entry.clockInAt, timeZone)}</Td>
                      <Td>{entry.clockOutAt ? clockTime(entry.clockOutAt, timeZone) : "Open"}</Td>
                      <Td numeric>{hoursFrom(entry.workedSeconds)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
        </Card>

        <Card aria-label="My tips">
          <CardTitle>My tips (last 30 days)</CardTitle>
          {shares.length === 0 ? (
            <p className="text-sm text-neutral-700">No finalized tip shares yet.</p>
          ) : (
            <TableFrame>
              <Table>
                <THead>
                  <Tr>
                    <Th>Business date</Th>
                    <Th>Position</Th>
                    <Th numeric>Hours</Th>
                    <Th numeric>Share</Th>
                  </Tr>
                </THead>
                <TBody>
                  {shares.map((share) => (
                    <Tr key={`${share.businessDate}-${share.positionCode}`}>
                      <Td>{share.businessDate}</Td>
                      <Td>{share.positionCode}</Td>
                      <Td numeric>{share.workedHours}</Td>
                      <Td numeric>{formatMoney(share.share)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            </TableFrame>
          )}
          <p className="mt-3 text-xs text-neutral-600">Record only: tips are paid out outside this system.</p>
        </Card>
      </div>
    </>
  );
}
