import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createPeriod, listPeriods } from "@/modules/scheduling/services/schedule-service";
import { createPeriodSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

export const GET = apiRoute(
  { module: "scheduling", operation: "list-periods" },
  async () => {
    const actor = await requireApiActor();
    const db = getDatabase();

    return { body: { periods: await listPeriods(db, actor) } };
  },
);

export const POST = apiRoute(
  { module: "scheduling", operation: "create-period" },
  async ({ request }) => {
    const actor = await requireApiActor();
    const body = await parseJsonBody(request, createPeriodSchema);
    const db = getDatabase();

    return { body: await createPeriod(db, actor, body), status: 201 };
  },
);
