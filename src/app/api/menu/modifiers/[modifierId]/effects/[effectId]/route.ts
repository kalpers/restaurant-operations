import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { removeModifierEffect, updateModifierEffect } from "@/modules/menu/services/modifier-effect-service";
import { effectParamsSchema, updateEffectSchema } from "@/modules/menu/validators/menu-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const PATCH = apiRoute<{ modifierId: string; effectId: string }>(
  { module: "menu", operation: "update-effect" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(effectParamsSchema, params);
    const body = await parseJsonBody(request, updateEffectSchema);

    return { body: await updateModifierEffect(db, actor, p.modifierId, p.effectId, body) };
  },
);

export const DELETE = apiRoute<{ modifierId: string; effectId: string }>(
  { module: "menu", operation: "remove-effect" },
  async ({ params }) => {
    const actor = await requireApiActor();
    const db = getDatabase();
    const p = parseWith(effectParamsSchema, params);
    await removeModifierEffect(db, actor, p.modifierId, p.effectId);

    return {};
  },
);
