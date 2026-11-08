import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listUnits } from "@/modules/recipes/services/unit-service";
import { apiRoute } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "recipes", operation: "list-units" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: await listUnits(db, actor) };
  },
);
