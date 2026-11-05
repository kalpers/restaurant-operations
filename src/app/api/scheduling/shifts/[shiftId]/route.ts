import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelShift, updateShift } from "@/modules/scheduling/services/schedule-service";
import { shiftIdParamsSchema, shiftVersionsSchema, updateShiftSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ shiftId: string }>(
  { module: "scheduling", operation: "update-shift" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(shiftIdParamsSchema, params);
    const body = await parseJsonBody(request, updateShiftSchema);
    const db = getDatabase();

    return { body: await updateShift(db, actor, p.shiftId, body) };
  },
);

export const DELETE = apiRoute<{ shiftId: string }>(
  { module: "scheduling", operation: "cancel-shift" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(shiftIdParamsSchema, params);
    const body = await parseJsonBody(request, shiftVersionsSchema);
    const db = getDatabase();

    await cancelShift(db, actor, p.shiftId, body);

    return {};
  },
);
