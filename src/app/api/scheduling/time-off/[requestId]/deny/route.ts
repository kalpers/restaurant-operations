import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { denyTimeOff } from "@/modules/scheduling/services/time-off-service";
import { requestIdParamsSchema, timeOffReviewSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ requestId: string }>(
  { module: "scheduling", operation: "deny-time-off" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(requestIdParamsSchema, params);
    const body = await parseJsonBody(request, timeOffReviewSchema);
    const db = getDatabase();

    return { body: await denyTimeOff(db, actor, p.requestId, body) };
  },
);
