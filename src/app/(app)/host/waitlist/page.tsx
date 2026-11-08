import { HostTabs } from "@/components/reservations/host-tabs";
import {
  WaitlistBoard,
  type WaitlistAbilities,
} from "@/components/reservations/waitlist-board";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import type { Recommendation } from "@/modules/reservations/rules/table-recommendation";
import {
  listHostTables,
  recommendTablesFor,
} from "@/modules/reservations/services/recommendation-service";
import { listWaitlist } from "@/modules/reservations/services/waitlist-service";
import {
  actorHolds,
  readLocationClock,
} from "@/modules/restaurant/services/access";

export default async function WaitlistPage() {
  const { location, actor } = await requirePageActor("waitlist.view");
  const database = getDatabase();
  const now = new Date();
  const clock = await readLocationClock(database, actor.locationId, now);
  const entries = await listWaitlist(database, actor);
  const tables = await listHostTables(database, actor);
  const areas = [
    ...new Map(tables.map((table) => [table.areaId, table.areaName])).entries(),
  ].map(([id, name]) => ({ id, name }));
  const recommendations: Record<string, Recommendation[]> = {};

  // One suggestion per party. A suggestion reserves nothing.
  for (const entry of entries) {
    recommendations[entry.id] = (
      await recommendTablesFor(database, actor, {
        partySize: entry.partySize,
        preferredAreaId: entry.preferredAreaId,
        guestPartyId: entry.guestPartyId,
      })
    ).recommendations;
  }

  const abilities: WaitlistAbilities = {
    manage: actorHolds(actor, "waitlist.manage"),
    notify: actorHolds(actor, "waitlist.notify"),
    seat: actorHolds(actor, "waitlist.seat") && actorHolds(actor, "restaurant.seat"),
    overrideHold: actorHolds(actor, "reservations.override-hold"),
    capacityOverride: actorHolds(actor, "restaurant.capacity.override"),
  };

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Waitlist</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <HostTabs
        active="waitlist"
        abilities={{
          floor: actorHolds(actor, "restaurant.view"),
          reservations: actorHolds(actor, "reservations.view"),
          waitlist: true,
        }}
      />
      <WaitlistBoard
        entries={entries}
        tables={tables}
        areas={areas}
        recommendations={recommendations}
        timeZone={clock.timeZone}
        nowIso={now.toISOString()}
        abilities={abilities}
      />
    </>
  );
}
