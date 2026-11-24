import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateTemperaturePoint } from "@/modules/restaurant/services/temperature-service";
import {
  temperaturePointIdParamsSchema,
  updateTemperaturePointSchema,
} from "@/modules/restaurant/validators/temperature-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 36 (policy 6): edits a check point; readings keep the range they were taken against. */
export const PATCH = apiRoute<{ pointId: string }>(
  { module: "restaurant", operation: "update-temperature-point" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(temperaturePointIdParamsSchema, params);
    const body = await parseJsonBody(request, updateTemperaturePointSchema);

    return { body: await updateTemperaturePoint(getDatabase(), actor, p.pointId, body) };
  },
);
