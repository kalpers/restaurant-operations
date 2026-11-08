import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { addModifierEffect, listModifierEffects } from "@/modules/menu/services/modifier-effect-service";
import { addEffectSchema, modifierIdParamsSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const GET = apiRoute<{ modifierId: string }>(
  { module: "menu", operation: "list-effects" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(modifierIdParamsSchema, params);

    return { body: await listModifierEffects(db, actor, p.modifierId) };
  },
);

export const POST = apiRoute<{ modifierId: string }>(
  { module: "menu", operation: "add-effect" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(modifierIdParamsSchema, params);
    const body = await parseJsonBody(request, addEffectSchema);

    return { body: await addModifierEffect(db, actor, p.modifierId, body), status: 201 };
  },
);
