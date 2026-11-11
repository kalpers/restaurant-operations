import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { tipDateQuerySchema } from "@/modules/settlements/validators/tip-validators";
import { apiRoute, parseWith } from "@/shared/http/api-route";
import { previewTipDistribution } from "@/workflows/finalize-tip-distribution/finalize-tip-distribution";

/** How a business date's tips would be split now. Writes nothing. */
export const GET = apiRoute({ module: "settlements", operation: "preview-tips" }, async ({ request }) => {
  const actor = await requireApiActor();
  const query = parseWith(tipDateQuerySchema, Object.fromEntries(new URL(request.url).searchParams));

  return { body: await previewTipDistribution(getDatabase(), actor, query.date) };
});
