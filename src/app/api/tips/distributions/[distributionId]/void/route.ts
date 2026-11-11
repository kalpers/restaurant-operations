import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidDistribution } from "@/modules/settlements/services/tip-service";
import { distributionIdParamsSchema, voidTipDistributionSchema } from "@/modules/settlements/validators/tip-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Void a finalized distribution so the date can be redone. The row and its lines stay. */
export const POST = apiRoute<{ distributionId: string }>(
  { module: "settlements", operation: "void-tip-distribution" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(distributionIdParamsSchema, params);
    const body = await parseJsonBody(request, voidTipDistributionSchema);

    return { body: await voidDistribution(getDatabase(), actor, p.distributionId, body) };
  },
);
