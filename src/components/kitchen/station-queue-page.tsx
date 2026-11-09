import { getDatabase } from "@/db";
import { requirePageActor } from "@/modules/auth/guards";
import { getStationQueue } from "@/modules/kitchen/queries/kitchen-queries";
import type { StationType } from "@/modules/kitchen/types";
import { queueQuerySchema } from "@/modules/kitchen/validators/kitchen-validators";
import { listWorkStations } from "@/modules/menu/queries/station-facts";

import { KdsBoard } from "./kds-board";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** Server side of the Kitchen and Bar queues: authorizes the station type, then reads. */
export async function StationQueuePage({
  stationType,
  title,
  path,
  searchParams,
}: {
  stationType: StationType;
  title: string;
  path: string;
  searchParams: SearchParams;
}) {
  const { actor } = await requirePageActor(stationType === "BAR" ? "bar.view" : "kitchen.view");
  const raw = await searchParams;
  const single = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  // Unknown filter values are dropped rather than refused, so a stale link still opens.
  const parsed = queueQuerySchema.safeParse({
    stationType,
    stationId: single(raw.stationId) || undefined,
    status: single(raw.status) || undefined,
    orderType: single(raw.orderType) || undefined,
  });
  const filter = parsed.success ? parsed.data : { stationType };
  const database = getDatabase();
  const [queue, stations] = await Promise.all([
    getStationQueue(database, actor, filter),
    listWorkStations(database, actor.locationId, stationType),
  ]);

  return (
    <KdsBoard
      title={title}
      path={path}
      active={queue.active}
      recentlyCompleted={queue.recentlyCompleted}
      serverTime={queue.serverTime}
      stations={stations}
      filters={{ stationId: filter.stationId, status: filter.status, orderType: filter.orderType }}
    />
  );
}
