import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { recordCountLine } from "@/modules/inventory/services/count-service";
import { countLineParamsSchema, recordCountLineSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ countId: string; lineId: string }>(
  { module: "inventory", operation: "record-count-line" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(countLineParamsSchema, params);
    const body = await parseJsonBody(request, recordCountLineSchema);

    return { body: await recordCountLine(db, actor, p.countId, p.lineId, body) };
  },
);
