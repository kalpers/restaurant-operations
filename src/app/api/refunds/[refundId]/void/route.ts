import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidRefund } from "@/workflows/void-refund/void-refund";
import { refundIdParamsSchema, voidRefundSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

export const POST = apiRoute<{ refundId: string }>(
  { module: "settlements", operation: "void-refund" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(refundIdParamsSchema, params);
    const body = await parseJsonBody(request, voidRefundSchema);

    return { body: await voidRefund(getDatabase(), actor, p.refundId, body) };
  },
);
