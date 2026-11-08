import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { updateModifier } from "@/modules/menu/services/modifier-service";
import { modifierIdParamsSchema, updateModifierSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ modifierId: string }>(
  { module: "menu", operation: "update-modifier" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(modifierIdParamsSchema, params);
    const body = await parseJsonBody(request, updateModifierSchema);

    return { body: await updateModifier(db, actor, p.modifierId, body) };
  },
);
