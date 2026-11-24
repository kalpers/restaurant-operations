import Link from "next/link";

import type { EventView } from "@/modules/reservations/services/event-service";

import { describeEventSpace, EventStatusBadge } from "./event-status-badge";

/**
 * Phase 36 (policy 7): the events holding space over the dates the reservation book shows, so
 * a host sees them where they plan. Inquiries hold nothing and aren't listed.
 */
export function EventsAhead({ events, timeZone }: { events: EventView[]; timeZone: string }) {
  const held = events.filter((event) => event.status === "TENTATIVE" || event.status === "CONFIRMED");

  if (held.length === 0) {
    return null;
  }

  const time = (iso: string) => new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso));

  return (
    <section aria-labelledby="events-ahead-heading" className="mb-4 rounded-lg border border-purple-200 bg-purple-50 p-3">
      <h2 id="events-ahead-heading" className="mb-2 font-semibold text-purple-900">
        Events holding space
      </h2>
      <ul className="grid gap-1 text-sm">
        {held.map((event) => (
          <li key={event.id} className="flex flex-wrap items-center gap-2">
            <Link href={`/events/${event.id}`} className="font-medium underline">
              {event.eventNumber} {event.name}
            </Link>
            <span>
              {event.localDate}, held {time(event.blockStartsAt)}–{time(event.blockEndsAt)} · {describeEventSpace(event)}
            </span>
            <EventStatusBadge status={event.status} />
          </li>
        ))}
      </ul>
    </section>
  );
}
