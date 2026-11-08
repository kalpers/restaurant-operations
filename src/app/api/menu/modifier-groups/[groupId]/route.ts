import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateGroup } from "@/modules/menu/services/modifier-service";
import { groupIdParamsSchema, updateGroupSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ groupId: string }>(
  { module: "menu", operation: "update-group" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(groupIdParamsSchema, params);
    const body = await parseJsonBody(request, updateGroupSchema);

    return { body: await updateGroup(db, actor, p.groupId, body) };
  },
);
