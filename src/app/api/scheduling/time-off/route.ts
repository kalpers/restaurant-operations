import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { listTimeOffForReview, requestTimeOffForEmployee } from "@/modules/scheduling/services/time-off-service";
import { managerTimeOffSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "list-time-off" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: { requests: await listTimeOffForReview(db, actor) } };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "request-time-off" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, managerTimeOffSchema);
    const db = getDatabase();

    return { body: await requestTimeOffForEmployee(db, actor, body.employeeId, body), status: 201 };
  },
);
