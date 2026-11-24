import Link from "next/link";

import { describeEventSpace, EventStatusBadge } from "@/components/reservations/event-status-badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/page-header";
import { Table, TableFrame, TBody, Td, Th, THead, Tr } from "@/components/ui/table";
import { getDatabase } from "@/db";
import { EVENT_STATUSES } from "@/db/schema/events";
import { requirePageActor } from "@/modules/auth/guards";
import { listEvents } from "@/modules/reservations/services/event-service";
import { eventListQuerySchema } from "@/modules/reservations/validators/event-validators";
import { actorHolds, readLocationClock } from "@/modules/restaurant/services/access";
import { AppError } from "@/shared/errors/app-error";
import { addDays } from "@/shared/time/zoned-time";

type SearchParams = Record<string, string | string[] | undefined>;

/** Phase 36 (policy 7): events and private dining, by date. */
export default async function EventsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const { actor } = await requirePageActor("events.view");
  const database = getDatabase();
  const clock = await readLocationClock(database, actor.locationId, new Date());
  const raw = await searchParams;
  const pick = (name: string) => (typeof raw[name] === "string" && raw[name] !== "" ? (raw[name] as string) : undefined);
  const parsed = eventListQuerySchema.safeParse({
    from: pick("from") ?? clock.businessDate,
    to: pick("to") ?? addDays(clock.businessDate, 60),
    status: pick("status"),
  });
  let problem: string | null = parsed.success ? null : "Choose valid dates.";
  let events: Awaited<ReturnType<typeof listEvents>> = [];

  if (parsed.success) {
    try {
      events = await listEvents(database, actor, parsed.data);
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      problem = error.message;
    }
  }

  const time = (iso: string) =>
    new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: clock.timeZone }).format(new Date(iso));

  return (
    <>
      <PageHeader
        title="Events"
        description="Private dining and buyouts. A tentative or confirmed event holds its space against reservations, the waitlist and walk-ins."
        actions={
          actorHolds(actor, "events.manage") ? (
            <ButtonLink href="/events/new" variant="primary">
              Book an event
            </ButtonLink>
          ) : undefined
        }
      />
      <form method="get" aria-label="Choose dates" className="mb-6 flex flex-wrap items-end gap-3">
        <Field label="From">
          <Input type="date" name="from" defaultValue={parsed.success ? parsed.data.from : clock.businessDate} />
        </Field>
        <Field label="To">
          <Input type="date" name="to" defaultValue={parsed.success ? parsed.data.to : addDays(clock.businessDate, 60)} />
        </Field>
        <Field label="Status">
          <Select name="status" defaultValue={parsed.success ? (parsed.data.status ?? "") : ""}>
            <option value="">All</option>
            {EVENT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status.charAt(0) + status.slice(1).toLowerCase()}
              </option>
            ))}
          </Select>
        </Field>
        <Button type="submit" variant="secondary">
          Show
        </Button>
      </form>
      {problem && (
        <p role="alert" className="mb-4 rounded border border-danger-300 bg-danger-50 p-3 text-danger-800">
          {problem}
        </p>
      )}
      {events.length === 0 ? (
        <EmptyState title="No events">No events for these dates.</EmptyState>
      ) : (
        <TableFrame>
          <Table>
            <THead>
              <Tr>
                <Th>Date</Th>
                <Th>Time</Th>
                <Th>Event</Th>
                <Th numeric>Guests</Th>
                <Th>Space</Th>
                <Th>Status</Th>
              </Tr>
            </THead>
            <TBody>
              {events.map((event) => (
                <Tr key={event.id} data-testid="event-row">
                  <Td>{event.localDate}</Td>
                  <Td>
                    {time(event.startsAt)}–{time(event.endsAt)}
                  </Td>
                  <Td>
                    <Link href={`/events/${event.id}`} className="font-medium underline">
                      {event.eventNumber} {event.name}
                    </Link>
                  </Td>
                  <Td numeric>{event.partySize}</Td>
                  <Td>{describeEventSpace(event)}</Td>
                  <Td>
                    <EventStatusBadge status={event.status} />
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </TableFrame>
      )}
    </>
  );
}
