import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createTemperaturePoint, listTemperaturePoints } from "@/modules/restaurant/services/temperature-service";
import { createTemperaturePointSchema } from "@/modules/restaurant/validators/temperature-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** Phase 36 (policy 6): the location's temperature check points. */
export const GET = apiRoute({ module: "restaurant", operation: "list-temperature-points" }, async () => {
  const actor = await requireApiActor();

  return { body: { points: await listTemperaturePoints(getDatabase(), actor) } };
});

export const POST = apiRoute({ module: "restaurant", operation: "create-temperature-point" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, createTemperaturePointSchema);

  return { body: await createTemperaturePoint(getDatabase(), actor, body), status: 201 };
});
