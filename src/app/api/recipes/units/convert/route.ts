import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { convertUnits } from "@/modules/recipes/services/unit-service";
import { convertUnitsSchema } from "@/modules/recipes/validators/recipe-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "recipes", operation: "convert-units" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, convertUnitsSchema);

    return { body: await convertUnits(db, actor, body).then((quantity) => ({ quantity })) };
  },
);
