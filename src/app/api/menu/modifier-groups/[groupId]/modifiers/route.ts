import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { setGroupModifier } from "@/modules/menu/services/modifier-service";
import { groupIdParamsSchema, setGroupModifierSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PUT = apiRoute<{ groupId: string }>(
  { module: "menu", operation: "set-group-modifier" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(groupIdParamsSchema, params);
    const body = await parseJsonBody(request, setGroupModifierSchema);

    return { body: await setGroupModifier(db, actor, p.groupId, body) };
  },
);
