import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { declareTips, listTipDeclarations } from "@/modules/settlements/services/tip-declaration-service";
import { declareTipsSchema, tipRangeQuerySchema } from "@/modules/settlements/validators/tip-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Cash tip declarations in a range: everyone's with `tips.manage`, otherwise the caller's own. */
export const GET = apiRoute({ module: "settlements", operation: "list-tip-declarations" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(tipRangeQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  return { body: await listTipDeclarations(getDatabase(), actor, query) };
});

/** Declare (or correct) cash tips kept on a business date (Phase 20, policy 20). */
export const POST = apiRoute({ module: "settlements", operation: "declare-tips" }, async ({ request }) => {
  const actor = await requireApiActor();
  const body = await parseJsonBody(request, declareTipsSchema);

  return { body: await declareTips(getDatabase(), actor, body) };
});
