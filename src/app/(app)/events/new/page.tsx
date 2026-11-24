import { EventForm } from "@/components/reservations/event-form";
import { loadEventFormData } from "../event-form-data";
import { PageHeader } from "@/components/ui/page-header";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { readLocationClock } from "@/modules/restaurant/services/access";

/** Phase 36 (policy 7): book an event. */
export default async function NewEventPage() {
  const { actor } = await requirePageActor("events.manage");
  const database = getDatabase();
  const [clock, data] = await Promise.all([readLocationClock(database, actor.locationId, new Date()), loadEventFormData(database, actor)]);

  return (
    <>
      <PageHeader title="Book an event" breadcrumbs={[{ label: "Events", href: "/events" }, { label: "Book an event" }]} />
      <EventForm tables={data.tables} menuItems={data.menuItems} today={clock.localDate} />
    </>
  );
}
