import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { denySwap } from "@/modules/scheduling/services/swap-service";
import { expectedVersionSchema, swapIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ swapId: string }>(
  { module: "scheduling", operation: "deny-swap" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(swapIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    return { body: await denySwap(db, actor, p.swapId, body) };
  },
);
