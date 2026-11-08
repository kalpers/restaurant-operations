import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addConversion } from "@/modules/inventory/services/item-service";
import { addConversionSchema, itemIdParamsSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ itemId: string }>(
  { module: "inventory", operation: "add-conversion" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(itemIdParamsSchema, params);
    const body = await parseJsonBody(request, addConversionSchema);

    return { body: await addConversion(db, actor, p.itemId, body), status: 201 };
  },
);
