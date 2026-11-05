import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { assignEmployee } from "@/modules/scheduling/services/schedule-service";
import { assignEmployeeSchema, shiftIdParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ shiftId: string }>(
  { module: "scheduling", operation: "assign-employee" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(shiftIdParamsSchema, params);
    const body = await parseJsonBody(request, assignEmployeeSchema);
    const db = getDatabase();

    return { body: await assignEmployee(db, actor, p.shiftId, body), status: 201 };
  },
);
