import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { getMyTipShares } from "@/modules/settlements/services/tip-service";
import { tipRangeQuerySchema } from "@/modules/settlements/validators/tip-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";

/** The caller's own shares in finalized distributions. */
export const GET = apiRoute({ module: "settlements", operation: "get-my-tips" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(tipRangeQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  return { body: await getMyTipShares(getDatabase(), actor, query) };
});
