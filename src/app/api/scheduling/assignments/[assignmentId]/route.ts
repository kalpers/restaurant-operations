import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeAssignment } from "@/modules/scheduling/services/schedule-service";
import { assignmentIdParamsSchema, periodVersionSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const DELETE = apiRoute<{ assignmentId: string }>(
  { module: "scheduling", operation: "remove-assignment" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(assignmentIdParamsSchema, params);
    const body = await parseJsonBody(request, periodVersionSchema);
    const db = getDatabase();

    await removeAssignment(db, actor, p.assignmentId, body);

    return {};
  },
);
