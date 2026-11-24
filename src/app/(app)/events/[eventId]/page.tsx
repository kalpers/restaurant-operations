import { notFound } from "next/navigation";
import { z } from "zod";

import { EventActions } from "@/components/reservations/event-actions";
import { describeEventSpace, EventStatusBadge } from "@/components/reservations/event-status-badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getEvent } from "@/modules/reservations/services/event-service";
import { actorHolds, readLocationClock } from "@/modules/restaurant/services/access";
import { compareDecimals } from "@/shared/decimal/decimal";
import { NotFoundError } from "@/shared/errors/app-error";

/** Phase 36 (policy 7): one event, its status moves, and seating it once confirmed. */
export default async function EventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { actor } = await requirePageActor("events.view");
  const parsed = z.uuid().safeParse((await params).eventId);

  if (!parsed.success) {
    notFound();
  }

  const database = getDatabase();
  const event = await getEvent(database, actor, parsed.data).catch((error) => {
    if (error instanceof NotFoundError) {
      notFound();
    }

    throw error;
  });
  const { timeZone } = await readLocationClock(database, actor.locationId, new Date());
  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));
  const open = event.status !== "COMPLETED" && event.status !== "CANCELLED";
  const canManage = actorHolds(actor, "events.manage");
  const canSeat = actorHolds(actor, "restaurant.seat") && event.partyStatus === "EXPECTED";
  const short =
    event.minimumSpend !== null && compareDecimals(event.spend.subtotal, event.minimumSpend) < 0 ? `below the ${event.minimumSpend} minimum` : null;

  return (
    <>
      <PageHeader
        title={`${event.eventNumber} ${event.name}`}
        breadcrumbs={[{ label: "Events", href: "/events" }, { label: event.eventNumber }]}
        actions={
          <>
            <ButtonLink href={`/events/${event.id}/sheet`} variant="secondary">
              Event sheet
            </ButtonLink>
            {canManage && open && (
              <ButtonLink href={`/events/${event.id}/edit`} variant="secondary">
                Edit
              </ButtonLink>
            )}
          </>
        }
      />
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <EventStatusBadge status={event.status} />
          <span className="text-neutral-700">
            {event.localDate}, {time(event.startsAt)} to {time(event.endsAt)} · held {time(event.blockStartsAt)} to {time(event.blockEndsAt)}
          </span>
        </div>
        <EventActions eventId={event.id} status={event.status} version={event.version} canManage={canManage} canSeat={canSeat} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="grid gap-1">
            <h2 className="font-semibold">Party</h2>
            <p>
              {event.guestName}, {event.partySize} guests
            </p>
            {event.contact && (
              <p className="text-sm text-neutral-700">{[event.contact.phone, event.contact.email].filter(Boolean).join(" · ") || "No contact details"}</p>
            )}
            {event.allergies.length > 0 && (
              <p className="text-sm font-medium text-danger-800">
                Allergies: {event.allergies.map((allergy) => `${allergy.name} (${allergy.severity.toLowerCase()})`).join(", ")}
              </p>
            )}
          </Card>
          <Card className="grid gap-1">
            <h2 className="font-semibold">Space</h2>
            <p>{describeEventSpace(event)}</p>
            <p className="text-sm text-neutral-700">
              Setup {event.setupMinutes} minutes, teardown {event.teardownMinutes} minutes
            </p>
          </Card>
          <Card className="grid gap-1">
            <h2 className="font-semibold">Menu</h2>
            <p>{event.menuItem ? event.menuItem.name : "No set menu"}</p>
            {event.menuNotes && <p className="whitespace-pre-wrap text-sm">{event.menuNotes}</p>}
          </Card>
          <Card className="grid gap-1">
            <h2 className="font-semibold">Money (a record only)</h2>
            <p className="text-sm">
              Checks so far: {event.spend.subtotal} before tax ({event.spend.checks} {event.spend.checks === 1 ? "check" : "checks"})
              {event.minimumSpend !== null && `, minimum ${event.minimumSpend}`}
              {short && ` (${short})`}
            </p>
            <p className="text-sm">
              Deposit: {event.depositReceived ? `${event.depositReceived} received ${event.depositReceivedOn}` : "none received"}
              {event.depositAgreed ? `, ${event.depositAgreed} agreed` : ""}
            </p>
          </Card>
        </div>
        {event.notes && (
          <Card>
            <h2 className="font-semibold">Notes</h2>
            <p className="whitespace-pre-wrap text-sm">{event.notes}</p>
          </Card>
        )}
        {event.cancelReason && <p className="text-sm text-neutral-700">Cancelled: {event.cancelReason}</p>}
      </div>
    </>
  );
}
