import { HostTabs } from "@/components/reservations/host-tabs";
import { FloorBoard, type FloorAbilities } from "@/components/restaurant/floor-board";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { listTableHoldIndicators } from "@/modules/reservations/services/hold-service";
import { actorHolds, readLocationClock } from "@/modules/restaurant/services/access";
import {
  getFloorStatus,
  listServerCandidates,
} from "@/modules/restaurant/services/floor-service";
import type { ServerCandidate } from "@/modules/restaurant/services/server-eligibility-service";

export default async function FloorPage() {
  const { location, actor } = await requirePageActor("restaurant.view");
  const database = getDatabase();
  const tables = await getFloorStatus(database, actor);
  const holds = await listTableHoldIndicators(database, actor);
  const clock = await readLocationClock(database, actor.locationId, new Date());
  const abilities: FloorAbilities = {
    seat: actorHolds(actor, "restaurant.seat"),
    move: actorHolds(actor, "restaurant.move"),
    complete: actorHolds(actor, "restaurant.complete-session"),
    cancel: actorHolds(actor, "restaurant.cancel-session"),
    clean: actorHolds(actor, "restaurant.clean-table"),
    condition: actorHolds(actor, "restaurant.condition.manage"),
    assignServer: actorHolds(actor, "restaurant.server.assign"),
    capacityOverride: actorHolds(actor, "restaurant.capacity.override"),
    scheduleOverride: actorHolds(actor, "restaurant.schedule.override"),
    holdOverride: actorHolds(actor, "reservations.override-hold"),
  };
  const candidates: Record<string, ServerCandidate[]> = {};

  if (abilities.assignServer) {
    for (const areaId of new Set(tables.map((table) => table.area.id))) {
      candidates[areaId] = await listServerCandidates(database, actor, { areaId });
    }
  }

  return (
    <>
      <h1 className="mb-1 text-2xl font-semibold">Floor</h1>
      <p className="mb-4 text-neutral-600">{location.locationName}</p>
      <HostTabs
        active="floor"
        abilities={{
          floor: true,
          reservations: actorHolds(actor, "reservations.view"),
          waitlist: actorHolds(actor, "waitlist.view"),
        }}
      />
      <FloorBoard
        tables={tables}
        holds={holds}
        timeZone={clock.timeZone}
        abilities={abilities}
        candidates={candidates}
        now={new Date()}
      />
    </>
  );
}
