import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { approveTimeOff } from "@/modules/scheduling/services/time-off-service";
import { requestIdParamsSchema, timeOffReviewSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ requestId: string }>(
  { module: "scheduling", operation: "approve-time-off" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(requestIdParamsSchema, params);
    const body = await parseJsonBody(request, timeOffReviewSchema);
    const db = getDatabase();

    return { body: await approveTimeOff(db, actor, p.requestId, body) };
  },
);
