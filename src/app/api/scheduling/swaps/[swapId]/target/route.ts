import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setSwapTarget } from "@/modules/scheduling/services/swap-service";
import { swapIdParamsSchema, swapTargetSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ swapId: string }>(
  { module: "scheduling", operation: "set-swap-target" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(swapIdParamsSchema, params);
    const body = await parseJsonBody(request, swapTargetSchema);
    const db = getDatabase();

    return { body: await setSwapTarget(db, actor, p.swapId, body) };
  },
);
