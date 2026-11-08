import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { changePrice, listPriceHistory } from "@/modules/menu/services/pricing-service";
import { changePriceSchema, itemIdParamsSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "list-prices" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);

    return { body: await listPriceHistory(db, actor, p.itemId) };
  },
);

export const POST = apiRoute<{ itemId: string }>(
  { module: "menu", operation: "change-price" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, changePriceSchema);

    return { body: await changePrice(db, actor, p.itemId, body), status: 201 };
  },
);
