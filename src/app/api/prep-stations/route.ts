import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createStation, listStations } from "@/modules/menu/services/prep-station-service";
import { createStationSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "menu", operation: "list-stations" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listStations(db, actor) };
  },
);

export const POST = apiRoute(
  { module: "menu", operation: "create-station" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, createStationSchema);

    return { body: await createStation(db, actor, body), status: 201 };
  },
);
