import { notFound } from "next/navigation";
import { z } from "zod";

import { EventForm } from "@/components/reservations/event-form";
import { loadEventFormData } from "../../event-form-data";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getEvent } from "@/modules/reservations/services/event-service";
import { readLocationClock } from "@/modules/restaurant/services/access";
import { NotFoundError } from "@/shared/errors/app-error";

/** Phase 36 (policy 7): change an open event. */
export default async function EditEventPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { actor } = await requirePageActor("events.manage");
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
  const [clock, data] = await Promise.all([readLocationClock(database, actor.locationId, new Date()), loadEventFormData(database, actor)]);

  return (
    <>
      <PageHeader
        title={`Edit ${event.eventNumber}`}
        breadcrumbs={[
          { label: "Events", href: "/events" },
          { label: event.eventNumber, href: `/events/${event.id}` },
          { label: "Edit" },
        ]}
      />
      <EventForm event={event} tables={data.tables} menuItems={data.menuItems} today={clock.localDate} />
    </>
  );
}
