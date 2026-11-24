import { notFound } from "next/navigation";
import { z } from "zod";

import { describeEventSpace } from "@/components/reservations/event-status-badge";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getEvent } from "@/modules/reservations/services/event-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { NotFoundError } from "@/shared/errors/app-error";

/**
 * Phase 36 (policy 7): the printable event sheet for the team: times, space, guests,
 * allergies, menu and notes. Contact details only for `guests.contact.view` holders.
 */
export default async function EventSheetPage({ params }: { params: Promise<{ eventId: string }> }) {
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
  const rows: [string, string][] = [
    ["Date", event.localDate],
    ["Guests arrive", time(event.startsAt)],
    ["Ends", time(event.endsAt)],
    ["Setup from", time(event.blockStartsAt)],
    ["Space clear by", time(event.blockEndsAt)],
    ["Space", describeEventSpace(event)],
    ["Guests", String(event.partySize)],
    ["Host", event.guestName],
    ...(event.contact ? ([["Contact", [event.contact.phone, event.contact.email].filter(Boolean).join(" · ") || "None"]] as [string, string][]) : []),
    ["Allergies", event.allergies.length > 0 ? event.allergies.map((allergy) => `${allergy.name} (${allergy.severity.toLowerCase()})`).join(", ") : "None recorded"],
    ["Set menu", event.menuItem?.name ?? "None"],
    ["Minimum spend", event.minimumSpend ?? "None"],
    ["Deposit received", event.depositReceived ? `${event.depositReceived} (enter as an Other tender, "Event deposit ${event.eventNumber}")` : "None"],
  ];

  return (
    <>
      <PageHeader
        title={`Event sheet: ${event.eventNumber} ${event.name}`}
        breadcrumbs={[
          { label: "Events", href: "/events" },
          { label: event.eventNumber, href: `/events/${event.id}` },
          { label: "Event sheet" },
        ]}
      />
      <dl className="grid max-w-3xl gap-x-6 gap-y-2 sm:grid-cols-[12rem_1fr]">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="font-semibold">{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {event.menuNotes && (
        <section className="mt-6 max-w-3xl">
          <h2 className="font-semibold">Menu notes</h2>
          <p className="whitespace-pre-wrap">{event.menuNotes}</p>
        </section>
      )}
      {event.notes && (
        <section className="mt-6 max-w-3xl">
          <h2 className="font-semibold">Notes</h2>
          <p className="whitespace-pre-wrap">{event.notes}</p>
        </section>
      )}
    </>
  );
}
