import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { createShift } from "@/modules/scheduling/services/schedule-service";
import { createShiftSchema, periodIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ periodId: string }>(
  { module: "scheduling", operation: "create-shift" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(periodIdParamsSchema, params);
    const body = await parseJsonBody(request, createShiftSchema);
    const db = getDatabase();

    return { body: await createShift(db, actor, p.periodId, body), status: 201 };
  },
);
