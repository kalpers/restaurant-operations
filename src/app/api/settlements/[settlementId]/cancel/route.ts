import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { cancelSettlement } from "@/modules/settlements/services/settlement-service";
import {
  cancelSettlementSchema,
  settlementIdParamsSchema,
} from "@/modules/settlements/validators/settlement-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Cancels an OPEN settlement with no recorded tender, unlocking the order's check. */
export const POST = apiRoute<{ settlementId: string }>(
  { module: "settlements", operation: "cancel-settlement" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const p = parseWith(settlementIdParamsSchema, params);
    const body = await parseJsonBody(request, cancelSettlementSchema);

    return { body: await cancelSettlement(getDatabase(), actor, p.settlementId, body) };
  },
);
