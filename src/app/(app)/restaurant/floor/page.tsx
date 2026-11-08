import { FloorBoard, type FloorAbilities } from "@/components/restaurant/floor-board";
import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { actorHolds } from "@/modules/restaurant/services/access";
import {
  getFloorStatus,
  listServerCandidates,
} from "@/modules/restaurant/services/floor-service";
import type { ServerCandidate } from "@/modules/restaurant/services/server-eligibility-service";

export default async function FloorPage() {
  const { location, actor } = await requirePageActor("restaurant.view");
  const database = getDatabase();
  const tables = await getFloorStatus(database, actor);
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
      <FloorBoard
        tables={tables}
        abilities={abilities}
        candidates={candidates}
        now={new Date()}
      />
    </>
  );
}
