import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { voidTender } from "@/modules/settlements/services/settlement-service";
import { tenderParamsSchema, voidTenderSchema } from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Voids a recorded tender while its settlement is OPEN. Application record only. */
export const POST = apiRoute<{ settlementId: string; tenderId: string }>(
  { module: "settlements", operation: "void-tender" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(tenderParamsSchema, params);
    const body = await parseJsonBody(request, voidTenderSchema);

    return { body: await voidTender(getDatabase(), actor, p.settlementId, p.tenderId, body) };
  },
);
