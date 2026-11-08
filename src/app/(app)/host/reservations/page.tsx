import { HostTabs } from "@/components/reservations/host-tabs";
import {
  ReservationsBoard,
  type ReservationAbilities,
} from "@/components/reservations/reservations-board";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { readReservationContext } from "@/modules/reservations/repositories/reservation-repository";
import { listHostTables } from "@/modules/reservations/services/recommendation-service";
import { listReservations } from "@/modules/reservations/services/reservation-service";
import {
  actorHolds,
  readLocationClock,
} from "@/modules/restaurant/services/access";
import { addDays } from "@/shared/time/zoned-time";

export default async function ReservationsPage() {
  const { location, actor } = await requirePageActor("reservations.view");
  const database = getDatabase();
  const now = new Date();
  const clock = await readLocationClock(database, actor.locationId, now);
  const context = await readReservationContext(database, actor.locationId);
  const reservations = await listReservations(database, actor, {
    fromBusinessDate: clock.businessDate,
    toBusinessDate: addDays(clock.businessDate, 14),
  });
  const tables = await listHostTables(database, actor);
  const abilities: ReservationAbilities = {
    manage: actorHolds(actor, "reservations.manage"),
    seat: actorHolds(actor, "restaurant.seat"),
    overrideHold: actorHolds(actor, "reservations.override-hold"),
    capacityOverride: actorHolds(actor, "restaurant.capacity.override"),
  };

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Reservations</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <HostTabs
        active="reservations"
        abilities={{
          floor: actorHolds(actor, "restaurant.view"),
          reservations: true,
          waitlist: actorHolds(actor, "waitlist.view"),
        }}
      />
      <ReservationsBoard
        reservations={reservations}
        tables={tables}
        timeZone={clock.timeZone}
        nowIso={now.toISOString()}
        businessDate={clock.businessDate}
        defaultDate={clock.localDate}
        defaultDurationMinutes={context.defaultReservationDurationMinutes}
        abilities={abilities}
      />
    </>
  );
}
