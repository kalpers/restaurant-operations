import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { deactivateConversion } from "@/modules/inventory/services/item-service";
import { conversionParamsSchema, versionSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ itemId: string; conversionId: string }>(
  { module: "inventory", operation: "deactivate-conversion" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(conversionParamsSchema, params);
    const body = await parseJsonBody(request, versionSchema);

    return { body: await deactivateConversion(db, actor, p.itemId, p.conversionId, body.expectedVersion) };
  },
);
