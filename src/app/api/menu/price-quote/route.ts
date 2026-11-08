import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { priceProspectiveItem } from "@/modules/menu/services/selection-service";
import { validateSelectionSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const POST = apiRoute(
  { module: "menu", operation: "price-quote" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const body = await parseJsonBody(request, validateSelectionSchema);

    return { body: await priceProspectiveItem(db, actor, body) };
  },
);
