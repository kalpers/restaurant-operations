import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { endSectionAssignment } from "@/modules/restaurant/services/section-service";
import { assignmentIdParamsSchema, expectedVersionSchema } from "@/modules/restaurant/validators/restaurant-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ assignmentId: string }>(
  { module: "restaurant", operation: "end-section-assignment" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(assignmentIdParamsSchema, params);
    const body = await parseJsonBody(request, expectedVersionSchema);

    return { body: await endSectionAssignment(getDatabase(), actor, p.assignmentId, body) };
  },
);
