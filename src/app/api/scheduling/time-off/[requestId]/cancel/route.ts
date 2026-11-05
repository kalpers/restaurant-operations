import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelTimeOff } from "@/modules/scheduling/services/time-off-service";
import { expectedVersionSchema, requestIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ requestId: string }>(
  { module: "scheduling", operation: "cancel-time-off" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(requestIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);
    const db = getDatabase();

    return { body: await cancelTimeOff(db, actor, p.requestId, body) };
  },
);
