import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getFloorStatus } from "@/modules/restaurant/services/floor-service";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "restaurant", operation: "floor-status" },
  async () => {
    const actor = await requireApiActor();

    return { body: { tables: await getFloorStatus(getDatabase(), actor) } };
  },
);
