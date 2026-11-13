import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateRatio } from "@/modules/scheduling/services/forecast-service";
import {
  ratioIdParamsSchema,
  updateRatioSchema,
} from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ ratioId: string }>(
  { module: "scheduling", operation: "update-staffing-ratio" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(ratioIdParamsSchema, params);
    const body = await parseJsonBody(request, updateRatioSchema);
    const db = getDatabase();

    return { body: await updateRatio(db, actor, p.ratioId, body) };
  },
);
