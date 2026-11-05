import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listOwnTimeOff, requestOwnTimeOff } from "@/modules/scheduling/services/time-off-service";
import { timeOffRequestSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "list-own-time-off" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: { requests: await listOwnTimeOff(db, actor) } };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "request-own-time-off" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, timeOffRequestSchema);
    const db = getDatabase();

    return { body: await requestOwnTimeOff(db, actor, body), status: 201 };
  },
);
