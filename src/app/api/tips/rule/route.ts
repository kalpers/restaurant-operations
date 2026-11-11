import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getTipRule, saveTipRule } from "@/modules/settlements/services/tip-service";
import { tipRuleSchema } from "@/modules/settlements/validators/tip-validators";
import { apiRoute, parseJsonBody } from "@/shared/http/api-route";

/** The Location's tip pool: participating positions and their points (Phase 18). */
export const GET = apiRoute({ module: "settlements", operation: "get-tip-rule" }, async () => {
  const actor = await requireApiActor();

  return { body: await getTipRule(getDatabase(), actor) };
});

export const PUT = apiRoute({ module: "settlements", operation: "save-tip-rule" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, tipRuleSchema);

  return { body: await saveTipRule(getDatabase(), actor, body) };
});
