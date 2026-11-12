import { ActionButton } from "@/components/forms/action-button";
import { Card, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { hasPermission } from "@/modules/auth/services/permission-service";
import { getSystemHealth } from "@/modules/auth/services/system-health-service";
import { listLocationsWithSettings } from "@/modules/organization/services/organization-service";

function formatAge(seconds: number | null): string {
  if (seconds === null) {
    return "None waiting";
  }

  if (seconds < 120) {
    return `${seconds} s`;
  }

  return seconds < 7200 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h`;
}

function formatTime(value: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, dateStyle: "medium", timeStyle: "short" }).format(value);
}

/** Admin → System health (Phase 16). Counts and dead-lettered events; never a payload. */
export default async function SystemHealthPage() {
  const { auth, location, actor } = await requirePageActor("admin.system.view");
  const database = getDatabase();
  const [health, [locationRow]] = await Promise.all([
    getSystemHealth(database, actor),
    listLocationsWithSettings(database, [location.locationId]),
  ]);
  const timeZone = locationRow?.location.timezone ?? "UTC";
  const canRetry = hasPermission(auth, "admin.system.manage", location.locationId);

  return (
    <>
      <PageHeader
        title="System health"
        description="Realtime event delivery and guest message sending for this organization. An event only tells screens to refresh, so a stuck event never blocks later ones."
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-neutral-700">Waiting to publish</p>
          <p className="tabular text-2xl font-semibold" data-testid="outbox-unpublished">{health.unpublishedCount}</p>
        </Card>
        <Card>
          <p className="text-sm text-neutral-700">Oldest waiting</p>
          <p className="text-2xl font-semibold" data-testid="outbox-oldest">{formatAge(health.oldestUnpublishedAgeSeconds)}</p>
        </Card>
        <Card>
          <p className="text-sm text-neutral-700">Dead-lettered</p>
          <p className="tabular text-2xl font-semibold" data-testid="outbox-dead">{health.deadLetteredCount}</p>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-sm text-neutral-700">Guest messages waiting to send</p>
          <p className="tabular text-2xl font-semibold" data-testid="messages-queued">{health.guestMessages.queuedCount}</p>
        </Card>
        <Card>
          <p className="text-sm text-neutral-700">Guest messages failed</p>
          <p className="tabular text-2xl font-semibold" data-testid="messages-failed">{health.guestMessages.failedCount}</p>
        </Card>
      </div>

      <Card>
        <CardTitle>Dead-lettered events</CardTitle>
        {health.deadLettered.length === 0 ? (
          <EmptyState title="No dead-lettered events">Every event was delivered or is still being retried.</EmptyState>
        ) : (
          <TableFrame>
            <Table>
              <THead>
                <Tr>
                  <Th>Event</Th>
                  <Th>Aggregate</Th>
                  <Th numeric>Attempts</Th>
                  <Th>Last error</Th>
                  <Th>Occurred</Th>
                  <Th>Failed</Th>
                  {canRetry && <Th>Action</Th>}
                </Tr>
              </THead>
              <TBody>
                {health.deadLettered.map((event) => (
                  <Tr key={event.id}>
                    <Td className="font-mono">{event.eventType}</Td>
                    <Td>
                      {event.aggregateType} <span className="font-mono text-xs break-all">{event.aggregateId}</span>
                    </Td>
                    <Td numeric>{event.attempts}</Td>
                    <Td>{event.lastError ?? "—"}</Td>
                    <Td className="whitespace-nowrap">{formatTime(event.occurredAt, timeZone)}</Td>
                    <Td className="whitespace-nowrap">{formatTime(event.failedAt, timeZone)}</Td>
                    {canRetry && (
                      <Td>
                        <ActionButton
                          method="POST"
                          url={`/api/admin/system/outbox/${event.id}/retry`}
                          label="Retry"
                          successMessage="Requeued."
                        />
                      </Td>
                    )}
                  </Tr>
                ))}
              </TBody>
            </Table>
          </TableFrame>
        )}
        {health.deadLetteredCount > health.deadLettered.length && (
          <p className="mt-2 text-sm text-neutral-700">Showing the {health.deadLettered.length} most recent.</p>
        )}
      </Card>
    </>
  );
}
