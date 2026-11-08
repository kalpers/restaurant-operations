import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateStation } from "@/modules/menu/services/prep-station-service";
import { stationIdParamsSchema, updateStationSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ stationId: string }>(
  { module: "menu", operation: "update-station" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(stationIdParamsSchema, params);
    const body = await parseJsonBody(request, updateStationSchema);

    return { body: await updateStation(db, actor, p.stationId, body) };
  },
);
