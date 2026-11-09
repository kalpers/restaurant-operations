import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getStationQueue } from "@/modules/kitchen/queries/kitchen-queries";
import { queueQuerySchema } from "@/modules/kitchen/validators/kitchen-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute({ module: "kitchen", operation: "station-queue" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(queueQuerySchema, Object.fromEntries(new URL(request.url).searchParams.entries()));

  return { body: await getStationQueue(getDatabase(), actor, query) };
});
