import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeRequirement } from "@/modules/scheduling/services/config-service";
import { requirementParamsSchema } from "@/modules/scheduling/validators/scheduling-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

export const DELETE = apiRoute<{ templateId: string; requirementId: string }>(
  { module: "scheduling", operation: "remove-requirement" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const p = parseWith(requirementParamsSchema, params);
    const db = getDatabase();

    await removeRequirement(db, actor, p.templateId, p.requirementId);

    return {};
  },
);
