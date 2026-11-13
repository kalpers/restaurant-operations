import { getDatabase } from "@/db";
import { requireApiActor } from "@/modules/auth/guards";
import { receiveTransfer } from "@/modules/inventory/services/transfer-service";
import { transferIdParamsSchema, transferReceiveSchema } from "@/modules/inventory/validators/inventory-validators";
import { apiRoute, parseJsonBody, parseWith } from "@/shared/http/api-route";

/** Phase 23 (policy 12): receives a SENT transfer at the current location. */
export const POST = apiRoute<{ transferId: string }>(
  { module: "inventory", operation: "receive-transfer" },
  async ({ request, params }) => {
    const actor = await requireApiActor();
    const { transferId } = parseWith(transferIdParamsSchema, params);
    const body = await parseJsonBody(request, transferReceiveSchema);

    return { body: await receiveTransfer(getDatabase(), actor, transferId, body) };
  },
);
